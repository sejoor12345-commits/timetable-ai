"""OpenRouter에 요청을 보내는 공통 함수 모음. 선호도 해석과 결과 설명이 모두 이 파일을 통해 AI를 부른다.

Study-04/fridge_recipe/openrouter_client.py를 이어받았다.
(전체 제한 시간 직접 재기, <think> 지우기, 오류를 "무엇이 잘못됐고 어떻게 하면 되는지" 해요체 문구로 바꾸기)
"""

import json
import os
import re
import time

import requests

API_URL = "https://openrouter.ai/api/v1/chat/completions"
# 사용할 AI 모델. 모델을 바꾸려면 여기만 고치면 된다 (다른 파일에 모델 이름을 다시 적지 않는다)
TEXT_MODEL = "stealth/space-bunny-alpha"
TIMEOUT_SECONDS = 90  # 요청 하나의 "전체" 최대 시간(초). 화면(브라우저)은 100초까지 기다리므로 그보다 짧게
CONNECT_SECONDS = 10  # 이 시간 안에 OpenRouter에 연결조차 못 하면 연결 실패로 본다
SILENCE_SECONDS = 30  # 서버가 이 시간 동안 아무것도 안 보내면 연결이 끊긴 것으로 본다

# 화면에 그대로 보여 줄 안내 문구 (PRD_step1.md 6장). "무엇이 잘못됐는지 + 어떻게 하면 되는지"를 함께 쓴다.
# 서버는 켜질 때의 환경 변수만 보므로, 키를 다시 불러온 뒤에는 서버를 켜는 셀 3도 다시 실행해야 한다.
NO_KEY_MESSAGE = "API 키가 없어요. Colab에서 키를 불러오는 셀(셀 2)을 실행한 다음, 서버를 켜는 셀(셀 3)도 다시 실행해 주세요."
AUTH_MESSAGE = (
    "API 키가 올바르지 않아요. Colab 보안 비밀(🔑)의 OPENROUTER_API_KEY 값을 확인한 다음, "
    "셀 2와 셀 3을 다시 실행해 주세요."
)
CREDIT_MESSAGE = (
    "OpenRouter 계정의 크레딧(사용할 수 있는 금액)이 부족해서 AI를 쓸 수 없어요. "
    "openrouter.ai에 로그인해 Credits 화면에서 잔액을 확인해 주세요."
)
MODEL_MESSAGE = (
    f"AI 모델({TEXT_MODEL})을 찾을 수 없어요. 모델 이름이 바뀌었거나 서비스가 끝났을 수 있어요. "
    "openrouter_client.py의 모델 이름을 확인해 주세요."
)
RATE_LIMIT_MESSAGE = (
    "AI 요청이 몰려서 잠시 막혔어요. 1분쯤 뒤에 다시 시도해 주세요. "
    "계속 이러면 오늘 쓸 수 있는 무료 사용량을 다 쓴 것일 수 있어요."
)
SERVER_MESSAGE = "AI 서버가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요."
READ_MESSAGE = "AI 서버의 답을 읽지 못했어요. 잠시 후 다시 시도해 주세요."
TIMEOUT_MESSAGE = "AI 답이 너무 늦어서 기다리기를 멈췄어요. AI 서버가 바쁜 것 같아요. 잠시 후 다시 시도해 주세요."
CONNECT_MESSAGE = "AI 서버(OpenRouter)에 연결하지 못했어요. 잠시 후 다시 시도해 주세요."
EMPTY_MESSAGE = "AI가 빈 답을 보냈어요. 다시 시도해 주세요."

# OpenRouter 상태 코드 → (오류 코드, 안내 문구). 여기 없는 코드는 SERVER_MESSAGE 뒤에 상태 코드를 붙인다
STATUS_ERRORS = {
    401: ("ai_auth", AUTH_MESSAGE),
    402: ("ai_auth", CREDIT_MESSAGE),
    404: ("ai_model", MODEL_MESSAGE),
    408: ("ai_timeout", TIMEOUT_MESSAGE),
    429: ("ai_rate_limit", RATE_LIMIT_MESSAGE),
}


class OpenRouterError(Exception):
    """화면에 그대로 보여 줘도 되는 안내 문구(message)와 짧은 영어 오류 코드(code)를 담은 오류.

    code는 PRD_step1.md F4 표의 AI 쪽 코드다:
    ai_auth, ai_model, ai_rate_limit, ai_server, ai_connect, ai_timeout, ai_empty, ai_bad_answer.
    키가 아예 없으면 no_key.
    """

    def __init__(self, message, code):
        super().__init__(message)
        self.message = message
        self.code = code


def has_api_key():
    """환경 변수에 API 키가 있는지만 본다 (OpenRouter를 부르지 않아 빠르고 무료)."""
    return bool(os.environ.get("OPENROUTER_API_KEY", "").strip())


def get_api_key():
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise OpenRouterError(NO_KEY_MESSAGE, "no_key")
    return key


def error_detail(body):
    """오류 응답에서 원인 설명만 짧게 꺼낸다. 예: {"error": {"message": "Provider returned error"}} → "Provider returned error".

    영어 원문 전체를 보여 주면 읽기 어려우므로, 안내 문구 맨 뒤에 괄호로 짧게 덧붙이는 데 쓴다.
    """
    try:
        detail = json.loads(body)["error"]["message"]
    except (ValueError, KeyError, TypeError):
        detail = body
    detail = " ".join(str(detail).split())  # 줄바꿈·연속 공백을 한 칸으로
    return detail[:100] or "내용 없음"


