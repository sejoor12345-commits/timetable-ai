// 화면 끝까지 한 번 눌러 보는 시험 (휴대폰 크기 390×844, Chromium).
// 실행: node tests/e2e-smoke.mjs [스크린샷 폴더]    (Playwright가 설치돼 있어야 함. CI의 e2e 단계가 설치해서 돌림)
//
// 브라우저가 부르는 /api/* 는 page.route 로 가로채서 **진짜 api/ 함수 코드**에 넘기고,
// 그 함수가 부르는 OpenRouter만 가짜(PRD 예시 글의 기대 결과를 돌려줌)로 바꾼다. Supabase도 가짜로 막는다.
// 확인하는 것: Vercel 모드 감지 → 접근 코드 → AI 해석 → 규칙 5개 → 자동 생성 → 선호도 반영 결과 → AI 설명, 가로 스크롤 없음.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createHandler } from '../api/_lib/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.argv[2] || path.join(ROOT, 'test-results');
const require = createRequire(import.meta.url);

function loadPlaywright() {
  for (const name of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try { return require(name); } catch (e) { /* 다음 */ }
  }
  // GitHub Actions(CI=true)에서는 건너뛰지 않고 실패로 알린다 (설치가 깨져도 ✓로 보이면 시험을 안 한 것을 모름)
  if (process.env.CI) {
    console.error('Playwright를 불러오지 못했어요. CI의 "Playwright 설치" 단계를 확인해 주세요.');
    process.exit(1);
  }
  console.error('Playwright가 없어서 화면 시험을 건너뛰어요. (npm i --no-save playwright && npx playwright install chromium)');
  process.exit(0);
}

const ENV = { OPENROUTER_API_KEY: 'sk-or-test-fake', ACCESS_CODE: '훈련2580', OPENROUTER_MODELS: 'first/model,second/model' };
const PRD_TEXT = 'A는 주말에는 주간이 좋대요.\nB는 주 비 주 비 주 야 비 흐름을 좋아해요.\nC는 10/3에는 꼭 쉬고 싶어요.\n' +
  'D는 야간 위주로 서고 싶어요.\nE는 월요일 야간은 가능하면 피하고 싶대요.\nF는 평일 주간만 원해요.';
const FAKE_RULES = {
  rules: [
    { person: 'A', type: 'day_shift', days: '주말', shift: '주', want: 'prefer', strength: '보통', quote: 'A는 주말에는 주간이 좋대요' },
    { person: 'B', type: 'pattern', sequence: ['주', '비', '주', '비', '주', '야', '비'], strength: '보통', quote: '주 비 주 비 주 야 비 흐름' },
    { person: 'C', type: 'date_shift', dates: ['2026-10-03'], shift: '근무', want: 'avoid', strength: '강함', quote: '10/3에는 꼭 쉬고 싶어요' },
    { person: 'D', type: 'ratio', shift: '야', level: 'mostly', strength: '보통', quote: '야간 위주로 서고 싶어요' },
    { person: 'E', type: 'day_shift', days: ['월'], shift: '야', want: 'avoid', strength: '약함', quote: '월요일 야간은 가능하면 피하고 싶대요' },
  ],
  unparsed: [{ text: 'F는 평일 주간만 원해요.', reason: '인원 목록에 없는 이름이에요 (F). 설정 탭의 이름과 똑같이 써 주세요.' }],
};

