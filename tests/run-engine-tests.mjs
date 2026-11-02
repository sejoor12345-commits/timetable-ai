// index.html 안의 runTests()(근무표 계산 로직 테스트, 브라우저 콘솔용)를 Node에서 그대로 돌린다.
// 실행: node tests/run-engine-tests.mjs   (-v 를 붙이면 통과한 테스트 이름도 모두 보여 줌)
//
// index.html은 파일 하나로 두어야 하므로(더블클릭으로 열어도 동작) 코드를 다른 파일로 옮기지 않고,
// 첫 번째 <script>의 "계산 로직" 부분(화면 코드 표시 앞까지)과 두 번째 <script>(runTests)만 꺼내서 실행한다.
// 계산 로직은 화면(document)을 건드리지 않으므로 브라우저 없이 돌아간다.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('-v');
const UI_MARKER = /\/\* =+\s*\n\s*화면 코드/;

export function loadEngineSource(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (scripts.length < 2) throw new Error('index.html에서 <script> 두 개(계산·화면 코드, 테스트)를 찾지 못했어요.');
  const marker = scripts[0].search(UI_MARKER);
  if (marker === -1) throw new Error("index.html에서 '화면 코드' 표시를 찾지 못했어요. 계산 로직과 화면 코드 사이 주석을 지우지 마세요.");
  return { engine: scripts[0].slice(0, marker), tests: scripts[1] };
}

function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { engine, tests } = loadEngineSource(html);
  const lines = [];
  const quietConsole = {
    log: (...args) => lines.push({ type: 'log', text: args.join(' ') }),
    error: (...args) => lines.push({ type: 'error', text: args.join(' ') }),
    warn: (...args) => lines.push({ type: 'warn', text: args.join(' ') }),
  };
  // 브라우저에 있는 것 중 계산 로직이 쓰는 것만 넣는다 (document·localStorage는 없음 = 계산이 화면을 건드리면 바로 실패)
  const context = vm.createContext({ console: quietConsole, TextEncoder, TextDecoder, btoa, atob, Math, Date });
  const started = Date.now();
  vm.runInContext(engine + '\n' + tests, context, { filename: 'index.html' });
  const passed = vm.runInContext('runTests()', context);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  for (const line of lines) {
    const failedLine = line.type === 'error' || line.text.startsWith('❌');
    if (VERBOSE || failedLine || line.text.startsWith('결과:') || line.text.includes('(참고)')) {
      (failedLine ? console.error : console.log)(line.text);
    }
  }
  const summary = lines.map((l) => l.text).find((t) => t.startsWith('결과:'));
  if (!summary) {
    console.error('runTests()가 결과 줄을 남기지 않았어요.');
    process.exit(1);
  }
  console.log(`계산 로직 테스트 시간: ${seconds}초`);
  process.exit(passed === true ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