def status_error(status, body):
    """상태 코드(401, 429, 500 …)를 알맞은 OpenRouterError로 바꾼다."""
    if status in STATUS_ERRORS:
        code, message = STATUS_ERRORS[status]
        return OpenRouterError(message, code)
    return OpenRouterError(f"{SERVER_MESSAGE} (상태 코드 {status}: {error_detail(body)})", "ai_server")


def read_body_with_deadline(response, deadline):
    """응답 내용을 조금씩 받으면서, 전체 시간이 deadline을 넘으면 멈춘다.

    requests의 timeout은 "서버가 조용한 시간"만 재기 때문에, OpenRouter처럼 답을 준비하는 동안
    몇 초마다 빈 글자를 보내 연결을 유지하는 서버에서는 끝없이 기다리게 된다. 그래서 전체 시간을 직접 잰다.
    """
    chunks = []
    # 한 글자씩 받는다. 크게 받으면 빈 글자가 조금씩 올 때 그만큼 찰 때까지 기다리느라 시간을 못 잰다.
    # (답 크기는 몇 KB 정도라 한 글자씩 받아도 느리지 않다)
    for chunk in response.iter_content(chunk_size=1):
        chunks.append(chunk)
        if time.monotonic() > deadline:
            raise OpenRouterError(TIMEOUT_MESSAGE, "ai_timeout")
    return b"".join(chunks).decode("utf-8", errors="replace")


def remove_think(content):
    """생각하고 답하는 모델(reasoning)이 답 앞에 붙이는 <think>…</think>를 지우고 답만 남긴다."""
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL)
    if "</think>" in content:  # 여는 <think> 없이 "생각…</think>답"으로 오는 경우
        content = content.rsplit("</think>", 1)[1]
    if "<think>" in content:  # 생각하다가 답이 끊긴 경우: <think> 뒤는 모두 생각이다
        content = content.split("<think>", 1)[0]
    return content.strip()


def answer_text(body):
    """OpenRouter의 정상(200) 응답 본문에서 AI가 쓴 답 글자만 꺼낸다."""
    if not body.strip():
        raise OpenRouterError(EMPTY_MESSAGE, "ai_empty")
    try:
        data = json.loads(body)
    except ValueError:
        raise OpenRouterError(f"{READ_MESSAGE} (받은 내용: {error_detail(body)})", "ai_server")

    # 답을 준비하는 동안 이미 상태 코드 200을 보낸 뒤라서, AI 쪽 오류가 본문 안에 {"error": …}로 오는 경우
    if isinstance(data, dict) and data.get("error") and not data.get("choices"):
        error = data["error"] if isinstance(data["error"], dict) else {}
        code = error.get("code")
        raise status_error(code if isinstance(code, int) and code >= 400 else 502, body)

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise OpenRouterError(f"{READ_MESSAGE} (받은 내용: {error_detail(body)})", "ai_server")

    content = remove_think(content if isinstance(content, str) else "")
    if not content:
        raise OpenRouterError(EMPTY_MESSAGE, "ai_empty")
    return content


def chat(messages, temperature=0.3):
    """AI에게 메시지를 보내고 답 글자를 돌려준다. 실패하면 OpenRouterError를 낸다.

    messages: [{"role": "system"|"user"|"assistant", "content": "…"}, …]
    temperature: 낮을수록(0에 가까울수록) 같은 입력에 비슷한 답. 정확해야 하는 일은 낮게 둔다.
    자동으로 다시 시도하지 않는다 (시간과 무료 사용량을 아끼기 위해).
    """
    key = get_api_key()
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        with requests.post(
            API_URL,
            headers={"Authorization": f"Bearer {key}"},
            json={"model": TEXT_MODEL, "messages": messages, "temperature": temperature},
            timeout=(CONNECT_SECONDS, SILENCE_SECONDS),  # (연결까지, 조용한 시간) 최대 초
            stream=True,  # 답을 한 번에 받지 않고 조금씩 받아서 전체 시간을 잴 수 있게 한다
        ) as response:
            status = response.status_code
            body = read_body_with_deadline(response, deadline)
    except requests.ConnectTimeout:  # 10초 안에 연결조차 못 한 경우. Timeout의 한 종류라서 Timeout보다 먼저 확인한다
        raise OpenRouterError(CONNECT_MESSAGE, "ai_connect")
    except requests.Timeout:
        raise OpenRouterError(TIMEOUT_MESSAGE, "ai_timeout")
    except requests.ConnectionError as error:
        if "timed out" in str(error).lower():  # 받는 도중에 서버가 조용해진 경우
            raise OpenRouterError(TIMEOUT_MESSAGE, "ai_timeout")
        raise OpenRouterError(CONNECT_MESSAGE, "ai_connect")
    except requests.RequestException:
        raise OpenRouterError(CONNECT_MESSAGE, "ai_connect")

    if status != 200:
        raise status_error(status, body)
    return answer_text(body)


def extract_json(text):
    """AI 답에서 JSON을 꺼낸다. ```json 코드블록이나 앞뒤 설명 글이 붙어 있어도 읽어 본다.

    끝내 읽지 못하면 ValueError를 낸다.
    """
    candidates = [text.strip()]
    candidates += [block.strip() for block in re.findall(r"```(?:json)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)]
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except ValueError:
            continue

    # 설명 글 사이에 끼어 있는 경우: "{"가 나오는 자리마다 거기서 시작하는 JSON 객체를 읽어 본다
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", text):
        try:
            value, _ = decoder.raw_decode(text, match.start())
            return value
        except ValueError:
            continue
    raise ValueError("JSON을 찾지 못함")
