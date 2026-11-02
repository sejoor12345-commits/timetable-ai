// 계산 엔진 벤치마크: 자동 생성 근무표의 필수 조건 위반·위로휴가 달성·선호도 반영을 숫자로 잰다.
// 실행: node tests/bench/bench-engine.mjs            (기본: 시나리오 3개 × 씨앗 30개 × 규칙 없음/있음)
//       node tests/bench/bench-engine.mjs --seeds 5  (빠르게 확인)
//       --real-clock  : 앱처럼 진짜 시계로 시간 제한 (기계 속도에 따라 결과가 달라짐)
//       --workers N   : 동시에 돌릴 작업 수 (기본: CPU 수, 최대 4)
//       --json 파일    : 근무표별 결과를 JSON으로 저장
// CI에는 넣지 않는다 (몇 분 걸림). 결과 정리는 docs/BENCHMARK.md.
//
// 엔진은 tests/run-engine-tests.mjs 와 같은 방식으로 index.html 의 '계산 로직' 부분만 꺼내 Node vm 에서 돌린다.
// 이름은 가명 A~E 만 쓴다.
//
// 결정적(같은 씨앗 → 같은 근무표)으로 만들기 위해 기본은 '가상 시계'를 쓴다:
// createAutoFiller 의 시간 제한(앱과 같은 4700ms, 2000ms 동안 나아지지 않으면 멈춤)을 진짜 시간 대신
// '벌점 계산 횟수 ÷ EVALS_PER_MS' 로 잰다. EVALS_PER_MS 는 이 컨테이너에서 잰 값(벌점 계산 속도)이라
// 이 기계에서 앱이 5초 동안 하는 만큼의 탐색을 어느 기계에서나 똑같이 한다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { loadEngineSource } from '../run-engine-tests.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..', '..');

// 가상 시계: 벌점 계산(computePenalty) 몇 번을 1ms 로 볼지. 이 컨테이너(Node 22)에서 5명·4주 자동 생성 중
// 잰 속도 (--calibrate 로 다시 잴 수 있음)
const EVALS_PER_MS = 1.2;
const APP_OPTIONS = { timeLimitMs: 4700, patienceMs: 2000 }; // index.html 의 createAutoFiller 기본값과 같음
const START = '2026-11-02'; // 월요일