// 가짜 OpenRouter: 첫 모델은 "없어진 모델"(404), 둘째 모델이 답한다 → 다음 모델로 넘어가기까지 화면에서 확인
const openRouterCalls = [];
async function fakeOpenRouter(url, init) {
  const sent = JSON.parse(init.body);
  openRouterCalls.push(sent.model);
  if (sent.model === 'first/model') return new Response('{"error":{"message":"No endpoints found","code":404}}', { status: 404 });
  const isSummary = sent.messages.length === 2;
  const content = isSummary
    ? 'A~E 다섯 명의 선호도 규칙 대부분을 지켰어요. 어긋난 규칙은 위로휴가 목표·근무 개수·야야 같은 더 중요한 조건이 선호도보다 먼저예요.'
    : '```json\n' + JSON.stringify(FAKE_RULES) + '\n```';
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

const handlers = {};
for (const name of ['health', 'preferences', 'summary']) {
  handlers[name] = createHandler(name, { env: ENV, fetchImpl: fakeOpenRouter, log: () => {} });
}

// 저장소 맨 위를 정적 사이트로 (Vercel과 같음: / → index.html)
function startStatic() {
  const server = http.createServer((req, res) => {
    const file = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(fs.readFileSync(full));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { chromium } = loadPlaywright();
  const server = await startStatic();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('dialog', (dialog) => dialog.accept());

  // Supabase(클라우드 저장)는 이 시험과 상관없으니 "저장된 것 없음 / 저장 성공"으로 가짜 답
  await page.route('**/rest/v1/rpc/**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: route.request().url().includes('load_roster') ? 'null' : 'true' }));
  // /api/* → 진짜 api/ 함수 코드 (OpenRouter만 가짜)
  await page.route(`${base}/api/**`, async (route) => {
    const req = route.request();
    const name = new URL(req.url()).pathname.replace('/api/', '');
    const headers = { ...req.headers(), 'x-forwarded-for': '10.1.2.3' };
    const request = new Request(req.url(), { method: req.method(), headers, body: req.method() === 'POST' ? req.postData() : undefined });
    const response = await handlers[name](request);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });

  await page.goto(base + '/');
  // 기간을 PRD 예시와 같게 (2026-09-28부터 4주)
  await page.click('button[data-tab="tab-settings"]');
  await page.fill('#start-date', '2026-09-28');
  await page.dispatchEvent('#start-date', 'change');

  await page.click('button[data-tab="tab-prefs"]');
  await page.waitForSelector('#ai-status[data-state="needcode"]');
  check('Vercel 모드 감지: 접근 코드 칸이 보임', await page.isVisible('#ai-code-form'));
  await page.screenshot({ path: path.join(SHOTS, '1-access-code.png'), fullPage: false });

  await page.fill('#ai-code', '틀린코드');
  await page.click('#ai-code-save');
  await page.waitForFunction(() => document.getElementById('ai-status-text').textContent.includes('맞지 않아요'));
  check('틀린 접근 코드는 안내가 뜨고 AI 버튼이 막힘', await page.isDisabled('#pref-parse'));
  await page.fill('#ai-code', '훈련2580');
  await page.click('#ai-code-save');
  await page.waitForSelector('#ai-status[data-state="ok"]');
  const status = await page.textContent('#ai-status-text');
  check('맞는 접근 코드 → AI 연결됨', status.includes('AI 연결됨') && status.includes('first/model'), status.trim());

  await page.fill('#pref-text', PRD_TEXT);
  await page.click('#pref-parse');
  await page.waitForFunction(() => /규칙 \d+개를 만들었어요/.test(document.getElementById('pref-parse-out').textContent), null, { timeout: 15000 });
  const parseOut = await page.textContent('#pref-parse-out');
  check('AI 해석 → 규칙 5개', parseOut.includes('규칙 5개를 만들었어요'), parseOut.trim().slice(0, 80));
  check('첫 모델이 없어서 다음 모델로 해석했다고 알려 줌', parseOut.includes('second/model'));
  const unparsed = await page.textContent('#pref-unparsed');
  check('바꾸지 못한 문장에 F', unparsed.includes('F는 평일 주간만'));
  await page.screenshot({ path: path.join(SHOTS, '2-rules.png'), fullPage: true });

  await page.click('button[data-tab="tab-roster"]');
  await page.click('#auto-gen');
  await page.waitForSelector('#auto-overlay', { state: 'hidden', timeout: 90000 });
  await page.waitForSelector('#pref-result-card:not([hidden])', { timeout: 10000 });
  const result = await page.textContent('#pref-result-list');
  check('자동 생성 후 선호도 반영 결과가 보임 (사람별)', ['A', 'B', 'C', 'D', 'E'].every((n) => result.includes(n)), result.trim().slice(0, 60));
  const emptyCells = await page.evaluate(() => (typeof countEmptySlots === 'function'
    ? countEmptySlots(state.people, state.shifts, buildPeriodDates(state.startDate, state.weeks)) : -1));
  check('빈 주·야 칸 0칸 (규칙 엔진이 근무표를 다 채움)', emptyCells === 0, `빈 칸 ${emptyCells}`);
  await page.click('#pref-explain-btn');
  await page.waitForSelector('#pref-explain-out .ai-summary', { timeout: 15000 });
  check('AI 결과 설명이 보임', (await page.textContent('#pref-explain-out')).includes('더 중요한 조건'));
  await page.screenshot({ path: path.join(SHOTS, '3-roster-result.png'), fullPage: true });

  const scroll = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check('휴대폰 폭에서 가로 스크롤 없음', scroll[0] <= scroll[1], `${scroll[0]} ≤ ${scroll[1]}`);
  const stored = await page.evaluate(() => [localStorage.getItem('timetable-ai-access-code'),
    (localStorage.getItem('timetable-data-v1') || '').includes('훈련2580')]);
  check('접근 코드는 이 브라우저에만 (근무표 저장 데이터에는 없음)', stored[0] === '훈련2580' && stored[1] === false);
  check('OpenRouter에는 해석·설명 요청만 (첫 모델 404 → 다음 모델)',
    JSON.stringify(openRouterCalls) === JSON.stringify(['first/model', 'second/model', 'first/model', 'second/model']), openRouterCalls.join(', '));
  check('콘솔 오류 없음', consoleErrors.filter((e) => !/status of 40[14]/.test(e)).length === 0, consoleErrors.join(' | '));

  await browser.close();
  server.close();
  console.log(`스크린샷: ${SHOTS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
