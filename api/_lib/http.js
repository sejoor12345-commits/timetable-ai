// Vercel 서버리스 함수(api/health.js, api/preferences.js, api/summary.js)가 함께 쓰는 부분:
// 입력 검사(timetable_server/server.py와 같은 기준·문구), 접근 코드, IP별 요청 횟수 제한, 응답 모양, 로그.
// 로그에는 주소·상태·오류 코드·걸린 시간·쓴 모델만 남긴다. API 키, 접근 코드, 선호도 글, 이름은 남기지 않는다.

import { createHash, timingSafeEqual } from 'node:crypto';
import { OpenRouterError, chars, hasApiKey, modelList } from './openrouter.js';
import { explainResult, parsePreferences } from './preferences.js';

export const MAX_BODY_BYTES = 20000;
const TEXT_MAX = 2000;
const PEOPLE_MAX = 12;
const NAME_MAX = 20;
const HOLIDAYS_MAX = 20;
const SUMMARY_RULES_MAX = 20;
const LABEL_MAX = 60;
const NOTE_MAX = 80;
const SUMMARY_MAX = 600;

// 요청 횟수 제한 (IP 하나당, 10분 동안). 함수가 켜져 있는 동안만 기억하는 간단한 방식이다
// (Vercel이 함수를 여러 개 띄우거나 새로 띄우면 따로 센다). 돈이 새는 것은 OpenRouter 사용 한도로 한 번 더 막는다.
export const RATE_WINDOW_MS = 10 * 60 * 1000;
export const AI_REQUESTS_PER_WINDOW = 15;   // AI를 부르는 요청 (해석·설명)
export const CODE_FAILS_PER_WINDOW = 10;    // 틀린 접근 코드

export const ACCESS_HEADER = 'x-access-code';

const READY_MESSAGE = 'AI를 쓸 준비가 됐어요.';
const RELOAD_HINT = '새로 고침한 뒤 다시 시도해 주세요.';
export const NO_KEY_MESSAGE =
  'API 키가 없어요. Vercel 프로젝트의 Settings → Environment Variables에 OPENROUTER_API_KEY를 넣은 다음, ' +
  'Deployments 화면에서 Redeploy(다시 배포)를 눌러 주세요.';
export const NO_ACCESS_CODE_MESSAGE =
  '접근 코드가 정해지지 않아 AI를 잠가 두었어요. Vercel 프로젝트의 Settings → Environment Variables에 ' +
  'ACCESS_CODE를 넣은 다음 Redeploy를 눌러 주세요.';
export const NEED_CODE_MESSAGE = 'AI를 쓰려면 접근 코드를 넣어 주세요. (Vercel 환경 변수 ACCESS_CODE에 넣은 값)';
export const WRONG_CODE_MESSAGE = '접근 코드가 맞지 않아요. 다시 확인해서 넣어 주세요.';
const SERVER_ERROR_MESSAGE =
  '서버에서 예상하지 못한 오류가 났어요. 잠시 후 다시 시도해 주세요. 계속되면 Vercel의 Logs 화면을 확인해 주세요.';
const AI_FALLBACK_MESSAGE = 'AI 서버가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
const AI_EMPTY_MESSAGE = 'AI가 빈 답을 보냈어요. 다시 시도해 주세요.';

const AI_STATUS = { ai_rate_limit: 429, ai_timeout: 504, no_key: 503 };
const AI_CODES = new Set(['ai_rate_limit', 'ai_auth', 'ai_model', 'ai_server', 'ai_connect', 'ai_bad_answer', 'ai_empty',
  'ai_timeout', 'no_key']);

export class ApiError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.message = message;
    this.headers = headers;
  }
}

function badRequest(message) {
  return new ApiError(400, 'bad_request', message);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function get(obj, key, fallback) {
  return isPlainObject(obj) && hasOwn(obj, key) ? obj[key] : fallback;
}

function len(text) {
  return chars(text).length;
}

// ---------- 입력 검사 (server.py와 같은 기준·문구) ----------

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1) return null;
  const day = new Date(0);
  day.setUTCFullYear(y, m - 1, d);
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
  return day;
}

function weekday(day) {
  return (day.getUTCDay() + 6) % 7;
}

function isCount(value, low = 0, high = 100) {
  return typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
}

function hasControlChar(text) {
  return /[\x00-\x1f\x7f]/.test(text);
}

