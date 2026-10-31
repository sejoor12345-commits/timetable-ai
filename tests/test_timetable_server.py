"""Colab 서버(timetable_server/)를 가짜 OpenRouter로 시험한다. 실행: python -m pytest tests/

진짜 OpenRouter에는 요청을 보내지 않는다 (requests.post 를 바꿔 끼움). 테스트 이름·데이터는 A, B, C… 가명만 쓴다.
"""

import json
import threading
import urllib.error
import urllib.request

import pytest
import requests

import openrouter_client
import parity
import preferences
import server

KEY = "sk-or-test-not-a-real-key"
PRD_TEXT = json.loads(parity.INPUTS.read_text(encoding="utf-8"))["parse_messages"][0]["text"]
GOOD_ANSWER = json.loads(parity.INPUTS.read_text(encoding="utf-8"))["check_answer"][0]["data"]
PEOPLE = ["A", "B", "C", "D", "E"]


# ---------- 1. JavaScript(Vercel 함수)와 비교하는 기준 답이 최신인지 ----------

def test_parity_expected_is_up_to_date():
    """tests/fixtures/parity_expected.json 이 지금 Python 결과와 같아야 Node 테스트의 비교가 의미 있다.
    실패하면: Python 프롬프트·검사를 일부러 바꾼 것이면 `python tests/parity.py --write` 후 JS도 같게 고친다."""
    expected = json.loads(parity.EXPECTED.read_text(encoding="utf-8"))
    assert json.loads(json.dumps(parity.compute(), ensure_ascii=False)) == expected


# ---------- 2. openrouter_client.chat (가짜 requests.post) ----------

class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self.body = body.encode("utf-8") if isinstance(body, str) else body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def iter_content(self, chunk_size=1):
        for i in range(0, len(self.body), chunk_size):
            yield self.body[i:i + chunk_size]


def chat_body(content):
    return json.dumps({"choices": [{"message": {"content": content}}]})


@pytest.fixture
def fake_post(monkeypatch):
    """fake_post(reply) 로 requests.post 를 바꿔 끼운다. reply 는 FakeResponse 또는 던질 예외."""
    monkeypatch.setenv("OPENROUTER_API_KEY", KEY)
    calls = []

    def install(reply):
        def post(url, headers=None, json=None, timeout=None, stream=None):
            calls.append({"url": url, "headers": headers, "json": json})
            if isinstance(reply, Exception):
                raise reply
            return reply
        monkeypatch.setattr(openrouter_client.requests, "post", post)
        return calls
    return install


def test_chat_ok_strips_think_and_sends_key_only_in_header(fake_post):
    calls = fake_post(FakeResponse(200, chat_body("<think>생각</think> 답이에요 ")))
    assert openrouter_client.chat([{"role": "user", "content": "A"}], temperature=0.1) == "답이에요"
    assert calls[0]["headers"]["Authorization"] == f"Bearer {KEY}"
    assert calls[0]["json"]["model"] == openrouter_client.TEXT_MODEL
    assert calls[0]["json"]["temperature"] == 0.1
    assert KEY not in json.dumps(calls[0]["json"])


@pytest.mark.parametrize("status, code", [(401, "ai_auth"), (402, "ai_auth"), (404, "ai_model"), (408, "ai_timeout"),
                                          (429, "ai_rate_limit"), (500, "ai_server"), (502, "ai_server")])
def test_chat_status_errors(fake_post, status, code):
    fake_post(FakeResponse(status, json.dumps({"error": {"message": "Provider returned error"}})))
    with pytest.raises(openrouter_client.OpenRouterError) as info:
        openrouter_client.chat([])
    assert info.value.code == code
    if code == "ai_server":
        assert f"상태 코드 {status}: Provider returned error" in info.value.message


@pytest.mark.parametrize("body, code", [
    ("", "ai_empty"),
    (chat_body("<think>생각만</think>"), "ai_empty"),
    ("<html>proxy error</html>", "ai_server"),
    (json.dumps({"choices": []}), "ai_server"),
    (json.dumps({"error": {"message": "late", "code": 429}}), "ai_rate_limit"),
])
def test_chat_bad_bodies(fake_post, body, code):
    fake_post(FakeResponse(200, body))
    with pytest.raises(openrouter_client.OpenRouterError) as info:
        openrouter_client.chat([])
    assert info.value.code == code


@pytest.mark.parametrize("error, code", [
    (requests.ConnectTimeout("x"), "ai_connect"),
    (requests.ReadTimeout("x"), "ai_timeout"),
    (requests.ConnectionError("Read timed out."), "ai_timeout"),
    (requests.ConnectionError("Name or service not known"), "ai_connect"),
])
def test_chat_network_errors(fake_post, error, code):
    fake_post(error)
    with pytest.raises(openrouter_client.OpenRouterError) as info:
        openrouter_client.chat([])
    assert info.value.code == code


