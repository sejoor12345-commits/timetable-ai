// OpenRouter에 요청을 보내는 공통 함수 (Vercel 서버리스 함수용).
// timetable_server/openrouter_client.py를 그대로 옮겼다. 다른 점은 두 가지뿐이다.
//   1. 모델을 하나가 아니라 "차례대로 시도할 목록"으로 받는다 (앞 모델이 없어지거나 막히면 다음 모델로).
//   2. 안내 문구가 Colab 셀 대신 Vercel 환경 변수(Settings → Environment Variables)를 가리킨다.
// 이 파일은 선호도 글을 로그에 남기지 않는다. API 키는 요청 머리말에만 넣는다.

export const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// 환경 변수 OPENROUTER_MODELS가 비어 있을 때 쓰는 모델 목록 (앞에서부터 시도).
// 1번은 Colab 서버(openrouter_client.py의 TEXT_MODEL)와 같은 모델, 2번은 아주 싼 유료 모델, 3번은 무료 모델 자동 선택.
export const DEFAULT_MODELS = ['stealth/space-bunny-alpha', 'google/gemini-2.5-flash-lite', 'openrouter/free'];

// Vercel 함수는 60초까지만 돌 수 있게 해 두었다 (api/*.js의 maxDuration). 그 안에 답하도록 전체 시간을 55초로 잰다.
export const TOTAL_SECONDS = 55;
export const MIN_RETRY_SECONDS = 8; // 남은 시간이 이보다 짧으면 다음 모델을 시도하지 않는다

export const NO_KEY_MESSAGE =
  'API 키가 없어요. Vercel 프로젝트의 Settings → Environment Variables에 OPENROUTER_API_KEY를 넣은 다음, ' +
  'Deployments 화면에서 Redeploy(다시 배포)를 눌러 주세요.';
export const AUTH_MESSAGE =
  'API 키가 올바르지 않아요. Vercel 환경 변수 OPENROUTER_API_KEY 값을 확인하고 Redeploy를 눌러 주세요.';
export const CREDIT_MESSAGE =
  'OpenRouter 계정의 크레딧(사용할 수 있는 금액)이 부족해서 AI를 쓸 수 없어요. ' +
  'openrouter.ai에 로그인해 Credits 화면에서 잔액을 확인해 주세요.';
export function modelMessage(model) {
  return `AI 모델(${model})을 찾을 수 없어요. 모델 이름이 바뀌었거나 서비스가 끝났을 수 있어요. ` +
    'Vercel 환경 변수 OPENROUTER_MODELS의 모델 이름을 확인해 주세요.';
}
export const RATE_LIMIT_MESSAGE =
  'AI 요청이 몰려서 잠시 막혔어요. 1분쯤 뒤에 다시 시도해 주세요. ' +
  '계속 이러면 오늘 쓸 수 있는 무료 사용량을 다 쓴 것일 수 있어요.';
export const SERVER_MESSAGE = 'AI 서버가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
export const READ_MESSAGE = 'AI 서버의 답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.';
export const TIMEOUT_MESSAGE = 'AI 답이 너무 늦어서 기다리기를 멈췄어요. AI 서버가 바쁜 것 같아요. 잠시 후 다시 시도해 주세요.';
export const CONNECT_MESSAGE = 'AI 서버(OpenRouter)에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.';
export const EMPTY_MESSAGE = 'AI가 빈 답을 보냈어요. 다시 시도해 주세요.';

// 화면에 그대로 보여 줘도 되는 안내 문구(message)와 짧은 영어 오류 코드(code)를 담은 오류 (Python의 OpenRouterError)
// status: OpenRouter가 준 상태 코드 (없으면 0). 다음 모델을 시도할지 정할 때만 쓴다.
export class OpenRouterError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.message = message;
    this.code = code;
    this.status = status;
  }
}

export function hasApiKey(env) {
  return Boolean(String(env.OPENROUTER_API_KEY || '').trim());
}

