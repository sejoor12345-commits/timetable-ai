// Vercel 함수(api/)를 가짜 OpenRouter로 시험한다. 실행: node --test tests/
// 진짜 OpenRouter에는 요청을 보내지 않는다 (fetch를 바꿔 끼움). 테스트 이름은 A, B, C… 가명만 쓴다.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCESS_HEADER, AI_REQUESTS_PER_WINDOW, CODE_FAILS_PER_WINDOW, aiLimiter, checkPreferencesRequest, checkSummaryRequest,
  codeFailLimiter, createHandler, shortenSummary,
} from '../api/_lib/http.js';
import { API_URL, DEFAULT_MODELS, answerText, extractJson, removeThink } from '../api/_lib/openrouter.js';
import {
  BAD_ANSWER_MESSAGE, buildParseMessages, buildSummaryData, buildSummaryMessages, checkAnswer, periodDates, plainText,
} from '../api/_lib/preferences.js';
import healthFunction from '../api/health.js';
import preferencesFunction, { config as preferencesConfig } from '../api/preferences.js';
import summaryFunction from '../api/summary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUTS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/parity_inputs.json'), 'utf8'));
const EXPECTED = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/parity_expected.json'), 'utf8'));

const KEY = 'sk-or-test-not-a-real-key-1234567890';
const CODE = '훈련-2580';
const ENV = { OPENROUTER_API_KEY: KEY, ACCESS_CODE: CODE, OPENROUTER_MODELS: 'model/one, model/two ,model/three' };
const PRD_TEXT = INPUTS.parse_messages[0].text;
const PEOPLE = ['A', 'B', 'C', 'D', 'E'];
const GOOD_ANSWER = INPUTS.check_answer[0].data; // PRD_step1 9장 예시 글의 기대 결과

beforeEach(() => {
  aiLimiter.reset();
  codeFailLimiter.reset();
});

// ---------- 도구 ----------

// 가짜 OpenRouter. reply(model, callIndex) → { status, body } | 'hang'(답 없음) | 'network'(연결 실패)
function fakeOpenRouter(reply) {
  const calls = [];
  async function fetchImpl(url, init) {
    const sent = JSON.parse(init.body);
    calls.push({ url, model: sent.model, temperature: sent.temperature, messages: sent.messages, headers: init.headers });
    const r = reply(sent.model, calls.length - 1);
    if (r === 'network') throw new TypeError('fetch failed');
    if (r === 'hang') {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200 });
  }
  return { fetchImpl, calls };
}

function chatBody(content) {
  return { id: 'x', choices: [{ message: { role: 'assistant', content } }] };
}

function okAnswer(content) {
  return () => ({ status: 200, body: chatBody(typeof content === 'string' ? content : JSON.stringify(content)) });
}

function prefsBody(extra = {}) {
  return { text: PRD_TEXT, people: PEOPLE, period: { start: '2026-09-28', weeks: 4 }, holidays: [], ...extra };
}

const SUMMARY_REQUEST = INPUTS.summary_request[0];

function request(pathName, { method = 'POST', body, code = CODE, ip = '10.0.0.1', raw, headers = {} } = {}) {
  const h = { 'x-forwarded-for': `${ip}, 10.9.9.9`, ...headers };
  if (code !== null) h[ACCESS_HEADER] = encodeURIComponent(code);
  const init = { method, headers: h };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  if (init.body !== undefined) h['content-type'] = 'application/json';
  return new Request(`https://example.vercel.app/api/${pathName}`, init);
}

async function call(name, req, { env = ENV, fake = fakeOpenRouter(okAnswer(GOOD_ANSWER)), now, totalSeconds } = {}) {
  const logs = [];
  const handler = createHandler(name, { env, fetchImpl: fake.fetchImpl, now, totalSeconds, log: (line) => logs.push(line) });
  const res = await handler(req);
  const data = await res.json();
  return { res, data, logs, calls: fake.calls };
}

// ---------- 1. Python 원본과 같은지 (tests/parity.py가 만든 기준 답) ----------

