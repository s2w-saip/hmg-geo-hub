"""경보 헬퍼(알림 라우팅 룰: 라이브 이슈 = Slack, 코드 수리 = 이슈 트래커). 전송 실패는 적재·감시를 막지 않는다.

  kind 'live'  run blocked·재확인 창 닫힌 분석 결손·노출 지체·워커 하트비트 지연·투영 공백 → Slack(#ops-alerts)
  kind 'code'  불변식 위반 반복·적재 실패 연속 → 로그(이슈 트래커 배선 전)

싱크 선택(get_alert_sink): set_alert_sink 로 넣은 것 > core.config HGH_ALERT_SLACK_WEBHOOK 이 있으면 SlackAlertSink > LogAlertSink.
웹훅 URL 은 그 자체가 발송 권한이라 설정(SecretStr)에서만 읽고 응답·로그·예외 메시지에 싣지 않는다(실패는 HTTP 코드·예외 종류만).
페이로드 = 사내 공용 알림 헬퍼·hmg-geo lib/alerts/slack.ts 와 같은 형태 {text, attachments:[{color, text}]},
등급 0 PASS(초록) · 1 주의(주황, 비적색) · 2 긴급(적색). 재알림 억제는 감시 스케줄 자체(6시간, 상태 표 없음: cycles.watch 머리 주석).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from pydantic import SecretStr

log = logging.getLogger("hgh.ingest.alert")
AlertKind = Literal["live", "code"]

SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/services/"
SLACK_TIMEOUT_S = 15.0
SLACK_MAX_BODY = 3500                    # 긴 본문은 읽히지 않는다: 우리가 자르고 표시한다(hmg-geo slack.ts MAX_BODY_CHARS)
SEVERITY_STYLE = {0: ("#2E7D32", "✅"), 1: ("#FB8C00", "⚠️"), 2: ("#E53935", "\U0001f6a8")}


class AlertSink(Protocol):
    async def send(self, kind: AlertKind, message: str, detail: dict[str, Any] | None = None, *,
                   severity: int | None = None) -> None: ...


class LogAlertSink:
    async def send(self, kind: AlertKind, message: str, detail: dict[str, Any] | None = None, *,
                   severity: int | None = None) -> None:
        log.warning("[경보:%s] %s %s", kind, message, detail or {})


@dataclass
class MemoryAlertSink:
    """테스트용: 보낸 경보를 모은다(sent 는 (kind, message, detail), 등급은 severities 에 같은 순서로)."""
    sent: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)
    severities: list[int | None] = field(default_factory=list)

    async def send(self, kind: AlertKind, message: str, detail: dict[str, Any] | None = None, *,
                   severity: int | None = None) -> None:
        self.sent.append((kind, message, dict(detail or {})))
        self.severities.append(severity)


def slack_escape(s: str) -> str:
    """Slack 제어문자(& < >) 이스케이프(& 먼저). 본문에 DB 값이 들어가므로 제목·본문 전부."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def slack_payload(message: str, detail: dict[str, Any] | None, severity: int | None, *, source: str = "hmg-geo-hub") -> dict[str, Any]:
    """{text, attachments:[{color, text}]}. 등급 없음 = 1(주의). 본문 = 메시지 + detail 의 '키: 값' 줄, 자르기는 이스케이프 앞."""
    sev = severity if severity in SEVERITY_STYLE else 1
    color, icon = SEVERITY_STYLE[sev]
    lines = [message] + [f"{k}: {v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)}"
                         for k, v in (detail or {}).items()]
    body = "\n".join(lines)
    if len(body) > SLACK_MAX_BODY:
        body = body[:SLACK_MAX_BODY] + "\n…(이하 생략)"
    title = message.splitlines()[0] if message else ""
    return {"text": f"{icon} [{slack_escape(source)}] {slack_escape(title)}", "attachments": [{"color": color, "text": slack_escape(body)}]}


class SlackAlertSink:
    """live → Slack Incoming Webhook 1건(POST, 15초), code → 로그(이슈 트래커 배선 전). 모든 경보는 로그에도 남긴다.
    transport 는 시험용(httpx.MockTransport): 실제 발송 없이 요청을 본다."""

    def __init__(self, webhook: SecretStr, *, source: str = "hmg-geo-hub", transport: Any = None):
        self._webhook = webhook
        self._source = source
        self._transport = transport
        self.results: list[str] = []                 # sent | failed:<HTTP 코드 또는 예외 종류> (값·URL 없음)

    async def send(self, kind: AlertKind, message: str, detail: dict[str, Any] | None = None, *,
                   severity: int | None = None) -> None:
        log.warning("[경보:%s] %s %s", kind, message, detail or {})
        if kind != "live":
            return
        import httpx

        # httpx.AsyncClient 는 요청마다 전체 URL 을 INFO 로 남긴다(logger "httpx": "HTTP Request: POST <url>"). 웹훅 경로가 곧 발송 권한이라
        # 클라이언트를 거치지 않고 전송 계층에 바로 보낸다(시험이 로그에 URL 이 없음을 단언한다).
        req = httpx.Request("POST", self._webhook.get_secret_value(), json=slack_payload(message, detail, severity, source=self._source),
                            extensions={"timeout": httpx.Timeout(SLACK_TIMEOUT_S).as_dict()})
        try:
            transport = self._transport or httpx.AsyncHTTPTransport()
            try:
                r = await transport.handle_async_request(req)
                await r.aread()
            finally:
                if self._transport is None:
                    await transport.aclose()
            ok = r.status_code == 200
            self.results.append("sent" if ok else f"failed:HTTP {r.status_code}")
            if not ok:
                log.error("Slack 경보 발송 실패 HTTP %s", r.status_code)
        except Exception as e:  # noqa: BLE001 (네트워크 예외 메시지에 URL 이 섞일 수 있어 종류만)
            self.results.append(f"failed:{type(e).__name__}")
            log.error("Slack 경보 발송 실패 %s", type(e).__name__)


def slack_webhook() -> SecretStr | None:
    """core.config HGH_ALERT_SLACK_WEBHOOK(Slack 형식일 때만). 형식 검사는 값을 출력하지 않는다(오타로 내부망 POST 방지)."""
    from app.core.config import get_settings

    w = get_settings().alert_slack_webhook
    if w is None or not w.get_secret_value().startswith(SLACK_WEBHOOK_PREFIX):
        return None
    return w


_sink: AlertSink | None = None


def get_alert_sink() -> AlertSink:
    if _sink is not None:
        return _sink
    w = slack_webhook()
    if w is None:
        return LogAlertSink()
    from app.core.config import get_settings

    return SlackAlertSink(w, source=f"hmg-geo-hub {get_settings().env}")


def sink_label(s: AlertSink) -> str:
    """감시 보고용 싱크 이름(값 없음). log = Slack 미배선: 통과가 아니다(알림 라우팅 룰 4)."""
    return {"SlackAlertSink": "slack", "LogAlertSink": "log", "MemoryAlertSink": "memory"}.get(type(s).__name__, type(s).__name__)


def set_alert_sink(s: AlertSink | None) -> None:
    global _sink
    _sink = s