export function getApiKey(env) {
  const key = String(env.OPENROUTER_API_KEY || '').trim();
  if (!key) throw new OpenRouterError(NO_KEY_MESSAGE, 'no_key');
  return key;
}

// 환경 변수 OPENROUTER_MODELS("모델1,모델2")를 목록으로. 비어 있으면 DEFAULT_MODELS
export function modelList(env) {
  const names = String(env.OPENROUTER_MODELS || '').split(',').map((name) => name.trim()).filter(Boolean);
  const unique = names.filter((name, index) => names.indexOf(name) === index).slice(0, 5); // 너무 많으면 5개까지
  return unique.length ? unique : DEFAULT_MODELS.slice();
}

// 글자 수를 Python과 같은 기준(이모지도 1자)으로 세고 자른다
export function chars(text) {
  return Array.from(text);
}

// Python의 " ".join(str.split()): 줄바꿈·연속 공백을 한 칸으로
export function squeeze(text) {
  return String(text).split(/\s+/).filter(Boolean).join(' ');
}

// 오류 응답에서 원인 설명만 짧게 꺼낸다 (100자까지)
export function errorDetail(body) {
  let detail;
  try {
    detail = JSON.parse(body).error.message;
    if (detail === undefined) detail = body;
  } catch (e) {
    detail = body;
  }
  return chars(squeeze(detail)).slice(0, 100).join('') || '내용 없음';
}

const STATUS_ERRORS = {
  401: ['ai_auth', AUTH_MESSAGE],
  402: ['ai_auth', CREDIT_MESSAGE],
  408: ['ai_timeout', TIMEOUT_MESSAGE],
  429: ['ai_rate_limit', RATE_LIMIT_MESSAGE],
};

// 상태 코드(401, 429, 500 …)를 알맞은 OpenRouterError로
export function statusError(status, body, model) {
  if (status === 404) return new OpenRouterError(modelMessage(model), 'ai_model', status);
  if (STATUS_ERRORS[status]) {
    const [code, message] = STATUS_ERRORS[status];
    return new OpenRouterError(message, code, status);
  }
  return new OpenRouterError(`${SERVER_MESSAGE} (상태 코드 ${status}: ${errorDetail(body)})`, 'ai_server', status);
}

// 생각하고 답하는 모델이 답 앞에 붙이는 <think>…</think>를 지우고 답만 남긴다
export function removeThink(content) {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  if (text.includes('</think>')) text = text.slice(text.lastIndexOf('</think>') + '</think>'.length);
  if (text.includes('<think>')) text = text.slice(0, text.indexOf('<think>'));
  return text.trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// OpenRouter의 정상(200) 응답 본문에서 AI가 쓴 답 글자만 꺼낸다
export function answerText(body, model) {
  if (!body.trim()) throw new OpenRouterError(EMPTY_MESSAGE, 'ai_empty');
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new OpenRouterError(`${READ_MESSAGE} (받은 내용: ${errorDetail(body)})`, 'ai_server');
  }
  // 이미 200을 보낸 뒤라 AI 쪽 오류가 본문 안에 {"error": …}로 오는 경우
  if (isPlainObject(data) && data.error && !data.choices) {
    const code = isPlainObject(data.error) ? data.error.code : undefined;
    throw statusError(Number.isInteger(code) && code >= 400 ? code : 502, body, model);
  }
  let content;
  try {
    content = data.choices[0].message.content;
  } catch (e) {
    throw new OpenRouterError(`${READ_MESSAGE} (받은 내용: ${errorDetail(body)})`, 'ai_server');
  }
  if (content === undefined) throw new OpenRouterError(`${READ_MESSAGE} (받은 내용: ${errorDetail(body)})`, 'ai_server');
  const text = removeThink(typeof content === 'string' ? content : '');
  if (!text) throw new OpenRouterError(EMPTY_MESSAGE, 'ai_empty');
  return text;
}