export function checkPeriod(value) {
  if (!isPlainObject(value)) throw badRequest(`기간 정보가 없어요. ${RELOAD_HINT}`);
  const start = parseDate(get(value, 'start'));
  if (start === null || weekday(start) !== 0) {
    throw badRequest('기간 시작일이 올바르지 않아요. 설정 탭에서 시작일(월요일)을 확인해 주세요.');
  }
  const weeks = get(value, 'weeks');
  if (weeks !== 4 && weeks !== 5) throw badRequest('기간은 4주 또는 5주여야 해요. 설정 탭에서 기간을 확인해 주세요.');
  return { start, startText: value.start, weeks };
}

function checkName(name) {
  if (typeof name !== 'string' || !name.trim()) throw badRequest('이름이 빈 사람이 있어요. 설정 탭에서 이름을 넣어 주세요.');
  if (len(name) > NAME_MAX) {
    throw badRequest(`이름은 ${NAME_MAX}자까지 쓸 수 있어요 (${chars(name).slice(0, NAME_MAX).join('')}…). 설정 탭에서 이름을 줄여 주세요.`);
  }
  if (hasControlChar(name)) throw badRequest('이름에 쓸 수 없는 글자(줄바꿈·탭 등)가 있어요. 설정 탭에서 이름을 고쳐 주세요.');
  return name;
}

function checkPeople(value) {
  if (!Array.isArray(value) || !value.length) throw badRequest('인원이 없어요. 설정 탭에서 인원을 먼저 추가해 주세요.');
  if (value.length > PEOPLE_MAX) throw badRequest(`인원은 ${PEOPLE_MAX}명까지 보낼 수 있어요. (지금 ${value.length}명)`);
  const names = [];
  for (const name of value) {
    checkName(name);
    if (names.includes(name)) {
      throw badRequest(`이름이 같은 사람이 있어요 (${name}). 설정 탭에서 이름을 서로 다르게 바꿔 주세요.`);
    }
    names.push(name);
  }
  return names;
}

function checkHolidays(value, start, weeks) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw badRequest(`휴일 정보가 올바르지 않아요. ${RELOAD_HINT}`);
  const end = start.getTime() + (weeks * 7 - 1) * 86400000;
  const days = new Set();
  for (const item of value) {
    const day = parseDate(item);
    if (day === null) throw badRequest(`휴일 날짜가 올바르지 않아요. ${RELOAD_HINT}`);
    if (day.getTime() >= start.getTime() && day.getTime() <= end && weekday(day) < 5) days.add(item);
  }
  if (days.size > HOLIDAYS_MAX) {
    throw badRequest(`휴일은 기간 안에서 ${HOLIDAYS_MAX}개까지 보낼 수 있어요. 설정 탭에서 휴일을 확인해 주세요.`);
  }
  return Array.from(days).sort();
}

// POST /api/preferences 본문 검사 (F5)
export function checkPreferencesRequest(body) {
  const raw = get(body, 'text');
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw badRequest('선호도 문장을 먼저 써 주세요.');
  if (len(text) > TEXT_MAX) throw badRequest(`선호도 글은 ${TEXT_MAX}자까지 쓸 수 있어요. (지금 ${len(text)}자)`);
  const people = checkPeople(get(body, 'people'));
  const { start, startText, weeks } = checkPeriod(get(body, 'period'));
  const holidays = checkHolidays(get(body, 'holidays'), start, weeks);
  return { text, people, start: startText, weeks, holidays };
}