test('프롬프트: Python과 글자까지 같은 메시지 4개 (지시·예시 질문·예시 답·실제 질문)', () => {
  INPUTS.parse_messages.forEach((c, i) => {
    const [y, m, d] = c.today.split('-').map(Number);
    const today = new Date(Date.UTC(y, m - 1, d));
    const messages = buildParseMessages(c.text, c.people, periodDates(c.start, c.weeks), new Set(c.holidays), today);
    assert.deepEqual(messages, EXPECTED.parse_messages[i]);
  });
});

test('AI 답 검사(check_answer): Python과 같은 규칙·바꾸지 못한 문장·오류', () => {
  INPUTS.check_answer.forEach((c, i) => {
    let got;
    try {
      got = { ok: checkAnswer(c.data, c.people, periodDates(c.start, c.weeks)) };
    } catch (e) {
      got = { error: e.code };
    }
    assert.deepEqual(got, EXPECTED.check_answer[i], c.name);
  });
});

test('JSON 꺼내기·<think> 지우기·설명 정리: Python과 같음', () => {
  INPUTS.extract_json.forEach((text, i) => {
    let got;
    try { got = { ok: extractJson(text) }; } catch (e) { got = { error: 'ValueError' }; }
    assert.deepEqual(got, EXPECTED.extract_json[i], text);
  });
  // OpenRouter 200 응답 본문 읽기: 오류 코드가 Python과 같아야 함 (빈 choices + 본문 안 오류 429 → ai_rate_limit 등)
  INPUTS.answer_text.forEach((body, i) => {
    let got;
    try { got = { ok: answerText(body, 'm') }; } catch (e) { got = { error: e.code }; }
    assert.deepEqual(got, EXPECTED.answer_text[i], body);
  });
  assert.deepEqual(INPUTS.remove_think.map(removeThink), EXPECTED.remove_think);
  assert.deepEqual(INPUTS.plain_text.map(plainText), EXPECTED.plain_text);
  assert.deepEqual(INPUTS.shorten_summary.map(shortenSummary), EXPECTED.shorten_summary);
});

test('결과 설명 자료·메시지: Python과 같음', () => {
  assert.deepEqual(INPUTS.summary_data.map(buildSummaryData), EXPECTED.summary_data);
  assert.deepEqual(INPUTS.summary_data.map(buildSummaryMessages), EXPECTED.summary_messages);
});

test('요청 검사(server.py와 같은 상태 코드·문구)', () => {
  const run = (fn, body) => {
    try { return { ok: fn(body) }; } catch (e) { return { error: [e.status, e.code, e.message] }; }
  };
  assert.deepEqual(INPUTS.preferences_request.map((b) => run(checkPreferencesRequest, b)), EXPECTED.preferences_request);
  assert.deepEqual(INPUTS.summary_request.map((b) => run(checkSummaryRequest, b)), EXPECTED.summary_request);
});

// ---------- 2. /api/health ----------

test('health: 키·접근 코드가 다 있고 코드가 맞으면 ready·access ok, OpenRouter는 부르지 않음', async () => {
  const { res, data, calls } = await call('health', request('health', { method: 'GET' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    [data.ok, data.host, data.key, data.ready, data.access, data.model, data.models],
    [true, 'vercel', true, true, 'ok', 'model/one', ['model/one', 'model/two', 'model/three']]);
  assert.equal(calls.length, 0);
});

test('health: 키 없음 / 접근 코드 설정 없음 / 코드 안 보냄 / 틀린 코드', async () => {
  let r = await call('health', request('health', { method: 'GET' }), { env: { ACCESS_CODE: CODE } });
  assert.deepEqual([r.data.key, r.data.ready], [false, false]);
  assert.match(r.data.message, /OPENROUTER_API_KEY/);
  r = await call('health', request('health', { method: 'GET' }), { env: { OPENROUTER_API_KEY: KEY } });
  assert.deepEqual([r.data.key, r.data.ready], [true, false]);
  assert.match(r.data.message, /ACCESS_CODE/);
  r = await call('health', request('health', { method: 'GET', code: null }));
  assert.deepEqual([r.data.ready, r.data.access], [true, 'missing']);
  r = await call('health', request('health', { method: 'GET', code: '틀림' }));
  assert.equal(r.data.access, 'wrong');
});

test('health: 모델 목록이 비어 있으면 기본 목록 (Colab과 같은 모델이 먼저)', async () => {
  const { data } = await call('health', request('health', { method: 'GET' }), { env: { OPENROUTER_API_KEY: KEY, ACCESS_CODE: CODE } });
  assert.deepEqual(data.models, DEFAULT_MODELS);
  assert.equal(data.model, DEFAULT_MODELS[0]);
});

// ---------- 3. /api/preferences ----------

test('해석 정상: PRD 예시 글 → 규칙 5개 + 바꾸지 못한 문장 1개, 첫 모델·온도 0.1·키는 머리말에만', async () => {
  const { res, data, calls } = await call('preferences', request('preferences', { body: prefsBody() }));
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.rules.length, 5);
  assert.deepEqual(data.rules.map((r) => r.person), PEOPLE);
  assert.equal(data.unparsed.length, 1);
  assert.equal(data.model, 'model/one');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API_URL);
  assert.equal(calls[0].temperature, 0.1);
  assert.equal(calls[0].messages.length, 4);
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!JSON.stringify(calls[0].messages).includes(KEY));
  assert.ok(calls[0].messages[3].content.includes(PRD_TEXT));
});