// 모델 하나에 한 번 묻는다. timeoutMs 안에 답(본문 끝까지)이 오지 않으면 ai_timeout
export async function chatOnce({ messages, temperature, model, key, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, timeoutMs));
  let status;
  let body;
  try {
    const response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature }),
      signal: controller.signal,
    });
    status = response.status;
    body = await response.text(); // 본문을 다 받는 시간까지 timeoutMs 안에 들어간다
  } catch (error) {
    if (timedOut) throw new OpenRouterError(TIMEOUT_MESSAGE, 'ai_timeout');
    throw new OpenRouterError(CONNECT_MESSAGE, 'ai_connect');
  } finally {
    clearTimeout(timer);
  }
  if (status !== 200) throw statusError(status, body, model);
  return answerText(body, model);
}

// 이 오류가 나면 다음 모델을 시도해 볼 만한지. 키가 틀린 것(401)은 모델을 바꿔도 같으므로 멈춘다.
// 402(크레딧 부족)는 유료 모델만 막히고 무료 모델은 될 수 있어 다음 모델로 간다.
export function shouldTryNext(error) {
  if (!(error instanceof OpenRouterError)) return false;
  if (error.code === 'no_key') return false;
  if (error.code === 'ai_auth' && error.status !== 402) return false;
  return true;
}

// AI에게 묻고 답을 돌려준다. models를 앞에서부터 시도하고, 실패하면 다음 모델로 (전체 TOTAL_SECONDS 안에서).
// check(answer)를 주면 답을 검사해서, check가 OpenRouterError를 내면(예: JSON이 아님) 그것도 실패로 보고 다음 모델로 간다.
// 돌려주는 값: { value: check의 결과(없으면 답 글자), model: 성공한 모델, tried: [{ model, code }] }
// 모두 실패하면 마지막 오류를 낸다 (오류에 tried가 붙어 있음).
export async function chatWithFallback({ messages, temperature = 0.3, env, fetchImpl = fetch, now = Date.now, check,
  totalSeconds = TOTAL_SECONDS }) {
  const key = getApiKey(env);
  const models = modelList(env);
  const deadline = now() + totalSeconds * 1000;
  const minRetryMs = Math.min(MIN_RETRY_SECONDS, totalSeconds / 2) * 1000;
  const tried = [];
  let lastError = null;
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const remaining = deadline - now();
    if (index > 0 && remaining < minRetryMs) break;
    try {
      const answer = await chatOnce({ messages, temperature, model, key, timeoutMs: remaining, fetchImpl });
      const value = check ? check(answer) : answer;
      tried.push({ model, code: 'ok' });
      return { value, model, tried };
    } catch (error) {
      if (!(error instanceof OpenRouterError)) throw error;
      tried.push({ model, code: error.code });
      lastError = error;
      if (!shouldTryNext(error)) break;
    }
  }
  if (!lastError) lastError = new OpenRouterError(TIMEOUT_MESSAGE, 'ai_timeout');
  lastError.tried = tried;
  throw lastError;
}

// 문자열 text의 start 자리 "{"에서 시작하는 JSON 객체 하나의 끝 위치 (짝이 안 맞으면 -1). 글자("…") 안의 괄호는 세지 않는다.
function objectEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

// AI 답에서 JSON을 꺼낸다. ```json 코드블록이나 앞뒤 설명 글이 붙어 있어도 읽어 본다. 끝내 못 읽으면 Error
export function extractJson(text) {
  const candidates = [text.trim()];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (e) { /* 다음 후보 */ }
  }
  // 설명 글 사이에 끼어 있는 경우: "{"가 나오는 자리마다 거기서 시작하는 JSON 객체를 읽어 본다
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const end = objectEnd(text, i);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch (e) { /* 다음 "{" */ }
  }
  throw new Error('JSON을 찾지 못함');
}