// POST /api/summary 본문 검사 (F6). 아는 필드만 남긴 깨끗한 사본
export function checkSummaryRequest(body) {
  const { startText, weeks } = checkPeriod(get(body, 'period'));
  const people = get(body, 'people');
  if (people === undefined || people === null || (Array.isArray(people) && !people.length)) {
    throw badRequest('설명할 선호도 규칙이 없어요.');
  }
  if (!Array.isArray(people)) throw badRequest(`선호도 결과 모양이 올바르지 않아요. ${RELOAD_HINT}`);
  if (people.length > PEOPLE_MAX) throw badRequest(`인원은 ${PEOPLE_MAX}명까지 보낼 수 있어요. (지금 ${people.length}명)`);

  const cleanPeople = [];
  let ruleCount = 0;
  for (const person of people) {
    if (!isPlainObject(person)) throw badRequest(`선호도 결과 모양이 올바르지 않아요. ${RELOAD_HINT}`);
    const name = checkName(get(person, 'name'));
    const kept = get(person, 'kept');
    const total = get(person, 'total');
    const rules = get(person, 'rules');
    if (!isCount(kept) || !isCount(total) || !Array.isArray(rules)) {
      throw badRequest(`선호도 결과의 숫자가 올바르지 않아요 (${name}). ${RELOAD_HINT}`);
    }
    if (rules.length > SUMMARY_RULES_MAX) throw badRequest(`한 사람의 규칙은 ${SUMMARY_RULES_MAX}개까지 보낼 수 있어요 (${name}).`);
    const cleanRules = [];
    for (const rule of rules) {
      if (!isPlainObject(rule)) throw badRequest(`선호도 결과 모양이 올바르지 않아요 (${name}). ${RELOAD_HINT}`);
      const label = get(rule, 'label');
      const note = get(rule, 'note', '');
      if (typeof label !== 'string' || !label.trim() || len(label) > LABEL_MAX) {
        throw badRequest(`규칙 이름은 1~${LABEL_MAX}자여야 해요 (${name}). ${RELOAD_HINT}`);
      }
      if (typeof note !== 'string' || len(note) > NOTE_MAX) throw badRequest(`규칙 설명은 ${NOTE_MAX}자까지예요 (${name}). ${RELOAD_HINT}`);
      if (!['약함', '보통', '강함'].includes(get(rule, 'strength'))) throw badRequest(`규칙 강도가 올바르지 않아요 (${name}). ${RELOAD_HINT}`);
      if (!['kept', 'missed', 'impossible'].includes(get(rule, 'status'))) throw badRequest(`규칙 상태가 올바르지 않아요 (${name}). ${RELOAD_HINT}`);
      if (!isCount(get(rule, 'misses')) || !isCount(get(rule, 'checked'))) {
        throw badRequest(`선호도 결과의 숫자가 올바르지 않아요 (${name}). ${RELOAD_HINT}`);
      }
      cleanRules.push({ label, strength: rule.strength, status: rule.status, misses: rule.misses, checked: rule.checked, note });
    }
    ruleCount += cleanRules.length;
    cleanPeople.push({ name, kept, total, rules: cleanRules });
  }
  if (ruleCount === 0) throw badRequest('설명할 선호도 규칙이 없어요.');

  let context = get(body, 'context');
  if (context === undefined || context === null) context = {};
  if (!isPlainObject(context)) throw badRequest(`선호도 결과 모양이 올바르지 않아요. ${RELOAD_HINT}`);
  const cleanContext = {};
  for (const key of ['targetShort', 'shiftGap']) {
    const names = get(context, key, []);
    if (!Array.isArray(names) || names.length > PEOPLE_MAX) throw badRequest(`선호도 결과 모양이 올바르지 않아요. ${RELOAD_HINT}`);
    cleanContext[key] = names.map(checkName);
  }
  for (const key of ['yaya', 'emptySlots']) {
    const number = get(context, key, 0);
    if (!isCount(number)) throw badRequest(`선호도 결과의 숫자가 올바르지 않아요. ${RELOAD_HINT}`);
    cleanContext[key] = number;
  }
  return { period: { start: startText, weeks }, people: cleanPeople, context: cleanContext };
}

// AI 설명을 600자 이내로. 넘으면 600자 안의 마지막 문장 끝에서 자르고, 문장 끝이 없으면 '…'
export function shortenSummary(text) {
  const trimmed = text.trim();
  const list = chars(trimmed);
  if (list.length <= SUMMARY_MAX) return trimmed;
  const head = list.slice(0, SUMMARY_MAX).join('');
  const end = Math.max(...['. ', '! ', '? ', '.\n', '!\n', '?\n'].map((mark) => head.lastIndexOf(mark)));
  if (end >= 0 && chars(head.slice(0, end)).length >= SUMMARY_MAX / 2) return head.slice(0, end + 1);
  return list.slice(0, SUMMARY_MAX - 1).join('') + '…';
}

// OpenRouterError → ApiError (문구는 AI 쪽이 만든 해요체 그대로, 혹시 키가 섞이면 가림)
export function aiErrorResponse(error, env) {
  let code = error && error.code;
  if (!AI_CODES.has(code)) code = 'ai_server';
  let message = error && typeof error.message === 'string' ? error.message : '';
  if (!message.trim()) message = code === 'no_key' ? NO_KEY_MESSAGE : AI_FALLBACK_MESSAGE;
  const key = String(env.OPENROUTER_API_KEY || '').trim();
  if (key && message.includes(key)) message = message.split(key).join('(API 키)');
  return new ApiError(hasOwn(AI_STATUS, code) ? AI_STATUS[code] : 502, code, message);
}

// ---------- 접근 코드와 요청 횟수 제한 ----------

function digest(text) {
  return createHash('sha256').update(String(text), 'utf8').digest();
}

// 화면은 한글 코드도 보낼 수 있게 encodeURIComponent 해서 보낸다
export function readAccessCode(request) {
  const raw = request.headers.get(ACCESS_HEADER);
  if (raw === null) return '';
  try {
    return decodeURIComponent(raw).trim();
  } catch (e) {
    return raw.trim();
  }
}

