// GET /api/health — AI를 쓸 준비가 됐는지 (키·접근 코드 설정·보낸 접근 코드가 맞는지). OpenRouter는 부르지 않는다.
// 실제 처리는 _lib/http.js. (밑줄로 시작하는 _lib 폴더는 Vercel이 주소로 만들지 않는다)
import { vercelFunction } from './_lib/http.js';

export const config = { maxDuration: 10 };

export default vercelFunction('health');
