"""근무표 작성기(index.html)를 Colab에서 여는 작은 서버 (PRD_step1 F4·F5·F6).

- GET  /                 → index.html (요청마다 새로 읽어서 보냄. git pull 뒤 새로 고침만 하면 새 화면)
- GET  /api/health       → AI를 쓸 준비가 됐는지 (OpenRouter는 부르지 않음. 빠르고 무료)
- POST /api/preferences  → 선호도 글 → 선호도 규칙 (AI)
- POST /api/summary      → 사람별 선호도 결과 → 짧은 설명 (AI)

실행: python timetable_server/server.py  (어느 폴더에서 실행해도 됨. 포트는 환경 변수 TIMETABLE_PORT, 기본 8765)
서버는 아무것도 저장하지 않는다. API 키와 선호도 글은 화면·로그 어디에도 남기지 않는다.
AI 요청(프롬프트·OpenRouter 호출)은 AI 통합 담당의 preferences.py / openrouter_client.py가 맡고, 이 파일은
주소 나누기·입력 검사·응답 모양만 맡는다.
"""

import datetime
import json
import os
import re
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HERE = str(Path(__file__).resolve().parent)
if HERE not in sys.path:  # 다른 방식으로 실행해도 같은 폴더의 AI 파일을 찾도록 (python server.py 면 이미 들어 있음)
    sys.path.append(HERE)

from openrouter_client import TEXT_MODEL, OpenRouterError, has_api_key  # noqa: E402 (위에서 경로를 먼저 정함)
from preferences import explain_result, parse_preferences  # noqa: E402

HOST = "0.0.0.0"  # Colab 통로가 확실히 닿게 (Colab 가상 머신은 Colab 통로로만 열림)
DEFAULT_PORT = 8765
HTML_PATH = Path(__file__).resolve().parent.parent / "index.html"

MAX_BODY_BYTES = 20_000  # 요청 본문 최대 크기
TEXT_MAX = 2000          # 선호도 글 최대 글자 수
PEOPLE_MAX = 12          # 인원 최대 수
NAME_MAX = 20            # 이름 최대 글자 수
HOLIDAYS_MAX = 20        # 기간 안 휴일(공휴일·전투휴무) 최대 수
SUMMARY_RULES_MAX = 20   # 설명 요청: 사람마다 규칙 최대 수
LABEL_MAX = 60           # 설명 요청: 규칙 이름 최대 글자 수
NOTE_MAX = 80            # 설명 요청: 규칙 설명 최대 글자 수
SUMMARY_MAX = 600        # AI 설명 최대 글자 수 (넘으면 자름)

# 화면에 그대로 보여 줄 안내 문구 (무엇이 잘못됐는지 + 어떻게 하면 되는지)
NO_KEY_MESSAGE = "API 키가 없어요. Colab에서 키를 불러오는 셀(셀 2)을 실행한 다음, 서버를 켜는 셀(셀 3)도 다시 실행해 주세요."
READY_MESSAGE = "AI를 쓸 준비가 됐어요."
SERVER_ERROR_MESSAGE = (
    "서버에서 예상하지 못한 오류가 났어요. Colab에서 셀 3(서버 켜기)을 다시 실행해 주세요. "
    "계속되면 server.log 내용을 알려 주세요."
)
RELOAD_HINT = "새로 고침한 뒤 다시 시도해 주세요."

# AI 쪽 오류 코드(OpenRouterError.code) → HTTP 상태 코드. 여기에 없는 AI 오류는 502
AI_STATUS = {"ai_rate_limit": 429, "ai_timeout": 504, "no_key": 503}
AI_CODES = {"ai_rate_limit", "ai_auth", "ai_model", "ai_server", "ai_connect", "ai_bad_answer", "ai_empty", "ai_timeout", "no_key"}
AI_FALLBACK_MESSAGE = "AI 서버가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요."
AI_EMPTY_MESSAGE = "AI가 빈 답을 보냈어요. 다시 시도해 주세요."

DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ApiError(Exception):
    """화면에 보여 줄 오류 응답 {"ok": false, "code", "message"}와 HTTP 상태 코드."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def bad_request(message):
    return ApiError(400, "bad_request", message)


def log(line):
    """server.log로 모이는 기록 (Colab 셀 3이 이 프로그램의 출력을 server.log로 보냄).

    요청 주소·상태 코드·걸린 시간만 적는다. API 키와 선호도 글은 적지 않는다.
    """
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sys.stderr.write(f"{stamp} {line}\n")
    sys.stderr.flush()


# ---------- 입력 검사 ----------

def parse_date(value):
    """'YYYY-MM-DD' 글자 → date. 올바르지 않으면 None."""
    if not isinstance(value, str) or not DATE_PATTERN.match(value):
        return None
    try:
        return datetime.datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def is_count(value, low=0, high=100):
    """low~high 사이 정수인지 (True/False는 정수로 치지 않음)."""
    return type(value) is int and low <= value <= high


def has_control_char(text):
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in text)


def check_period(value):
    """기간 {"start": 월요일 'YYYY-MM-DD', "weeks": 4 | 5} → (시작 date, 주 수)."""
    if not isinstance(value, dict):
        raise bad_request(f"기간 정보가 없어요. {RELOAD_HINT}")
    start = parse_date(value.get("start"))
    if start is None or start.weekday() != 0:
        raise bad_request("기간 시작일이 올바르지 않아요. 설정 탭에서 시작일(월요일)을 확인해 주세요.")
    weeks = value.get("weeks")
    if type(weeks) is not int or weeks not in (4, 5):
        raise bad_request("기간은 4주 또는 5주여야 해요. 설정 탭에서 기간을 확인해 주세요.")
    return start, weeks


def check_name(name):
    """이름 하나 검사: 1~20자, 빈 이름·줄바꿈 같은 제어 글자 없음."""
    if not isinstance(name, str) or not name.strip():
        raise bad_request("이름이 빈 사람이 있어요. 설정 탭에서 이름을 넣어 주세요.")
    if len(name) > NAME_MAX:
        raise bad_request(f"이름은 {NAME_MAX}자까지 쓸 수 있어요 ({name[:NAME_MAX]}…). 설정 탭에서 이름을 줄여 주세요.")
    if has_control_char(name):
        raise bad_request("이름에 쓸 수 없는 글자(줄바꿈·탭 등)가 있어요. 설정 탭에서 이름을 고쳐 주세요.")
    return name


def check_people(value):
    """인원 이름 목록: 1~12명, 이름마다 1~20자, 같은 이름 없음."""
    if not isinstance(value, list) or not value:
        raise bad_request("인원이 없어요. 설정 탭에서 인원을 먼저 추가해 주세요.")
    if len(value) > PEOPLE_MAX:
        raise bad_request(f"인원은 {PEOPLE_MAX}명까지 보낼 수 있어요. (지금 {len(value)}명)")
    names = []
    for name in value:
        check_name(name)
        if name in names:
            raise bad_request(f"이름이 같은 사람이 있어요 ({name}). 설정 탭에서 이름을 서로 다르게 바꿔 주세요.")
        names.append(name)
    return names


def check_holidays(value, start, weeks):
    """기간 안의 공휴일·전투휴무 날짜 목록 (선택). 기간 밖 날짜와 토·일은 빼고 날짜순으로, 20개까지."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 100:
        raise bad_request(f"휴일 정보가 올바르지 않아요. {RELOAD_HINT}")
    end = start + datetime.timedelta(days=weeks * 7 - 1)
    days = set()
    for item in value:
        day = parse_date(item)
        if day is None:
            raise bad_request(f"휴일 날짜가 올바르지 않아요. {RELOAD_HINT}")
        if start <= day <= end and day.weekday() < 5:
            days.add(item)
    if len(days) > HOLIDAYS_MAX:
        raise bad_request(f"휴일은 기간 안에서 {HOLIDAYS_MAX}개까지 보낼 수 있어요. 설정 탭에서 휴일을 확인해 주세요.")
    return sorted(days)


def check_preferences_request(body):
    """POST /api/preferences 본문 검사 (F5). 결과: parse_preferences에 넘길 값."""
    text = body.get("text")
    text = text.strip() if isinstance(text, str) else ""
    if not text:
        raise bad_request("선호도 문장을 먼저 써 주세요.")
    if len(text) > TEXT_MAX:
        raise bad_request(f"선호도 글은 {TEXT_MAX}자까지 쓸 수 있어요. (지금 {len(text)}자)")
    people = check_people(body.get("people"))
    start, weeks = check_period(body.get("period"))
    holidays = check_holidays(body.get("holidays"), start, weeks)
    return {"text": text, "people": people, "start": start.isoformat(), "weeks": weeks, "holidays": holidays}


