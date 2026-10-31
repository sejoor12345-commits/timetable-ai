// POST /api/summary — 사람별 선호도 결과(숫자) → AI의 짧은 한국어 설명. 근무표 자체는 받지 않는다.
// 실제 처리는 _lib/http.js, 프롬프트는 _lib/preferences.js (timetable_server/preferences.py와 같은 내용).
import { vercelFunction } from './_lib/http.js';

export const config = { maxDuration: 60 };

export default vercelFunction('summary');