test('경계: AI에는 선호도 글·이름·기간 날짜만 가고, 답에는 규칙만 (근무표 칸 데이터 없음)', async () => {
  const { data, calls } = await call('preferences', request('preferences', { body: prefsBody({ shifts: { 1: { '2026-09-28': ['주'] } } }) }));
  assert.ok(!JSON.stringify(calls[0].messages).includes('shifts'));
  assert.deepEqual(Object.keys(data).sort(), ['model', 'ok', 'rules', 'unparsed']);
  data.rules.forEach((rule) => assert.ok(['day_shift', 'pattern', 'date_shift', 'ratio'].includes(rule.type)));
});

test('AI가 ```json 블록 + 앞뒤 설명 + <think>를 붙여도 읽음', async () => {
  const content = '<think>음…</think>여기 있어요:\n```json\n' + JSON.stringify(GOOD_ANSWER) + '\n```\n끝!';
  const { data } = await call('preferences', request('preferences', { body: prefsBody() }), { fake: fakeOpenRouter(okAnswer(content)) });
  assert.equal(data.rules.length, 5);
});

test('AI 답이 JSON이 아니면 다음 모델로, 모두 JSON이 아니면 502 ai_bad_answer', async () => {
  let fake = fakeOpenRouter((model) => (model === 'model/one' ? okAnswer('규칙을 못 만들었어요')() : okAnswer(GOOD_ANSWER)()));
  let r = await call('preferences', request('preferences', { body: prefsBody() }), { fake });
  assert.equal(r.res.status, 200);
  assert.equal(r.data.model, 'model/two');
  assert.deepEqual(r.calls.map((c) => c.model), ['model/one', 'model/two']);

  fake = fakeOpenRouter(okAnswer('{"rules": 망가짐'));
  r = await call('preferences', request('preferences', { body: prefsBody() }), { fake });
  assert.equal(r.res.status, 502);
  assert.deepEqual([r.data.ok, r.data.code, r.data.message], [false, 'ai_bad_answer', BAD_ANSWER_MESSAGE]);
  assert.equal(r.calls.length, 3);
});

test('규칙 모양이 틀린 답: 맞는 규칙만 받고 나머지는 이유와 함께 unparsed (오류 아님)', async () => {
  const answer = {
    rules: [
      GOOD_ANSWER.rules[0],
      { person: 'Z', type: 'ratio', shift: '주', level: 'only', quote: 'Z는 주간만' },
      { person: 'B', type: 'pattern', sequence: ['야', '주', '비'], quote: '야 주 비' },
      { person: 'C', type: 'date_shift', dates: ['2027-01-01'], shift: '근무', want: 'avoid', quote: '새해' },
      { person: 'D', type: 'roster', days: {}, quote: '근무표를 직접 짜 줘' },
    ],
  };
  const { res, data } = await call('preferences', request('preferences', { body: prefsBody() }), { fake: fakeOpenRouter(okAnswer(answer)) });
  assert.equal(res.status, 200);
  assert.equal(data.rules.length, 1);
  assert.deepEqual(data.unparsed.map((u) => u.reason), [
    '인원 목록에 없는 이름이에요 (Z). 설정 탭의 이름과 똑같이 써 주세요.',
    '지킬 수 없는 흐름이에요: 야간 다음 날 주간은 안 돼요',
    '기간 밖 날짜예요 (1/1)',
    '규칙 종류를 알 수 없어요. 요일·근무 흐름·날짜·주야 비율에 관한 바람만 규칙으로 바꿀 수 있어요.',
  ]);
});