def check_summary_request(body):
    """POST /api/summary 본문 검사 (F6). 결과: 아는 필드만 남긴 깨끗한 사본 (explain_result에 넘김)."""
    start, weeks = check_period(body.get("period"))
    people = body.get("people")
    if people is None or people == []:
        raise bad_request("설명할 선호도 규칙이 없어요.")
    if not isinstance(people, list):
        raise bad_request(f"선호도 결과 모양이 올바르지 않아요. {RELOAD_HINT}")
    if len(people) > PEOPLE_MAX:
        raise bad_request(f"인원은 {PEOPLE_MAX}명까지 보낼 수 있어요. (지금 {len(people)}명)")

    clean_people = []
    rule_count = 0
    for person in people:
        if not isinstance(person, dict):
            raise bad_request(f"선호도 결과 모양이 올바르지 않아요. {RELOAD_HINT}")
        name = check_name(person.get("name"))
        kept, total = person.get("kept"), person.get("total")
        rules = person.get("rules")
        if not is_count(kept) or not is_count(total) or not isinstance(rules, list):
            raise bad_request(f"선호도 결과의 숫자가 올바르지 않아요 ({name}). {RELOAD_HINT}")
        if len(rules) > SUMMARY_RULES_MAX:
            raise bad_request(f"한 사람의 규칙은 {SUMMARY_RULES_MAX}개까지 보낼 수 있어요 ({name}).")
        clean_rules = []
        for rule in rules:
            if not isinstance(rule, dict):
                raise bad_request(f"선호도 결과 모양이 올바르지 않아요 ({name}). {RELOAD_HINT}")
            label, note = rule.get("label"), rule.get("note", "")
            if not isinstance(label, str) or not label.strip() or len(label) > LABEL_MAX:
                raise bad_request(f"규칙 이름은 1~{LABEL_MAX}자여야 해요 ({name}). {RELOAD_HINT}")
            if not isinstance(note, str) or len(note) > NOTE_MAX:
                raise bad_request(f"규칙 설명은 {NOTE_MAX}자까지예요 ({name}). {RELOAD_HINT}")
            if rule.get("strength") not in ("약함", "보통", "강함"):
                raise bad_request(f"규칙 강도가 올바르지 않아요 ({name}). {RELOAD_HINT}")
            if rule.get("status") not in ("kept", "missed", "impossible"):
                raise bad_request(f"규칙 상태가 올바르지 않아요 ({name}). {RELOAD_HINT}")
            if not is_count(rule.get("misses")) or not is_count(rule.get("checked")):
                raise bad_request(f"선호도 결과의 숫자가 올바르지 않아요 ({name}). {RELOAD_HINT}")
            clean_rules.append({
                "label": label, "strength": rule["strength"], "status": rule["status"],
                "misses": rule["misses"], "checked": rule["checked"], "note": note,
            })
        rule_count += len(clean_rules)
        clean_people.append({"name": name, "kept": kept, "total": total, "rules": clean_rules})
    if rule_count == 0:
        raise bad_request("설명할 선호도 규칙이 없어요.")

    context = body.get("context")
    if context is None:
        context = {}
    if not isinstance(context, dict):
        raise bad_request(f"선호도 결과 모양이 올바르지 않아요. {RELOAD_HINT}")
    clean_context = {}
    for key in ("targetShort", "shiftGap"):
        names = context.get(key, [])
        if not isinstance(names, list) or len(names) > PEOPLE_MAX:
            raise bad_request(f"선호도 결과 모양이 올바르지 않아요. {RELOAD_HINT}")
        clean_context[key] = [check_name(n) for n in names]
    for key in ("yaya", "emptySlots"):
        number = context.get(key, 0)
        if not is_count(number):
            raise bad_request(f"선호도 결과의 숫자가 올바르지 않아요. {RELOAD_HINT}")
        clean_context[key] = number

    return {
        "period": {"start": start.isoformat(), "weeks": weeks},
        "people": clean_people,
        "context": clean_context,
    }


def shorten_summary(text):
    """AI 설명을 600자 이내로. 넘으면 600자 안의 마지막 문장 끝에서 자르고, 문장 끝이 없으면 '…'을 붙임."""
    text = text.strip()
    if len(text) <= SUMMARY_MAX:
        return text
    head = text[:SUMMARY_MAX]
    end = max(head.rfind(mark) for mark in (". ", "! ", "? ", ".\n", "!\n", "?\n"))
    if end >= SUMMARY_MAX // 2:
        return head[:end + 1]
    return head[:SUMMARY_MAX - 1] + "…"