def test_chat_without_key(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(openrouter_client.OpenRouterError) as info:
        openrouter_client.chat([])
    assert info.value.code == "no_key"


# ---------- 3. preferences.parse_preferences (가짜 chat) ----------

def fake_chat(monkeypatch, answer):
    sent = []

    def chat(messages, temperature=0.3):
        sent.append((messages, temperature))
        return answer
    monkeypatch.setattr(preferences, "chat", chat)
    return sent


def test_parse_preferences_valid_json(monkeypatch):
    sent = fake_chat(monkeypatch, "```json\n" + json.dumps(GOOD_ANSWER, ensure_ascii=False) + "\n```")
    result = preferences.parse_preferences(PRD_TEXT, PEOPLE, "2026-09-28", 4, [])
    assert [rule["person"] for rule in result["rules"]] == PEOPLE
    assert len(result["unparsed"]) == 1
    messages, temperature = sent[0]
    assert temperature == preferences.PARSE_TEMPERATURE
    assert len(messages) == 4 and PRD_TEXT in messages[3]["content"]


def test_parse_preferences_invalid_json(monkeypatch):
    fake_chat(monkeypatch, "규칙을 만들 수 없어요")
    with pytest.raises(openrouter_client.OpenRouterError) as info:
        preferences.parse_preferences(PRD_TEXT, PEOPLE, "2026-09-28", 4, [])
    assert info.value.code == "ai_bad_answer"


def test_parse_preferences_schema_violations_go_to_unparsed(monkeypatch):
    answer = {"rules": [GOOD_ANSWER["rules"][0],
                        {"person": "Z", "type": "ratio", "shift": "주", "level": "only", "quote": "Z는 주간만"},
                        {"person": "B", "type": "pattern", "sequence": ["야", "야", "비"], "quote": "야야비"},
                        {"person": "C", "type": "roster", "quote": "근무표를 짜 줘"}]}
    fake_chat(monkeypatch, json.dumps(answer, ensure_ascii=False))
    result = preferences.parse_preferences(PRD_TEXT, PEOPLE, "2026-09-28", 4, [])
    assert len(result["rules"]) == 1
    reasons = [u["reason"] for u in result["unparsed"]]
    assert [r.split(" ")[0] for r in reasons] == ["인원", "야야가", "규칙"]


def test_explain_result_plain_text(monkeypatch):
    fake_chat(monkeypatch, "**전체** 결과예요.\n- A는 지켰어요.")
    assert preferences.explain_result({"people": []}) == "전체 결과예요. A는 지켰어요."


# ---------- 4. server.py (진짜 HTTP 서버를 잠깐 띄움, AI 함수는 가짜) ----------

@pytest.fixture
def api(monkeypatch, capsys):
    monkeypatch.setenv("OPENROUTER_API_KEY", KEY)
    state = {"parse": lambda *a: {"rules": GOOD_ANSWER["rules"], "unparsed": GOOD_ANSWER["unparsed"]},
             "explain": lambda report: "A는 주말 주간을 지켰어요."}
    monkeypatch.setattr(server, "parse_preferences", lambda *a: state["parse"](*a))
    monkeypatch.setattr(server, "explain_result", lambda report: state["explain"](report))
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def call(path, body=None, method=None, raw=None):
        data = raw if raw is not None else (json.dumps(body, ensure_ascii=False).encode() if body is not None else None)
        req = urllib.request.Request(base + path, data=data, method=method or ("POST" if data is not None else "GET"),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, res.headers, res.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def call_json(*args, **kwargs):
        status, headers, body = call(*args, **kwargs)
        return status, json.loads(body)

    yield {"call": call, "json": call_json, "state": state, "capsys": capsys}
    httpd.shutdown()
    httpd.server_close()


def prefs_body(**extra):
    return {"text": PRD_TEXT, "people": PEOPLE, "period": {"start": "2026-09-28", "weeks": 4}, **extra}


def test_server_serves_index_and_nothing_else(api):
    status, headers, body = api["call"]("/")
    assert status == 200 and headers["Cache-Control"] == "no-store" and b"<html" in body[:300].lower()
    for path in ["/../.env", "/timetable_server/server.py", "/.env", "/index.html"]:
        assert api["call"](path)[0] == 404


def test_server_health(api, monkeypatch):
    assert api["json"]("/api/health")[1]["key"] is True
    monkeypatch.delenv("OPENROUTER_API_KEY")
    status, data = api["json"]("/api/health")
    assert status == 200 and data["key"] is False and "셀 2" in data["message"]


def test_server_preferences_ok_and_errors(api, monkeypatch):
    status, data = api["json"]("/api/preferences", prefs_body())
    assert status == 200 and len(data["rules"]) == 5
    assert api["json"]("/api/preferences", prefs_body(text=" "))[1]["message"] == "선호도 문장을 먼저 써 주세요."
    assert api["json"]("/api/preferences", raw=b"{nope")[0] == 400
    assert api["json"]("/api/preferences", raw=b"x" * 20001)[1]["code"] == "too_large"
    assert api["json"]("/api/preferences", method="GET")[1]["code"] == "method_not_allowed"
    assert api["json"]("/api/nope")[1]["code"] == "not_found"
    monkeypatch.delenv("OPENROUTER_API_KEY")
    assert api["json"]("/api/preferences", prefs_body()) == (503, {"ok": False, "code": "no_key",
                                                                   "message": server.NO_KEY_MESSAGE})


@pytest.mark.parametrize("code, status", [("ai_rate_limit", 429), ("ai_timeout", 504), ("ai_model", 502),
                                          ("ai_bad_answer", 502), ("weird", 502)])
def test_server_maps_ai_errors(api, code, status):
    def fail(*args):
        raise openrouter_client.OpenRouterError(f"실패 {KEY}", code)
    api["state"]["parse"] = fail
    got_status, data = api["json"]("/api/preferences", prefs_body())
    assert got_status == status
    assert data["code"] == (code if code != "weird" else "ai_server")
    assert KEY not in data["message"]


def test_server_summary_truncates_and_logs_no_text(api):
    api["state"]["explain"] = lambda report: "가나다라마바사. " * 100
    body = json.loads(parity.INPUTS.read_text(encoding="utf-8"))["summary_request"][0]
    status, data = api["json"]("/api/summary", body)
    assert status == 200 and len(data["summary"]) <= 600 and data["summary"].endswith(".")
    api["json"]("/api/preferences", prefs_body(text="A는 아주 비밀스러운 선호"))
    logs = api["capsys"].readouterr().err
    assert "/api/summary 200" in logs and "비밀" not in logs and KEY not in logs