test('모델 없음(404)·요청 몰림(429)·빈 답·연결 실패면 다음 모델로', async () => {
  const replies = {
    'model/one': { status: 404, body: { error: { message: 'No endpoints found', code: 404 } } },
    'model/two': { status: 429, body: { error: { message: 'Rate limit', code: 429 } } },
  };
  let fake = fakeOpenRouter((model) => replies[model] || okAnswer(GOOD_ANSWER)());
  let r = await call('preferences', request('preferences', { body: prefsBody() }), { fake });
  assert.equal(r.res.status, 200);
  assert.equal(r.data.model, 'model/three');
  assert.ok(r.logs.some((line) => line.includes('model/three')));

  fake = fakeOpenRouter((model) => (model === 'model/one' ? okAnswer('<think>생각만 하다 끝남</think>')() : model === 'model/two' ? 'network' : okAnswer(GOOD_ANSWER)()));
  r = await call('preferences', request('preferences', { body: prefsBody() }), { fake });
  assert.equal(r.data.model, 'model/three');
});

test('모든 모델이 실패하면 마지막 오류를 Colab과 같은 코드·HTTP 상태로', async () => {
  let r = await call('preferences', request('preferences', { body: prefsBody() }), {
    fake: fakeOpenRouter(() => ({ status: 429, body: { error: { message: 'slow down' } } })) });
  assert.deepEqual([r.res.status, r.data.code], [429, 'ai_rate_limit']);
  r = await call('preferences', request('preferences', { body: prefsBody() }), {
    fake: fakeOpenRouter(() => ({ status: 404, body: '' })) });
  assert.deepEqual([r.res.status, r.data.code], [502, 'ai_model']);
  assert.match(r.data.message, /model\/three/);
  assert.match(r.data.message, /OPENROUTER_MODELS/);
  r = await call('preferences', request('preferences', { body: prefsBody() }), {
    fake: fakeOpenRouter(() => ({ status: 503, body: { error: { message: 'Provider\nreturned   error' } } })) });
  assert.deepEqual([r.res.status, r.data.code], [502, 'ai_server']);
  assert.match(r.data.message, /상태 코드 503: Provider returned error/);
  r = await call('preferences', request('preferences', { body: prefsBody() }), {
    fake: fakeOpenRouter(() => ({ status: 200, body: { error: { message: 'upstream', code: 429 } } })) });
  assert.deepEqual([r.res.status, r.data.code], [429, 'ai_rate_limit']);
});

test('키가 틀리면(401) 다음 모델을 시도하지 않음, 크레딧 부족(402)은 다음(무료) 모델로', async () => {
  let r = await call('preferences', request('preferences', { body: prefsBody() }), {
    fake: fakeOpenRouter(() => ({ status: 401, body: { error: { message: 'No auth' } } })) });
  assert.deepEqual([r.res.status, r.data.code, r.calls.length], [502, 'ai_auth', 1]);
  assert.match(r.data.message, /OPENROUTER_API_KEY/);
  r = await call('preferences', request('preferences', { body: prefsBody() }), {
    fake: fakeOpenRouter((model) => (model === 'model/three' ? okAnswer(GOOD_ANSWER)() : { status: 402, body: {} })) });
  assert.deepEqual([r.res.status, r.data.model], [200, 'model/three']);
});

test('전체 시간이 다 되면 504 ai_timeout, 남은 시간이 짧으면 다음 모델을 시도하지 않음', async () => {
  const fake = fakeOpenRouter(() => 'hang');
  const r = await call('preferences', request('preferences', { body: prefsBody() }), { fake, totalSeconds: 0.2 });
  assert.deepEqual([r.res.status, r.data.code], [504, 'ai_timeout']);
  assert.match(r.data.message, /너무 늦어서/);
  assert.equal(r.calls.length, 1);
});

