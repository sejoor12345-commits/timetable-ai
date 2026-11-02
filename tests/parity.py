"""Python(Colab 서버)과 JavaScript(Vercel 함수)가 같은 입력에 같은 결과를 내는지 비교하기 위한 기준 답 만들기.

tests/fixtures/parity_inputs.json 의 입력을 timetable_server 의 Python 함수에 넣어 나온 결과를
tests/fixtures/parity_expected.json 에 저장한다.
- pytest(tests/test_timetable_server.py)는 저장된 기준 답이 지금 Python 결과와 같은지 본다 (Python을 고치면 알려 줌).
- Node 테스트(tests/api.test.mjs)는 JavaScript 결과가 이 기준 답과 같은지 본다 (옮긴 코드가 원본과 같은지).

Python 쪽 프롬프트·검사를 일부러 바꿨다면 기준 답을 다시 만든다:  python tests/parity.py --write
"""

import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "timetable_server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import openrouter_client  # noqa: E402
import preferences  # noqa: E402
import server  # noqa: E402

INPUTS = ROOT / "tests" / "fixtures" / "parity_inputs.json"
EXPECTED = ROOT / "tests" / "fixtures" / "parity_expected.json"


def error_of(error):
    if isinstance(error, server.ApiError):
        return {"error": [error.status, error.code, error.message]}
    if isinstance(error, openrouter_client.OpenRouterError):
        return {"error": error.code}
    raise error


def run(fn, *args):
    try:
        return {"ok": fn(*args)}
    except (server.ApiError, openrouter_client.OpenRouterError) as error:
        return error_of(error)
    except ValueError:
        return {"error": "ValueError"}


def compute():
    data = json.loads(INPUTS.read_text(encoding="utf-8"))
    out = {}

    out["parse_messages"] = []
    for case in data["parse_messages"]:
        days = preferences.period_dates(case["start"], case["weeks"])
        today = date.fromisoformat(case["today"])
        out["parse_messages"].append(
            preferences.build_parse_messages(case["text"], case["people"], days, set(case["holidays"]), today))

    out["check_answer"] = []
    for case in data["check_answer"]:
        days = preferences.period_dates(case["start"], case["weeks"])
        out["check_answer"].append(run(preferences.check_answer, case["data"], case["people"], days))

    out["extract_json"] = [run(openrouter_client.extract_json, text) for text in data["extract_json"]]
    out["answer_text"] = [run(openrouter_client.answer_text, body) for body in data["answer_text"]]
    out["remove_think"] = [openrouter_client.remove_think(text) for text in data["remove_think"]]
    out["summary_data"] = [preferences.build_summary_data(report) for report in data["summary_data"]]
    out["summary_messages"] = [
        [{"role": "system", "content": preferences.SUMMARY_SYSTEM_PROMPT},
         {"role": "user", "content": f"<결과_자료>\n{preferences.build_summary_data(report)}\n</결과_자료>"}]
        for report in data["summary_data"]
    ]
    out["plain_text"] = [preferences.plain_text(text) for text in data["plain_text"]]
    out["shorten_summary"] = [server.shorten_summary(text) for text in data["shorten_summary"]]
    out["preferences_request"] = [run(server.check_preferences_request, body) for body in data["preferences_request"]]
    out["summary_request"] = [run(server.check_summary_request, body) for body in data["summary_request"]]
    return out


def main():
    result = compute()
    if "--write" in sys.argv:
        EXPECTED.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"기준 답을 저장했어요: {EXPECTED}")
    else:
        print(json.dumps(result, ensure_ascii=False)[:2000])


if __name__ == "__main__":
    main()