export function accessConfigured(env) {
  return Boolean(String(env.ACCESS_CODE || '').trim());
}

function codeMatches(given, env) {
  return timingSafeEqual(digest(given), digest(String(env.ACCESS_CODE || '').trim()));
}

// 요청한 사람의 IP. Vercel이 x-forwarded-for를 진짜 IP로 덮어써서 보낸다
export function clientIp(request) {
  const header = request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for') ||
    request.headers.get('x-real-ip') || '';
  return header.split(',')[0].trim() || 'unknown';
}

// 시간 창 안의 횟수를 세는 간단한 기록. hit()는 이번 요청을 세고, 넘었으면 다시 시도할 수 있는 초를 돌려준다 (안 넘었으면 0)
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  recent(key, now) {
    const list = (this.hits.get(key) || []).filter((time) => now - time < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  blockedFor(key, now) {
    const list = this.recent(key, now);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
  }

  hit(key, now) {
    const wait = this.blockedFor(key, now);
    if (wait) return wait;
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) { // 기억하는 IP가 너무 많아지면 오래된 것부터 정리
      for (const k of this.hits.keys()) {
        this.recent(k, now);
        if (this.hits.size <= 4000) break;
      }
    }
    return 0;
  }

  reset() {
    this.hits.clear();
  }
}

export const aiLimiter = new RateLimiter(AI_REQUESTS_PER_WINDOW, RATE_WINDOW_MS);
export const codeFailLimiter = new RateLimiter(CODE_FAILS_PER_WINDOW, RATE_WINDOW_MS);

function waitText(seconds) {
  return seconds >= 60 ? `${Math.ceil(seconds / 60)}분` : `${seconds}초`;
}

function rateLimited(seconds, what) {
  return new ApiError(429, 'rate_limited', `${what} 너무 많아요. ${waitText(seconds)} 뒤에 다시 시도해 주세요.`,
    { 'Retry-After': String(seconds) });
}

// 접근 코드 상태: 'ok' | 'missing'(안 보냄) | 'wrong'(틀림) | 'locked'(너무 많이 틀림)
export function accessState(request, env, now) {
  const ip = clientIp(request);
  if (codeFailLimiter.blockedFor(ip, now)) return 'locked';
  const given = readAccessCode(request);
  if (!given) return 'missing';
  if (codeMatches(given, env)) return 'ok';
  codeFailLimiter.hit(ip, now);
  return 'wrong';
}

// AI를 부르기 전 검사: 키 → 접근 코드 설정 → 접근 코드 → 횟수 제한
function requireAiAccess(request, env, now) {
  if (!hasApiKey(env)) throw new ApiError(503, 'no_key', NO_KEY_MESSAGE);
  if (!accessConfigured(env)) throw new ApiError(503, 'no_access_code', NO_ACCESS_CODE_MESSAGE);
  const ip = clientIp(request);
  const state = accessState(request, env, now);
  if (state === 'locked') {
    throw rateLimited(codeFailLimiter.blockedFor(ip, now) || 60, '접근 코드를 틀린 횟수가');
  }
  if (state === 'missing') throw new ApiError(401, 'access_denied', NEED_CODE_MESSAGE);
  if (state === 'wrong') throw new ApiError(401, 'access_denied', WRONG_CODE_MESSAGE);
  const wait = aiLimiter.hit(ip, now);
  if (wait) throw rateLimited(wait, 'AI 요청이');
}

// ---------- 응답과 본문 ----------

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(413, 'too_large', '보내는 내용이 너무 커요. 선호도 글을 줄여 주세요.');
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) throw new ApiError(413, 'too_large', '보내는 내용이 너무 커요. 선호도 글을 줄여 주세요.');
  if (!bytes.length) throw badRequest(`보내는 내용이 없어요. ${RELOAD_HINT}`);
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (e) {
    throw badRequest(`보내는 내용을 읽지 못했어요 (JSON 모양이 아니에요). ${RELOAD_HINT}`);
  }
  if (!isPlainObject(data)) throw badRequest(`보내는 내용의 모양이 올바르지 않아요. ${RELOAD_HINT}`);
  return data;
}

// ---------- 주소별 처리 ----------