test('API 키가 없으면 503 no_key (OpenRouter를 부르지 않음)', async () => {
  const r = await call('preferences', request('preferences', { body: prefsBody() }), { env: { ACCESS_CODE: CODE } });
  assert.deepEqual([r.res.status, r.data.code, r.calls.length], [503, 'no_key', 0]);
  assert.match(r.data.message, /Environment Variables/);
});

test('접근 코드: 설정 안 됨 503, 안 보냄·틀림 401 (OpenRouter를 부르지 않음), 한글 코드도 됨', async () => {
  let r = await call('preferences', request('preferences', { body: prefsBody() }), { env: { OPENROUTER_API_KEY: KEY } });
  assert.deepEqual([r.res.status, r.data.code], [503, 'no_access_code']);
  r = await call('preferences', request('preferences', { body: prefsBody(), code: null }));
  assert.deepEqual([r.res.status, r.data.code, r.calls.length], [401, 'access_denied', 0]);
  r = await call('preferences', request('preferences', { body: prefsBody(), code: '훈련-2581' }));
  assert.deepEqual([r.res.status, r.data.code, r.calls.length], [401, 'access_denied', 0]);
  assert.match(r.data.message, /맞지 않아요/);
  r = await call('preferences', request('preferences', { body: prefsBody(), code: ` ${CODE} ` }));
  assert.equal(r.res.status, 200);
});

test('접근 코드를 10번 틀리면 그 IP는 잠시 잠김 (맞는 코드도 429), 다른 IP는 괜찮음', async () => {
  for (let i = 0; i < CODE_FAILS_PER_WINDOW; i++) {
    const r = await call('preferences', request('preferences', { body: prefsBody(), code: `틀림${i}`, ip: '10.0.0.7' }));
    assert.equal(r.res.status, 401);
  }
  let r = await call('preferences', request('preferences', { body: prefsBody(), ip: '10.0.0.7' }));
  assert.deepEqual([r.res.status, r.data.code], [429, 'rate_limited']);
  assert.ok(Number(r.res.headers.get('retry-after')) > 0);
  r = await call('health', request('health', { method: 'GET', ip: '10.0.0.7' }));
  assert.equal(r.data.access, 'locked');
  r = await call('preferences', request('preferences', { body: prefsBody(), ip: '10.0.0.8' }));
  assert.equal(r.res.status, 200);
});

test('IP별 요청 횟수 제한: 10분에 15번까지, 넘으면 429 rate_limited + Retry-After', async () => {
  for (let i = 0; i < AI_REQUESTS_PER_WINDOW; i++) {
    const r = await call('preferences', request('preferences', { body: prefsBody(), ip: '10.0.0.9' }));
    assert.equal(r.res.status, 200);
  }
  const r = await call('preferences', request('preferences', { body: prefsBody(), ip: '10.0.0.9' }));
  assert.deepEqual([r.res.status, r.data.code, r.calls.length], [429, 'rate_limited', 0]);
  assert.match(r.data.message, /분 뒤에 다시 시도/);
  assert.equal(r.res.headers.get('retry-after'), '600');
  const other = await call('preferences', request('preferences', { body: prefsBody(), ip: '10.0.0.10' }));
  assert.equal(other.res.status, 200);
});

test('본문 검사: 너무 큼 413, JSON 아님 400, 빈 글 400, GET은 405 (모두 OpenRouter를 부르지 않음)', async () => {
  let r = await call('preferences', request('preferences', { raw: JSON.stringify(prefsBody({ pad: 'x'.repeat(20001) })) }));
  assert.deepEqual([r.res.status, r.data.code], [413, 'too_large']);
  r = await call('preferences', request('preferences', { raw: '{망가진' }));
  assert.deepEqual([r.res.status, r.data.code], [400, 'bad_request']);
  r = await call('preferences', request('preferences', { body: prefsBody({ text: '   ' }) }));
  assert.deepEqual([r.res.status, r.data.message], [400, '선호도 문장을 먼저 써 주세요.']);
  r = await call('preferences', request('preferences', { method: 'GET' }));
  assert.deepEqual([r.res.status, r.data.code], [405, 'method_not_allowed']);
  assert.equal(r.calls.length, 0);
});