// --- 시나리오 (가명 A~E) ---
// i: 기간 안 날짜 번호 → 'YYYY-MM-DD'
function scenarios(engine) {
  const d = (weeks) => engine.buildPeriodDates(START, weeks).map((x) => x.key);
  const d4 = d(4);
  const d5 = d(5);
  return [
    {
      id: 'S1', name: '5명·4주 (목표 3·3·2·2·2, 일정 없음)', weeks: 4,
      people: [
        { id: 1, name: 'A', target: 3 }, { id: 2, name: 'B', target: 3 }, { id: 3, name: 'C', target: 2 },
        { id: 4, name: 'D', target: 2 }, { id: 5, name: 'E', target: 2 }
      ],
      rules: {
        1: [{ type: 'day_shift', days: '주말', shift: '주', want: 'prefer', strength: '보통', quote: 'A는 주말 주간 선호' }],
        2: [{ type: 'day_shift', days: ['수'], shift: '야', want: 'avoid', strength: '보통', quote: 'B는 수요일 야간 피하고 싶음' }],
        3: [{ type: 'pattern', sequence: ['주', '비', '주', '비', '주', '야', '비'], strength: '보통', quote: 'C는 주 비 주 비 주 야 비 흐름 선호' }],
        4: [{ type: 'ratio', shift: '야', level: 'mostly', strength: '보통', quote: 'D는 야간 위주로' }],
        5: [{ type: 'date_shift', dates: [d4[18], d4[19]], shift: '근무', want: 'avoid', strength: '강함', quote: 'E는 11/20·11/21 근무 빼 주세요' }]
      }
    },
    {
      id: 'S2', name: '4명·4주 + D 휴가 5일 (목표 3·3·3·2)', weeks: 4,
      people: [
        { id: 1, name: 'A', target: 3 }, { id: 2, name: 'B', target: 3 }, { id: 3, name: 'C', target: 3 },
        { id: 4, name: 'D', target: 2, leaves: [{ start: d4[9], end: d4[13] }] }
      ],
      rules: {
        1: [{ type: 'day_shift', days: '주말', shift: '주', want: 'prefer', strength: '보통', quote: 'A는 주말 주간 선호' },
          { type: 'date_shift', dates: [d4[20]], shift: '근무', want: 'avoid', strength: '강함', quote: 'A는 11/22 근무 빼 주세요' }],
        2: [{ type: 'day_shift', days: ['수'], shift: '야', want: 'avoid', strength: '보통', quote: 'B는 수요일 야간 피하고 싶음' }],
        3: [{ type: 'pattern', sequence: ['주', '비', '주', '비', '주', '야', '비'], strength: '보통', quote: 'C는 주 비 주 비 주 야 비 흐름 선호' }],
        4: [{ type: 'ratio', shift: '야', level: 'mostly', strength: '보통', quote: 'D는 야간 위주로' }]
      }
    },
    {
      id: 'S3', name: '5명·5주 + 신병 견습·외출·면회 (목표 3·3·3·2, E 신병)', weeks: 5,
      people: [
        { id: 1, name: 'A', target: 3, outings: [{ date: d5[5], type: '8h' }] },
        { id: 2, name: 'B', target: 3, outings: [{ date: d5[12], type: '면회' }] },
        { id: 3, name: 'C', target: 3, outings: [{ date: d5[17], type: '4h' }] },
        { id: 4, name: 'D', target: 2 },
        { id: 5, name: 'E', target: 1, recruit: true, joinDate: d5[1], recruitShifts: 10, training: { day: 2, night: 1 } }
      ],
      rules: {
        1: [{ type: 'day_shift', days: '주말', shift: '주', want: 'prefer', strength: '보통', quote: 'A는 주말 주간 선호' }],
        2: [{ type: 'day_shift', days: ['수'], shift: '야', want: 'avoid', strength: '보통', quote: 'B는 수요일 야간 피하고 싶음' }],
        3: [{ type: 'pattern', sequence: ['주', '비', '주', '비', '주', '야', '비'], strength: '보통', quote: 'C는 주 비 주 비 주 야 비 흐름 선호' }],
        4: [{ type: 'ratio', shift: '야', level: 'mostly', strength: '보통', quote: 'D는 야간 위주로' },
          { type: 'date_shift', dates: [d5[25], d5[26]], shift: '근무', want: 'avoid', strength: '강함', quote: 'D는 11/27·11/28 근무 빼 주세요' }]
      }
    }
  ];
}

// --- 엔진 불러오기 ---
function loadEngine() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { engine } = loadEngineSource(html);
  const context = vm.createContext({ console, TextEncoder, TextDecoder, btoa, atob, Math, Date });
  vm.runInContext(engine, context, { filename: 'index.html' });
  // 벌점 계산 횟수 세기 (가상 시계용). 함수 선언은 전역이라 자동 생성기 안의 호출도 이 함수로 감
  vm.runInContext('var __evals = 0; var __cp = computePenalty;' +
    'computePenalty = function () { __evals++; return __cp.apply(this, arguments); };', context);
  return context;
}

