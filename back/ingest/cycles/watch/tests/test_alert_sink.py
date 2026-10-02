"""경보 싱크(동기화 S1 BE-10): Slack 배선·등급 색·목적지(live 만)·실패 격리·웹훅 비노출. 실제 발송 없음(httpx.MockTransport)."""
from __future__ import annotations

import json
import logging

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import get_settings, load_settings, set_settings
from ingest.common import alerts as al

HOOK = "https://hooks.slack.com/services/T000/B000/fake-token-for-tests"


def _mock(status: int = 200, *, boom: bool = False):
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if boom:
            raise httpx.ConnectError(f"connect failed to {req.url}")
        return httpx.Response(status, text="ok")
    return httpx.MockTransport(handler), seen


async def test_live_posts_one_payload_with_severity_color_and_escape():
    t, seen = _mock()
    sink = al.SlackAlertSink(SecretStr(HOOK), source="hmg-geo-hub stg", transport=t)
    await sink.send("live", "[projection_gap/2] 투영 공백 <a&b>", {"answers": 3, "by_surface": {"global": 2}}, severity=2)
    await sink.send("live", "[queue/1] 대기", None, severity=1)
    await sink.send("live", "등급 없음", None)
    assert [str(r.url) for r in seen] == [HOOK] * 3 and sink.results == ["sent"] * 3
    p = [json.loads(r.content) for r in seen]
    assert p[0]["text"].startswith("\U0001f6a8 [hmg-geo-hub stg] [projection_gap/2]") and "&lt;a&amp;b&gt;" in p[0]["text"]
    assert [x["attachments"][0]["color"] for x in p] == ["#E53935", "#FB8C00", "#FB8C00"]      # 2 긴급 적색, 1·없음 = 주의
    body = p[0]["attachments"][0]["text"]
    assert "answers: 3" in body and 'by_surface: {"global": 2}' in body


async def test_code_kind_is_not_sent_to_slack(caplog):
    t, seen = _mock()
    sink = al.SlackAlertSink(SecretStr(HOOK), transport=t)
    with caplog.at_level(logging.WARNING, logger="hgh.ingest.alert"):
        await sink.send("code", "[load_failures/1] 실패 적재", {"failed": 3}, severity=1)
    assert seen == [] and sink.results == [] and "실패 적재" in caplog.text               # 이슈 트래커 배선 전: 로그만


@pytest.mark.parametrize(("status", "boom", "want"), [(500, False, "failed:HTTP 500"), (200, True, "failed:ConnectError")])
async def test_failures_are_isolated_and_never_log_the_webhook(caplog, status, boom, want):
    t, _ = _mock(status, boom=boom)
    sink = al.SlackAlertSink(SecretStr(HOOK), transport=t)
    with caplog.at_level(logging.DEBUG):
        await sink.send("live", "x", {"k": 1}, severity=2)                             # 예외를 올리지 않는다
    assert sink.results == [want]
    assert "hooks.slack.com/services" not in caplog.text and "fake-token" not in caplog.text


def test_body_is_clipped_before_escape():
    p = al.slack_payload("t", {"big": "&" * 5000}, 1)
    text = p["attachments"][0]["text"]
    assert text.endswith("…(이하 생략)") and "&amp;" in text and not text.replace("…(이하 생략)", "").endswith("&amp")


@pytest.mark.parametrize(("value", "kind"), [(HOOK, "SlackAlertSink"), ("https://evil.example/hook", "LogAlertSink"), (None, "LogAlertSink")])
def test_sink_selection_from_settings(value, kind):
    before = get_settings()
    set_settings(before.model_copy(update={"alert_slack_webhook": SecretStr(value) if value else None}))
    try:
        s = al.get_alert_sink()
        assert type(s).__name__ == kind
        mem = al.MemoryAlertSink()
        al.set_alert_sink(mem)
        assert al.get_alert_sink() is mem and al.sink_label(mem) == "memory"            # 주입이 설정보다 먼저
    finally:
        al.set_alert_sink(None)
        set_settings(before)


def test_settings_read_webhook_env_without_exposing_it():
    s = load_settings({"HGH_ALERT_SLACK_WEBHOOK": HOOK})
    assert s.alert_slack_webhook is not None and s.alert_slack_webhook.get_secret_value() == HOOK
    assert "hooks.slack.com" not in repr(s) and "hooks.slack.com" not in str(s.alert_slack_webhook)
    assert load_settings({}).alert_slack_webhook is None