def ai_error_response(error):
    """OpenRouterError → ApiError. 메시지는 AI 통합 쪽이 만든 해요체 문구를 그대로 쓴다."""
    code = getattr(error, "code", None)
    if not isinstance(code, str) and len(error.args) > 1:
        code = error.args[1]
    if code not in AI_CODES:
        code = "ai_server"
    message = getattr(error, "message", None)
    if not isinstance(message, str) or not message.strip():
        message = str(error.args[0]) if error.args else ""
    if not message.strip():
        message = NO_KEY_MESSAGE if code == "no_key" else AI_FALLBACK_MESSAGE
    key = os.environ.get("OPENROUTER_API_KEY")
    if key and key in message:  # 혹시라도 키가 문구에 섞이면 가림
        message = message.replace(key, "(API 키)")
    return ApiError(AI_STATUS.get(code, 502), code, message)


def require_key():
    if not has_api_key():
        raise ApiError(503, "no_key", NO_KEY_MESSAGE)


# ---------- 요청 처리 ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "TimetableServer"
    sys_version = ""
    timeout = 30  # 본문이 다 오지 않고 멈춘 연결을 30초 뒤 끊음 (AI를 기다리는 시간과는 상관없음)

    # 주소별로 받는 방식과 처리 함수 이름
    ROUTES = {
        "/": {"GET": "send_page"},
        "/api/health": {"GET": "api_health"},
        "/api/preferences": {"POST": "api_preferences"},
        "/api/summary": {"POST": "api_summary"},
    }

    def do_GET(self):
        self.handle_request("GET")

    def do_POST(self):
        self.handle_request("POST")

    def do_PUT(self):
        self.handle_request("PUT")

    def do_DELETE(self):
        self.handle_request("DELETE")

    def do_PATCH(self):
        self.handle_request("PATCH")

    def handle_request(self, method):
        started = time.monotonic()
        path = urlsplit(self.path).path  # ?뒤(쿼리)는 보지 않음
        self.result_status = 0
        self.result_code = ""
        try:
            routes = self.ROUTES.get(path)
            if routes is None:
                raise ApiError(404, "not_found", "없는 주소예요.")
            if method not in routes:
                raise ApiError(405, "method_not_allowed", f"이 주소는 {'·'.join(routes)} 방식으로만 쓸 수 있어요.")
            getattr(self, routes[method])()
        except ApiError as error:
            self.send_json(error.status, {"ok": False, "code": error.code, "message": error.message})
        except Exception:  # 예상 못 한 오류: 트레이스는 로그에만 남기고, 화면에는 안내 문구만
            log("예상 못 한 오류:\n" + traceback.format_exc().rstrip())
            if not self.result_status:
                try:
                    self.send_json(500, {"ok": False, "code": "server_error", "message": SERVER_ERROR_MESSAGE})
                except OSError:
                    pass
        finally:
            elapsed = (time.monotonic() - started) * 1000
            code = f" {self.result_code}" if self.result_code else ""
            log(f"{method} {path[:100]} {self.result_status or '-'}{code} {elapsed:.0f}ms")

    # 기본 요청 기록은 끄고(handle_request가 대신 적음), 잘못된 요청 기록은 짧게만
    def log_request(self, code="-", size="-"):
        pass

    def log_message(self, format, *args):
        log("요청 오류: " + (format % args)[:200])

    # ---------- 응답 ----------

    def send_bytes(self, status, body, content_type):
        self.result_status = status
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, data):
        if not data.get("ok", True):
            self.result_code = data.get("code", "")
        # errors="replace": 요청에 반쪽짜리 이모지(\ud83d 같은 글자)가 섞여 와서 안내 문구에 들어가도
        # 답을 못 보내고 연결이 끊기지 않게, 그 글자만 ?로 바꿔서 보낸다
        body = json.dumps(data, ensure_ascii=False).encode("utf-8", errors="replace")
        self.send_bytes(status, body, "application/json; charset=utf-8")

    def read_json_body(self):
        """본문(JSON 객체)을 읽는다. 20,000바이트가 넘으면 413, JSON이 아니면 400."""
        length_text = self.headers.get("Content-Length")
        try:
            length = int(length_text)
            if length < 0:
                raise ValueError
        except (TypeError, ValueError):
            raise bad_request(f"보내는 내용이 없어요. {RELOAD_HINT}")
        if length > MAX_BODY_BYTES:
            # 보내던 내용을 조금 읽어서 버린 뒤 답해야 브라우저가 '연결 끊김' 대신 이 안내를 받는다
            remaining = min(length, 1_000_000)
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise ApiError(413, "too_large", "보내는 내용이 너무 커요. 선호도 글을 줄여 주세요.")
        raw = self.rfile.read(length)
        if len(raw) < length:
            raise bad_request("보내는 내용이 중간에 끊겼어요. 다시 시도해 주세요.")
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise bad_request(f"보내는 내용을 읽지 못했어요 (JSON 모양이 아니에요). {RELOAD_HINT}")
        if not isinstance(data, dict):
            raise bad_request(f"보내는 내용의 모양이 올바르지 않아요. {RELOAD_HINT}")
        return data

    # ---------- 주소별 처리 ----------

    def send_page(self):
        """GET / → index.html. 요청마다 새로 읽으므로 git pull 뒤 새로 고침만 하면 새 화면이 뜬다."""
        try:
            body = HTML_PATH.read_bytes()
        except OSError:
            log("index.html을 읽지 못함:\n" + traceback.format_exc().rstrip())
            message = "index.html 파일을 찾지 못했어요. Colab에서 셀 1(코드 받기)과 셀 3(서버 켜기)을 다시 실행해 주세요."
            self.send_bytes(500, message.encode("utf-8"), "text/plain; charset=utf-8")
            return
        self.send_bytes(200, body, "text/html; charset=utf-8")

    def api_health(self):
        """AI를 쓸 준비가 됐는지. OpenRouter는 부르지 않는다."""
        key = has_api_key()
        self.send_json(200, {
            "ok": True,
            "key": key,
            "model": TEXT_MODEL,
            "message": READY_MESSAGE if key else NO_KEY_MESSAGE,
        })

    def api_preferences(self):
        """선호도 글 → 선호도 규칙 (F5). 규칙이 0개여도 오류가 아니다."""
        request = check_preferences_request(self.read_json_body())
        require_key()
        try:
            result = parse_preferences(request["text"], request["people"], request["start"], request["weeks"],
                                       request["holidays"])
        except OpenRouterError as error:
            raise ai_error_response(error)
        rules = result.get("rules") if isinstance(result, dict) else None
        unparsed = result.get("unparsed") if isinstance(result, dict) else None
        if not isinstance(rules, list) or not isinstance(unparsed, list):
            raise RuntimeError("parse_preferences가 {rules, unparsed} 모양을 돌려주지 않음")
        self.send_json(200, {"ok": True, "rules": rules, "unparsed": unparsed})

    def api_summary(self):
        """사람별 선호도 결과 → AI의 짧은 설명 (F6). 근무표 자체는 받지 않는다."""
        report = check_summary_request(self.read_json_body())
        require_key()
        try:
            summary = explain_result(report)
        except OpenRouterError as error:
            raise ai_error_response(error)
        if not isinstance(summary, str) or not summary.strip():
            raise ApiError(502, "ai_empty", AI_EMPTY_MESSAGE)
        self.send_json(200, {"ok": True, "summary": shorten_summary(summary)})


def read_port():
    text = os.environ.get("TIMETABLE_PORT", "").strip()
    if not text:
        return DEFAULT_PORT
    if not text.isdigit() or not 1 <= int(text) <= 65535:
        print(f"TIMETABLE_PORT 값({text})이 올바르지 않아요. 1~65535 사이 숫자로 정하거나 지워 주세요.", flush=True)
        sys.exit(1)
    return int(text)


def main():
    port = read_port()
    try:
        server = ThreadingHTTPServer((HOST, port), Handler)
    except OSError as error:
        print(f"서버를 켜지 못했어요. 포트 {port}를 이미 쓰고 있을 수 있어요. "
              f"Colab에서 셀 3(기존 서버를 끄고 다시 켬)을 다시 실행해 주세요. ({error.strerror})", flush=True)
        sys.exit(1)
    server.daemon_threads = True  # 서버를 끌 때 처리 중인 AI 요청을 기다리지 않음
    print(f"서버 시작: http://localhost:{port}", flush=True)
    print(f"API 키: {'있음' if has_api_key() else '없음'}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