// 테스트(runTests)와 같은 고정 씨앗 난수 (mulberry32)
function seeded(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withPrefs(people, rules) {
  return people.map((p) => Object.assign({}, p, { prefs: rules[p.id] || [] }));
}

// 근무표 하나 만들고 재기
function runJob(E, sc, seed, withRules, realClock) {
  const dates = E.buildPeriodDates(START, sc.weeks);
  const ruled = withPrefs(sc.people, sc.rules);
  const genPeople = withRules ? ruled : sc.people.map((p) => Object.assign({}, p));
  let nowCalls = 0;
  const startEvals = E.__evals;
  const virtualNow = () => (E.__evals - startEvals) / EVALS_PER_MS + (nowCalls++) * 0.0001;
  const options = Object.assign({ random: seeded(seed) }, APP_OPTIONS, realClock ? {} : { now: virtualNow });
  const t0 = performance.now();
  const filler = E.createAutoFiller(genPeople, {}, dates, null, {}, options);
  let st;
  do { st = filler.step(50); } while (!st.done);
  const res = filler.result();
  const wallMs = performance.now() - t0;
  if (!res.ok) return { scenario: sc.id, seed, withRules, ok: false, message: res.message, wallMs };

  const shifts = E.applyAssignments({}, res.assignments);
  const keys = dates.map((x) => x.key);

  // 필수 조건(빨간색, error) 위반: 사람·날짜 칸 + 인원(주간·야간 1명이 아닌 칸)
  const viol = E.findViolations(genPeople, shifts, dates, null);
  let errorCells = 0;
  const errorReasons = {};
  for (const pid of Object.keys(viol.cells)) {
    for (const k of Object.keys(viol.cells[pid])) {
      const errs = viol.cells[pid][k].filter((v) => v.level === 'error');
      if (errs.length) errorCells++;
      errs.forEach((v) => { errorReasons[v.reason] = (errorReasons[v.reason] || 0) + 1; });
    }
  }
  let staffErrors = 0;
  for (const k of keys) staffErrors += viol.staff[k].day.length + viol.staff[k].night.length;
  const emptySlots = E.countEmptySlots(genPeople, shifts, dates);

  // 규칙이 있는 사람 데이터로 벌점·선호도를 다시 계산 (규칙 없이 만든 근무표도 같은 규칙으로 채점)
  const pen = E.computePenalty(ruled, shifts, dates, null, {});
  const report = E.preferenceReport(ruled, shifts, dates, null, {});
  const rules = [];
  report.forEach((entry) => entry.rules.forEach((r) => {
    if (r.status === 'off' || r.status === 'outside') return;
    rules.push({ person: sc.people.find((p) => p.id === entry.id).name, label: r.label, status: r.status, misses: r.misses });
  }));

  // 위로휴가 목표 (사람별)
  const targets = sc.people.map((p) => {
    const earned = E.countLeave(E.weeklyHours(shifts[p.id] || {}, dates));
    return { name: p.name, target: p.target || 0, earned, hit: earned >= (p.target || 0) };
  });
  // 근무 개수 (일반 주·야, 신병은 견습 포함)
  const counts = sc.people.map((p) => {
    const c = E.countShiftTypes(shifts[p.id] || {}, dates);
    const t = E.countTraining(shifts[p.id] || {}, dates);
    return { name: p.name, target: p.target, recruit: Boolean(p.recruit), day: c.day, night: c.night, total: c.day + c.night + t.day + t.night };
  });
  const spreadBy = (target) => {
    const g = counts.filter((c) => !c.recruit && c.target === target).map((c) => c.total);
    return g.length > 1 ? Math.max(...g) - Math.min(...g) : 0;
  };

  return {
    scenario: sc.id, seed, withRules, ok: true, wallMs: Math.round(wallMs), tried: res.tried,
    errorCells, staffErrors, emptySlots, errorReasons,
    yaya: pen.yaya, jujuju: pen.jujuju, flowBreaks: pen.flowBreaks,
    shiftGap: pen.shiftGap.reduce((a, t) => a + t.gap, 0),
    spread3: spreadBy(3), spread2: spreadBy(2),
    targets, counts,
    prefKept: report.reduce((a, e) => a + e.kept, 0), prefTotal: report.reduce((a, e) => a + e.total, 0),
    prefMisses: rules.reduce((a, r) => a + r.misses, 0), rules,
    total: pen.total
  };
}

// --- 일꾼(worker) ---
if (!isMainThread) {
  const E = loadEngine();
  const list = scenarios(E);
  parentPort.on('message', (job) => {
    if (job === null) { process.exit(0); }
    const sc = list.find((s) => s.id === job.scenario);
    parentPort.postMessage(runJob(E, sc, job.seed, job.withRules, job.realClock));
  });
}

// --- 묶어서 정리 ---
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '-'; }
function summarize(results) {
  const ok = results.filter((r) => r.ok);
  const people = ok.flatMap((r) => r.targets);
  const wall = ok.map((r) => r.wallMs).sort((a, b) => a - b);
  const ruleStats = {};
  ok.forEach((r) => r.rules.forEach((x) => {
    const key = x.person + ': ' + x.label;
    const s = ruleStats[key] || (ruleStats[key] = { kept: 0, n: 0, misses: 0 });
    s.n++; s.misses += x.misses; if (x.status === 'kept') s.kept++;
  }));
  return {
    runs: results.length, failed: results.length - ok.length,
    hard: ok.reduce((a, r) => a + r.errorCells + r.staffErrors, 0),
    empty: ok.reduce((a, r) => a + r.emptySlots, 0),
    yayaRosters: ok.filter((r) => r.yaya > 0).length, yayaTotal: ok.reduce((a, r) => a + r.yaya, 0),
    targetHit: people.filter((t) => t.hit).length, targetN: people.length,
    allTargetsRosters: ok.filter((r) => r.targets.every((t) => t.hit)).length,
    shiftGapMean: mean(ok.map((r) => r.shiftGap)), shiftGapRosters: ok.filter((r) => r.shiftGap > 0).length,
    spread3Max: Math.max(0, ...ok.map((r) => r.spread3)), spread2Max: Math.max(0, ...ok.map((r) => r.spread2)),
    prefKept: ok.reduce((a, r) => a + r.prefKept, 0), prefTotal: ok.reduce((a, r) => a + r.prefTotal, 0),
    prefMissesMean: mean(ok.map((r) => r.prefMisses)),
    wallMean: mean(wall), wallP50: wall[Math.floor(wall.length / 2)] || 0, wallMax: wall[wall.length - 1] || 0,
    triedMean: mean(ok.map((r) => r.tried)),
    ruleStats
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : args[i + 1]; };
  const seeds = Number(opt('--seeds', 30));
  const realClock = args.includes('--real-clock');
  const workers = Math.max(1, Math.min(Number(opt('--workers', Math.min(4, os.cpus().length))), 16));
  const jsonOut = opt('--json', null);

  if (args.includes('--calibrate')) {
    // 진짜 시계로 S1 근무표 3개를 만들며 벌점 계산 속도(회/ms)를 잼
    const E = loadEngine();
    const sc = scenarios(E)[0];
    for (let s = 1; s <= 3; s++) {
      const before = E.__evals;
      const t0 = performance.now();
      runJob(E, sc, s, false, true);
      console.log(`seed ${s}: ${((E.__evals - before) / (performance.now() - t0)).toFixed(2)} 회/ms`);
    }
    return;
  }

  const E = loadEngine();
  const list = scenarios(E);
  const jobs = [];
  for (const sc of list) for (const withRules of [false, true]) for (let s = 1; s <= seeds; s++) {
    jobs.push({ scenario: sc.id, seed: s, withRules, realClock });
  }
  const started = Date.now();
  const results = [];
  await new Promise((resolve, reject) => {
    let next = 0;
    const pool = [];
    for (let w = 0; w < Math.min(workers, jobs.length); w++) {
      const worker = new Worker(HERE);
      pool.push(worker);
      const feed = () => {
        if (next < jobs.length) { worker.postMessage(jobs[next++]); } else worker.postMessage(null);
      };
      worker.on('message', (r) => {
        results.push(r);
        if (process.stderr.isTTY) process.stderr.write(`\r${results.length}/${jobs.length}`);
        if (results.length === jobs.length) { pool.forEach((x) => x.terminate()); resolve(); }
        else feed();
      });
      worker.on('error', reject);
      feed();
    }
  });
  if (process.stderr.isTTY) process.stderr.write('\n');

  const head = `씨앗 ${seeds}개 · ${realClock ? '진짜 시계' : `가상 시계(${EVALS_PER_MS}회/ms)`} · 일꾼 ${workers}개 · ` +
    `전체 ${((Date.now() - started) / 1000).toFixed(0)}초 · Node ${process.version} · ${os.cpus()[0].model}`;
  console.log(head);
  const out = { meta: { seeds, realClock, evalsPerMs: EVALS_PER_MS, workers, node: process.version, cpu: os.cpus()[0].model }, scenarios: {} };
  for (const sc of list) {
    const off = summarize(results.filter((r) => r.scenario === sc.id && !r.withRules));
    const on = summarize(results.filter((r) => r.scenario === sc.id && r.withRules));
    out.scenarios[sc.id] = { name: sc.name, off, on };
    console.log(`\n## ${sc.id} ${sc.name}`);
    console.log('| 항목 | 규칙 없음 | 규칙 있음 |');
    console.log('|---|---|---|');
    const row = (label, f) => console.log(`| ${label} | ${f(off)} | ${f(on)} |`);
    row('근무표 수 (실패)', (s) => `${s.runs} (${s.failed})`);
    row('필수 조건 위반 (칸 합)', (s) => s.hard);
    row('빈 칸 (합)', (s) => s.empty);
    row('야야가 있는 근무표', (s) => `${s.yayaRosters}/${s.runs - s.failed} (야야 합 ${s.yayaTotal})`);
    row('위로휴가 목표 달성 (사람)', (s) => `${s.targetHit}/${s.targetN} (${pct(s.targetHit, s.targetN)})`);
    row('목표 전원 달성 근무표', (s) => `${s.allTargetsRosters}/${s.runs - s.failed}`);
    row('기준 근무 개수 벗어남 (평균, 벗어난 근무표)', (s) => `${s.shiftGapMean.toFixed(2)} (${s.shiftGapRosters})`);
    row('같은 목표끼리 근무 개수 차이 최대 (목표3/목표2)', (s) => `${s.spread3Max} / ${s.spread2Max}`);
    row('선호 규칙 지킴', (s) => `${s.prefKept}/${s.prefTotal} (${pct(s.prefKept, s.prefTotal)})`);
    row('선호 어긋남 평균 (근무표당)', (s) => s.prefMissesMean.toFixed(2));
    row('시간 (평균 / 중앙 / 최대 ms)', (s) => `${s.wallMean.toFixed(0)} / ${s.wallP50} / ${s.wallMax}`);
    row('비교한 근무표 수 평균', (s) => s.triedMean.toFixed(1));
    console.log('\n| 규칙 | 규칙 없음: 지킴 (어긋남 평균) | 규칙 있음: 지킴 (어긋남 평균) |');
    console.log('|---|---|---|');
    for (const key of Object.keys(on.ruleStats)) {
      const a = off.ruleStats[key] || { kept: 0, n: 0, misses: 0 };
      const b = on.ruleStats[key];
      console.log(`| ${key} | ${a.kept}/${a.n} (${(a.misses / (a.n || 1)).toFixed(2)}) | ${b.kept}/${b.n} (${(b.misses / (b.n || 1)).toFixed(2)}) |`);
    }
    const failed = results.filter((r) => r.scenario === sc.id && !r.ok);
    failed.slice(0, 3).forEach((r) => console.log(`실패 예: seed ${r.seed} ${r.withRules ? '규칙 있음' : '규칙 없음'}: ${r.message}`));
    const reasons = {};
    results.filter((r) => r.scenario === sc.id && r.ok).forEach((r) => Object.entries(r.errorReasons).forEach(([k, v]) => { reasons[k] = (reasons[k] || 0) + v; }));
    if (Object.keys(reasons).length) console.log('필수 조건 위반 이유:', reasons);
  }
  if (jsonOut) {
    out.results = results.sort((a, b) => (a.scenario + a.withRules + a.seed).localeCompare(b.scenario + b.withRules + b.seed));
    fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
    console.log('\nJSON:', jsonOut);
  }
}

if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === HERE) main();
