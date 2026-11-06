# -*- coding: utf-8 -*-
"""Gemini 분류 — Vercel 서버 함수.

이 앱에서 서버가 필요한 유일한 자리다. **키를 숨기기 위해서** 존재한다.
키를 app.js 에 적으면 브라우저 개발자 도구에서 그대로 보인다.

  POST 받는 것  {"texts": ["가려진 문장", ...최대 20개], "criteria": {...criteria.json...},
                 "model": "모델 이름" 또는 ""}
       주는 것  {"results": [{"category", "sentiment", "urgency", "reason"}, ...], "model": "실제로 쓴 모델"}
                키가 없거나 실패하면 {"results": null, "reason": "..."} — 200 으로 돌려준다.
                AI가 시간 안에 답하지 않으면 {"results": null, "timeout": true, "reason": "..."}
                **앱은 AI 없이도 규칙으로 계속 돈다.**
  GET  주는 것  {"default": "서버 기본 모델 이름"} — 키는 절대 돌려주지 않는다.

모델: 요청의 "model" → 비어 있으면 환경 변수 GEMINI_MODEL → 그것도 없으면 DEFAULT_MODEL.
모델 이름은 호출 주소에 들어가므로 MODEL_RE 로 엄격히 검사한다. 맞지 않으면 AI를 부르지 않는다.

문장은 브라우저에서 **이미 가려진 채로** 온다(mask.js). 여기서 다시 가리지 않는다 —
서버에 도착했다는 것은 이미 내 컴퓨터를 떠났다는 뜻이다.

기준(criteria)은 사람이 정한 것을 그대로 받아 프롬프트에 넣는다. 이 함수는 기준을 만들지 않는다.
외부 라이브러리를 쓰지 않는다 (requirements.txt 가 필요 없다).
"""
import json
import os
import re
import socket
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

# 모델 이름과 무료 한도는 자주 바뀐다 — 00_지침/도구_무료확인.md 를 본다.
#   2.5 계열은 예전 사용자에게만 열려 있다(2026-09). 화면에서 고르거나 Vercel 환경 변수 GEMINI_MODEL 로 바꾼다.
DEFAULT_MODEL = "gemini-3.8-flash"
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$")
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TIMEOUT = 60
MAX_TEXTS = 20
MAX_LEN = 400

CATS = ["요금", "품질", "서비스", "앱기능", "해지관련", "기타"]
SENTS = ["긍정", "중립", "부정"]
URGS = ["높음", "보통", "낮음"]


def default_model():
    return os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL


def pick_model(asked):
    """쓸 모델 이름을 정한다. 형식이 맞지 않으면 None.

    fullmatch 를 쓴다 — re.match 의 $ 는 끝의 줄바꿈("abc\\n")을 통과시킨다.
    요청 값은 다듬지(strip) 않는다 — 공백·줄바꿈이 섞이면 그대로 거절한다.
    환경 변수에서 온 이름도 같은 검사를 거친다.
    """
    if asked is None or asked == "":
        name = default_model()
    elif isinstance(asked, str):
        name = asked
    else:
        return None
    return name if MODEL_RE.fullmatch(name) else None


def build_prompt(texts, crit):
    cats = "\n".join(f"  - {c['name']}: {c['definition']}" for c in crit.get("categories", []))
    lines = "\n".join(f"{i}: {t}" for i, t in enumerate(texts))
    return f"""너는 통신사 고객 문의를 분류하는 담당자다. 아래 기준을 **그대로** 따른다. 기준에 없는 판단을 더하지 않는다.

[분류 — 하나만 고른다]
{cats}
  여러 분류에 걸치면 이 순서로 먼저 고른다: {' > '.join(crit.get('priority', CATS))}
  이유: {crit.get('priority_reason', '')}

[감정 — 긍정 · 중립 · 부정]
  {crit.get('sentiment', {}).get('guide', '')}

[긴급도 — 높음 · 보통 · 낮음]
  {crit.get('urgency', {}).get('guide', '')}

[] 안의 말(예: [전화번호])은 가려진 개인정보다. 추측하지 않는다.

각 문장마다 아래 모양의 JSON 배열 하나로만 답한다. 설명을 덧붙이지 않는다.
[{{"i": 0, "category": "...", "sentiment": "...", "urgency": "...", "reason": "왜 그렇게 골랐는지 한 문장"}}]

[문장]
{lines}
"""


def call_gemini(key, prompt, model):
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT.format(model=model), data=body, method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.loads(r.read().decode("utf-8"))
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)


def clean(items, n):
    """AI가 돌려준 것을 기준 안의 값으로만 받는다. 기준 밖의 값은 버린다."""
    out = [None] * n
    for it in items if isinstance(items, list) else []:
        try:
            i = int(it.get("i"))
        except (TypeError, ValueError, AttributeError):
            continue
        if not 0 <= i < n:
            continue
        c, s, u = it.get("category"), it.get("sentiment"), it.get("urgency")
        if c in CATS and s in SENTS and u in URGS:
            out[i] = {"category": c, "sentiment": s, "urgency": u,
                      "reason": str(it.get("reason", ""))[:200], "by": "AI"}
    return out


def _timed_out(model):
    return {"results": None, "timeout": True, "model": model,
            "reason": f"AI가 {TIMEOUT}초 안에 답하지 않았습니다 — 모델({model})이 느리거나 혼잡합니다"}


def handle(req, key):
    """요청 하나를 처리해 돌려줄 dict 를 만든다. 모델 검사가 키 검사보다 먼저다."""
    if not isinstance(req, dict):
        return {"results": None, "reason": "요청 모양이 맞지 않습니다"}
    model = pick_model(req.get("model"))
    if model is None:
        return {"results": None, "reason": "모델 이름 형식이 맞지 않습니다 — 영문·숫자·. _ - 만, 64자까지"}
    if not key:
        return {"results": None, "model": model, "reason": "키가 없습니다 — Vercel 환경 변수 GEMINI_API_KEY"}
    texts = [str(t)[:MAX_LEN] for t in (req.get("texts") or [])][:MAX_TEXTS]
    crit = req.get("criteria") or {}
    if not texts:
        return {"results": None, "model": model, "reason": "보낸 문장이 없습니다"}
    try:
        items = call_gemini(key, build_prompt(texts, crit), model)
        return {"results": clean(items, len(texts)), "model": model}
    except urllib.error.HTTPError as e:  # URLError 보다 먼저 — HTTPError 는 URLError 의 한 종류
        return {"results": None, "model": model,
                "reason": f"AI 호출 실패 ({e.code}) — 모델({model}) 이름·한도를 확인"}
    except urllib.error.URLError as e:  # 연결하는 중에 시간이 다 되면 reason 에 TimeoutError 가 들어 온다
        if isinstance(e.reason, (TimeoutError, socket.timeout)):
            return _timed_out(model)
        return {"results": None, "model": model, "reason": f"AI 호출 실패 — 모델({model}) · URLError"}
    except (TimeoutError, socket.timeout):  # 응답을 읽는 중에 시간이 다 된 경우
        return _timed_out(model)
    except Exception as e:  # noqa: BLE001
        return {"results": None, "model": model, "reason": f"AI 호출 실패 — 모델({model}) · {type(e).__name__}"}


class handler(BaseHTTPRequestHandler):
    def _send(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        # 기본 모델 이름만. 키는 절대 돌려주지 않는다.
        return self._send({"default": default_model()})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(min(n, 60000)).decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            return self._send({"results": None, "reason": f"요청을 읽지 못했습니다 — {type(e).__name__}"})
        return self._send(handle(req, os.environ.get("GEMINI_API_KEY", "").strip()))
