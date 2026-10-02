"""LLM(OpenRouter, OpenAI 호환 chat completions) 공용 클라이언트: 구조화 출력(json_schema strict) 1회 호출.

- 설정은 core.config(openrouter_api_key·openrouter_base_url·openrouter_model·openrouter_timeout_s). URL 은 base(…/api/v1)만 받고
  경로 /chat/completions 는 여기서 붙인다(예전 기능별 HGH_OPENROUTER_URL 전체 URL 관례는 폐기: HGH_OPENROUTER_BASE_URL 하나).
- 커넥션을 쥔 채 부르지 않는다: 이 모듈 함수는 DB 커넥션 인자를 받지 않는다(core.db 규약). 핸들러는 CurrentUserDetached 로 받는다.
- 주입: 라우터는 LlmDep(= Depends(get_llm))로 받고, 테스트는 app.dependency_overrides[get_llm] 로 가짜를 넣는다.
- 오류: LlmError(kind upstream|invalid|unconfigured). call_llm 이 API 오류로 바꾼다:
    unconfigured → 503 llm_unavailable(키 미설정: 권한 검사가 끝난 뒤 호출 시점에만 드러난다)
    upstream·invalid → 502 llm_failed(원문 응답·키 미노출)
- 재시도: 429·5xx·타임아웃·전송 오류는 1회 재시도(1.5초 뒤). 호출별 timeout_s 로 설정값을 덮을 수 있다(운영자 키워드 도구 180초).
  시도 하나는 timeout_s 를 넘지 못한다(asyncio.timeout 총량 상한: httpx timeout 은 연산별이라 느린 본문이 시도를 늘릴 수 있었다).
- 요청 기한(D-7, 2026-09-30): LLM 라우트는 dependencies=[request_deadline(<초>)] 로 기한을 건다(도착 시각 + 라우트 상수, 요청 헤더
  X-HGH-Timeout-Ms 가 있으면 min(상수, 헤더/1000 - HEADER_MARGIN_S)). get_llm 이 그 기한을 클라이언트에 싣고, 클라이언트는
    시도마다 제한 = min(timeout_s, 남은 기한). 남은 기한 < MIN_ATTEMPT_S 면 시도하지 않는다.
    재시도 전에 남은 기한 - 대기(1.5초) < MIN_ATTEMPT_S 면 재시도하지 않는다.
    기한에 잘린 시도(제한이 남은 기한이었고 시간 초과)도 재시도하지 않는다.
  세 경우 모두 LlmError('deadline') → 504 llm_timeout. 재시도까지 해서 실패한 429·5xx·전송 오류는 전과 같이 502 llm_failed.
  라우트 상수는 프론트 BFF 대기와 맞춘다(front/lib/hgh/adapters): 키워드 도구 185초 → 175초, 소셜 프롬프트 생성 110초 → 105초,
  SERP 초안 70초(external) → 65초. BFF 가 끊은 뒤 백엔드가 재시도로 과금하는 일이 없게 한다(known_diff U11-N9).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from typing import Annotated, Any, Literal, Protocol

from fastapi import Depends, Header, Request

from app.core import errors
from app.core.config import Settings, get_settings

log = logging.getLogger("hgh.llm")

ErrorKind = Literal["upstream", "invalid", "unconfigured", "deadline"]
__all__ = ["DEADLINE_HEADER", "LLM_RESPONSES", "LlmClient", "LlmDep", "LlmError", "OpenRouterClient", "UnavailableLlm", "call_llm",
           "get_llm", "llm_api_error", "request_deadline"]

RETRY_BACKOFF_S = 1.5          # 재시도 전 대기
MIN_ATTEMPT_S = 5.0            # 남은 기한이 이보다 짧으면 (재)시도하지 않는다(짧은 시도는 성공 가능성보다 과금 위험이 크다)
HEADER_MARGIN_S = 2.0          # X-HGH-Timeout-Ms 를 받았을 때 응답 전송 몫으로 빼는 시간
DEADLINE_HEADER = "X-HGH-Timeout-Ms"
_DEADLINE_STATE = "hgh_llm_deadline"     # request.state 키(time.monotonic() 기준 절대 시각)


class LlmError(Exception):
    """LLM 호출·응답 형식 실패. 메시지에 키·원문 응답을 싣지 않는다."""

    def __init__(self, kind: ErrorKind = "upstream", message: str = ""):
        super().__init__(f"{kind}: {message}" if message else kind)
        self.kind: ErrorKind = kind


class LlmClient(Protocol):
    model: str

    async def complete_json(self, prompt: str, schema: dict[str, Any], *, temperature: float, max_tokens: int,
                            timeout_s: float | None = None) -> dict[str, Any]: ...


class OpenRouterClient:
    def __init__(self, settings: Settings | None = None, *, transport: Any = None, title: str = "hmg-geo-hub",
                 deadline: float | None = None, backoff_s: float = RETRY_BACKOFF_S, min_attempt_s: float = MIN_ATTEMPT_S,
                 clock: Callable[[], float] = time.monotonic):
        s = settings or get_settings()
        if s.openrouter_api_key is None:
            raise LlmError("unconfigured", "HGH_OPENROUTER_API_KEY 미설정")
        self._key = s.openrouter_api_key
        self._url = s.openrouter_base_url.rstrip("/") + "/chat/completions"
        self._timeout = s.openrouter_timeout_s
        self._transport = transport
        self._title = title
        self._deadline = deadline                 # time.monotonic() 기준 절대 시각(None = 기한 없음)
        self._backoff = backoff_s
        self._min_attempt = min_attempt_s
        self._clock = clock
        self.model = s.openrouter_model

    def __repr__(self) -> str:
        return f"OpenRouterClient(model={self.model!r}, key=set)"

    def _rest(self) -> float | None:
        return None if self._deadline is None else self._deadline - self._clock()

    async def complete_json(self, prompt: str, schema: dict[str, Any], *, temperature: float, max_tokens: int,
                            timeout_s: float | None = None) -> dict[str, Any]:
        import httpx

        body = {"model": self.model, "messages": [{"role": "user", "content": prompt}], "temperature": temperature,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_schema", "json_schema": {"name": "result", "strict": True, "schema": schema}}}
        headers = {"Authorization": f"Bearer {self._key.get_secret_value()}", "Content-Type": "application/json", "X-Title": self._title}
        last = ""
        for attempt in range(2):
            limit = timeout_s or self._timeout
            rest = self._rest()
            capped = False
            if rest is not None:
                if rest < self._min_attempt:
                    raise LlmError("deadline", f"요청 기한 부족(시도 {attempt + 1}, 직전 {last or '없음'})")
                capped = rest < limit
                limit = min(limit, rest)
            try:
                async with asyncio.timeout(limit), httpx.AsyncClient(timeout=limit, transport=self._transport) as c:
                    r = await c.post(self._url, json=body, headers=headers)
            except (httpx.TimeoutException, TimeoutError) as e:
                last = type(e).__name__
                if capped:                                  # 남은 기한 전부를 쓴 시도가 시간 초과: 더 기다릴 기한이 없다
                    raise LlmError("deadline", f"요청 기한 초과({last})") from e
                await self._before_retry(attempt, last)
                continue
            except httpx.TransportError as e:
                last = type(e).__name__
                await self._before_retry(attempt, last)
                continue
            except httpx.HTTPError as e:
                raise LlmError("upstream", type(e).__name__) from e
            if r.status_code == 429 or r.status_code >= 500:
                last = f"HTTP {r.status_code}"
                await self._before_retry(attempt, last)
                continue
            if r.status_code != 200:
                raise LlmError("upstream", f"HTTP {r.status_code}")
            try:
                content = r.json()["choices"][0]["message"]["content"]
                data = json.loads(content) if isinstance(content, str) else content
            except (KeyError, IndexError, ValueError, TypeError) as e:
                raise LlmError("invalid", f"응답 형식 오류: {type(e).__name__}") from e
            if not isinstance(data, dict):
                raise LlmError("invalid", "구조화 출력이 객체가 아님")
            return data
        raise LlmError("upstream", f"재시도 소진: {last}")

    async def _before_retry(self, attempt: int, last: str) -> None:
        """첫 시도 실패 뒤: 대기 후 남은 기한이 MIN_ATTEMPT_S 미만이면 재시도하지 않고 기한 오류(504)로 끝낸다."""
        if attempt != 0:
            return
        rest = self._rest()
        if rest is not None and rest - self._backoff < self._min_attempt:
            raise LlmError("deadline", f"재시도할 기한 부족(직전 {last})")
        await asyncio.sleep(self._backoff)


class UnavailableLlm:
    """키 미설정: 실제 호출 시점에 LlmError('unconfigured')(권한 오류가 503 에 가려지지 않게)."""
    model = "unavailable"

    async def complete_json(self, prompt: str, schema: dict[str, Any], *, temperature: float, max_tokens: int,
                            timeout_s: float | None = None) -> dict[str, Any]:
        raise LlmError("unconfigured", "HGH_OPENROUTER_API_KEY 미설정")


TimeoutHeader = Annotated[int | None, Header(
    alias=DEADLINE_HEADER, ge=1, le=600_000,
    description=f"호출자(BFF)의 이 요청 대기 한도(ms, 선택). LLM 호출(재시도 포함)이 min(라우트 상한, 이 값 - {HEADER_MARGIN_S:g}초) 안에 "
                f"끝나게 한다(기한을 줄이기만 한다). 남은 기한이 {MIN_ATTEMPT_S:g}초 미만이면 호출하지 않고 504 llm_timeout")]


def request_deadline(budget_s: float) -> Any:
    """LLM 라우트 기한 의존성(라우트 dependencies= 에 건다: 라우트 의존성은 매개변수보다 먼저 풀려 도착 시각에 가깝게 잰다).
    기한 = 지금 + min(budget_s, X-HGH-Timeout-Ms/1000 - HEADER_MARGIN_S). 헤더는 호출자(BFF)의 대기 시간이고 기한을 줄이기만 한다."""

    async def _deadline(request: Request, timeout_ms: TimeoutHeader = None) -> float:
        budget = budget_s if timeout_ms is None else min(budget_s, timeout_ms / 1000 - HEADER_MARGIN_S)
        at = time.monotonic() + budget
        setattr(request.state, _DEADLINE_STATE, at)
        return at

    _deadline.hgh_llm_budget_s = budget_s  # type: ignore[attr-defined]   # 정적 검사용(LLM 라우트는 기한이 있어야 한다)
    return Depends(_deadline)


def get_llm(request: Request) -> LlmClient:
    """FastAPI 의존성. 라우트의 request_deadline 기한을 클라이언트에 싣는다. 테스트는 app.dependency_overrides[get_llm] 로 교체한다."""
    s = get_settings()
    if s.openrouter_api_key is None:
        return UnavailableLlm()
    return OpenRouterClient(s, deadline=getattr(request.state, _DEADLINE_STATE, None))


LlmDep = Annotated[LlmClient, Depends(get_llm)]

# LLM 라우트 OpenAPI 응답(라우터 responses= 에 더한다)
LLM_RESPONSES: dict[int | str, dict[str, Any]] = {
    502: {"model": errors.ErrorBody, "description": "llm_failed(재시도까지 실패, 응답 형식 오류)"},
    504: {"model": errors.ErrorBody, "description": "llm_timeout(요청 기한 안에 끝나지 않음: 재시도하지 않았다)"},
}


def llm_api_error(e: LlmError) -> errors.ApiError:
    if e.kind == "unconfigured":
        return errors.unavailable("LLM 미설정", code="llm_unavailable")
    if e.kind == "deadline":
        return errors.gateway_timeout("LLM 요청 기한 초과", code="llm_timeout")
    return errors.upstream("LLM 호출 실패", code="llm_failed")


async def call_llm(llm: LlmClient, prompt: str, schema: dict[str, Any], *, temperature: float, max_tokens: int,
                   timeout_s: float | None = None) -> dict[str, Any]:
    """LLM 실패를 API 오류로 통일(503 llm_unavailable · 502 llm_failed)."""
    try:
        return await llm.complete_json(prompt, schema, temperature=temperature, max_tokens=max_tokens, timeout_s=timeout_s)
    except LlmError as e:
        log.warning("LLM 호출 실패: %s", e.kind)
        raise llm_api_error(e) from e