// GET /api/health: AI를 쓸 준비가 됐는지. OpenRouter는 부르지 않는다 (빠르고 무료).
// Colab 서버의 답(ok·key·model·message)에 Vercel용 정보(host·ready·access·models)를 더한다.
async function health(request, ctx) {
  const { env, now } = ctx;
  const key = hasApiKey(env);
  const configured = accessConfigured(env);
  const ready = key && configured;
  const access = configured ? accessState(request, env, now()) : 'missing';
  const models = modelList(env);
  let message = READY_MESSAGE;
  if (!key) message = NO_KEY_MESSAGE;
  else if (!configured) message = NO_ACCESS_CODE_MESSAGE;
  else if (access === 'missing') message = NEED_CODE_MESSAGE;
  else if (access === 'wrong') message = WRONG_CODE_MESSAGE;
  else if (access === 'locked') message = '접근 코드를 너무 많이 틀렸어요. 10분쯤 뒤에 다시 시도해 주세요.';
  ctx.note = access;
  return json(200, { ok: true, host: 'vercel', key, ready, access, model: models[0], models, message });
}

// POST /api/preferences: 선호도 글 → 선호도 규칙 (F5). 규칙이 0개여도 오류가 아니다.
async function preferences(request, ctx) {
  const body = await readJsonBody(request);
  const input = checkPreferencesRequest(body);
  requireAiAccess(request, ctx.env, ctx.now());
  let result;
  try {
    result = await parsePreferences(input, ctx);
  } catch (error) {
    if (error instanceof OpenRouterError) {
      ctx.note = (error.tried || []).map((t) => `${t.model}:${t.code}`).join(' ');
      throw aiErrorResponse(error, ctx.env);
    }
    throw error;
  }
  ctx.note = result.model;
  return json(200, { ok: true, rules: result.rules, unparsed: result.unparsed, model: result.model });
}

// POST /api/summary: 사람별 선호도 결과 → AI의 짧은 설명 (F6). 근무표 자체는 받지 않는다.
async function summary(request, ctx) {
  const body = await readJsonBody(request);
  const report = checkSummaryRequest(body);
  requireAiAccess(request, ctx.env, ctx.now());
  let result;
  try {
    result = await explainResult(report, ctx);
  } catch (error) {
    if (error instanceof OpenRouterError) {
      ctx.note = (error.tried || []).map((t) => `${t.model}:${t.code}`).join(' ');
      throw aiErrorResponse(error, ctx.env);
    }
    throw error;
  }
  if (typeof result.summary !== 'string' || !result.summary.trim()) throw new ApiError(502, 'ai_empty', AI_EMPTY_MESSAGE);
  ctx.note = result.model;
  return json(200, { ok: true, summary: shortenSummary(result.summary), model: result.model });
}

const ROUTES = {
  health: { method: 'GET', run: health },
  preferences: { method: 'POST', run: preferences },
  summary: { method: 'POST', run: summary },
};

// 기록 한 줄: 주소·상태·오류 코드·걸린 시간·(AI) 쓴 모델. 선호도 글·이름·키·접근 코드는 적지 않는다
function defaultLog(line) {
  console.log(line);
}

// 주소 하나를 처리하는 함수를 만든다. 테스트에서는 env·fetchImpl·now·log를 바꿔 끼운다.
export function createHandler(name, options = {}) {
  const route = ROUTES[name];
  return async function handle(request) {
    const env = options.env || process.env;
    const ctx = { env, fetchImpl: options.fetchImpl || globalThis.fetch, now: options.now || Date.now, note: '' };
    if (options.totalSeconds) ctx.totalSeconds = options.totalSeconds; // 테스트에서 AI 전체 시간을 짧게
    const log = options.log || defaultLog;
    const started = Date.now();
    let response;
    let code = '';
    try {
      if (request.method !== route.method) {
        throw new ApiError(405, 'method_not_allowed', `이 주소는 ${route.method} 방식으로만 쓸 수 있어요.`, { Allow: route.method });
      }
      response = await route.run(request, ctx);
    } catch (error) {
      if (error instanceof ApiError) {
        code = error.code;
        response = json(error.status, { ok: false, code: error.code, message: error.message }, error.headers);
      } else {
        code = 'server_error';
        log(`예상 못 한 오류 (${name}): ${error && error.name}`); // 오류 내용에 사용자 글이 섞일 수 있어 종류만 적는다
        response = json(500, { ok: false, code: 'server_error', message: SERVER_ERROR_MESSAGE });
      }
    }
    const note = ctx.note ? ` ${ctx.note}` : '';
    log(`${request.method} /api/${name} ${response.status}${code ? ' ' + code : ''} ${Date.now() - started}ms${note}`);
    return response;
  };
}

// Vercel 함수 파일(api/*.js)이 export default 로 내보낼 모양: { fetch(request) }
export function vercelFunction(name) {
  const handle = createHandler(name);
  return { fetch: (request) => handle(request) };
}
