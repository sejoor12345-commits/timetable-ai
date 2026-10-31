// POST /api/preferences — 선호도 글 → 선호도 규칙 4종류 (AI 해석 + 검사). 근무표는 화면의 규칙 엔진이 짠다.
// 실제 처리는 _lib/http.js, 프롬프트와 검사는 _lib/preferences.js (timetable_server/preferences.py와 같은 내용).
import { vercelFunction } from './_lib/http.js';

// Vercel 무료(Hobby) 요금제에서도 배포가 되는 최대 시간. AI 전체 시간은 이 안에 끝나도록 55초로 잰다.
export const config = { maxDuration: 60 };

export default vercelFunction('preferences');