test('로그·응답에 선호도 글·이름·API 키·접근 코드가 남지 않음 (오류 글에 키가 섞여 와도 가림)', async () => {
  const secretText = 'A는 비밀스러운 주말 야간 선호 문장이에요';
  let r = await call('preferences', request('preferences', { body: prefsBody({ text: secretText }) }));
  r.logs.forEach((line) => {
    assert.ok(!line.includes(secretText) && !line.includes('비밀') && !line.includes(KEY) && !line.includes(CODE), line);
  });
  assert.match(r.logs[0], /^POST \/api\/preferences 200 \d+ms model\/one$/);
  r = await call('preferences', request('preferences', { body: prefsBody() }), {
    fake: fakeOpenRouter(() => ({ status: 500, body: { error: { message: `bad key ${KEY}` } } })) });
  assert.ok(!JSON.stringify(r.data).includes(KEY));
  assert.match(r.data.message, /\(API 키\)/);
});

test('예상 못 한 오류는 500 server_error, 로그에는 오류 종류만 (사용자 글은 안 남김)', async () => {
  const fake = { calls: [], fetchImpl: async () => ({ status: 200, text: async () => { throw new RangeError('boom'); } }) };
  let r = await call('preferences', request('preferences', { body: prefsBody() }), { fake });
  // 답 본문 읽기 실패는 연결 실패로 보고 다음 모델들을 시도한 뒤 ai_connect
  assert.deepEqual([r.res.status, r.data.code], [502, 'ai_connect']);
  const env = { OPENROUTER_API_KEY: KEY, ACCESS_CODE: CODE, get OPENROUTER_MODELS() { throw new RangeError('A는 비밀 글'); } };
  r = await call('preferences', request('preferences', { body: prefsBody() }), { env });
  assert.deepEqual([r.res.status, r.data.code], [500, 'server_error']);
  assert.ok(r.logs.some((line) => line.includes('RangeError')));
  assert.ok(r.logs.every((line) => !line.includes('비밀')));
});

// ---------- 4. /api/summary ----------

test('설명 정상: 마크다운을 지우고, 600자를 넘으면 문장 끝에서 자름, 온도 0.3', async () => {
  const longAnswer = '**전체** 결과예요.\n- ' + 'A는 주말 주간을 지켰어요. '.repeat(40);
  const fake = fakeOpenRouter(okAnswer(longAnswer));
  const { res, data, calls } = await call('summary', request('summary', { body: SUMMARY_REQUEST }), { fake });
  assert.equal(res.status, 200);
  assert.ok(!data.summary.includes('**') && !data.summary.includes('- '));
  assert.ok(Array.from(data.summary).length <= 600);
  assert.ok(data.summary.endsWith('.'));
  assert.equal(calls[0].temperature, 0.3);
  assert.equal(calls[0].messages.length, 2);
});

test('설명: 규칙 0개면 400, 키 없으면 503, 코드 틀리면 401', async () => {
  let r = await call('summary', request('summary', { body: { period: { start: '2026-09-28', weeks: 4 }, people: [] } }));
  assert.deepEqual([r.res.status, r.data.message], [400, '설명할 선호도 규칙이 없어요.']);
  r = await call('summary', request('summary', { body: SUMMARY_REQUEST }), { env: { ACCESS_CODE: CODE } });
  assert.deepEqual([r.res.status, r.data.code], [503, 'no_key']);
  r = await call('summary', request('summary', { body: SUMMARY_REQUEST, code: 'x' }));
  assert.deepEqual([r.res.status, r.data.code], [401, 'access_denied']);
});

// ---------- 5. Vercel 함수 파일 모양 ----------

test('api/*.js 는 Vercel 웹 방식({ fetch }) 으로 내보내고, 최대 시간은 무료 요금제 한도(60초) 안', async () => {
  for (const fn of [healthFunction, preferencesFunction, summaryFunction]) assert.equal(typeof fn.fetch, 'function');
  assert.ok(preferencesConfig.maxDuration <= 60);
  const saved = { ...process.env };
  try {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ACCESS_CODE;
    const res = await healthFunction.fetch(new Request('https://x.vercel.app/api/health'));
    const data = await res.json();
    assert.deepEqual([data.ok, data.host, data.ready], [true, 'vercel', false]);
  } finally {
    process.env = saved;
  }
});
