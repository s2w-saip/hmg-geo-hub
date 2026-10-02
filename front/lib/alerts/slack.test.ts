import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Slack 싱크: **URL 이 어디로도 새지 않는다**가 이 파일의 주제다.
// 웹훅 URL 은 그 자체가 발송 권한이라, 실패 경로에서 한 번만 새도 사표가 된다.

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/deadbeefcafe";

async function load() {
  vi.resetModules();
  return await import("./slack");
}

type Payload = { text: string; attachments: Array<{ color: string; text: string }> };

function capture(into: Payload[]) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    into.push(JSON.parse(String(init.body)));
    return new Response("ok", { status: 200 });
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("배선 여부", () => {
  it("env 미설정이면 unconfigured: 조용한 통과가 아니다", async () => {
    vi.stubEnv("SLACK_ALERT_WEBHOOK", "");
    const m = await load();
    expect(m.isSlackSinkConfigured()).toBe(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      m.postSlackAlert({ severity: 2, title: "t", body: "b" }),
    ).resolves.toEqual({ status: "unconfigured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Slack 웹훅 호스트가 아니면 미배선으로 친다 (오타로 엉뚱한 곳에 POST 하지 않는다)", async () => {
    vi.stubEnv("SLACK_ALERT_WEBHOOK", "https://example.internal/hook");
    const m = await load();
    expect(m.isSlackSinkConfigured()).toBe(false);
  });

  it("옛 잔디 웹훅이 남아 있어도 배선으로 치지 않는다", async () => {
    vi.stubEnv(
      "SLACK_ALERT_WEBHOOK",
      "https://wh.jandi.com/connect-api/webhook/12345/deadbeefcafe",
    );
    const m = await load();
    expect(m.isSlackSinkConfigured()).toBe(false);
  });
});

describe("발송", () => {
  it("페이로드는 { text, attachments:[{color,text}] } 이고 잔디 필드가 없다", async () => {
    vi.stubEnv("SLACK_ALERT_WEBHOOK", WEBHOOK);
    const m = await load();
    const seen: Payload[] = [];
    let headers: HeadersInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        headers = init.headers;
        seen.push(JSON.parse(String(init.body)));
        return new Response("ok", { status: 200 });
      }),
    );
    await m.postSlackAlert({ severity: 1, title: "t", body: "b" });
    expect(Object.keys(seen[0]).sort()).toEqual(["attachments", "text"]);
    expect(seen[0].attachments).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toMatch(/connectColor|connectInfo/);
    expect(JSON.stringify(headers)).not.toContain("jandi");
  });

  it("등급별 색이 tools/slack-notify.sh 와 같다", async () => {
    vi.stubEnv("SLACK_ALERT_WEBHOOK", WEBHOOK);
    const m = await load();
    const seen: Payload[] = [];
    vi.stubGlobal("fetch", capture(seen));
    for (const severity of [0, 1, 2] as const) {
      await m.postSlackAlert({ severity, title: "t", body: "b" });
    }
    expect(seen.map((p) => p.attachments[0].color)).toEqual([
      "#2E7D32",
      "#FB8C00",
      "#E53935",
    ]);
  });

  it("text 에 등급 아이콘과 제목, attachment 에 본문이 들어간다", async () => {
    vi.stubEnv("SLACK_ALERT_WEBHOOK", WEBHOOK);
    const m = await load();
    const seen: Payload[] = [];
    vi.stubGlobal("fetch", capture(seen));
    await m.postSlackAlert({ severity: 2, title: "회차 노출 지체", body: "본문" });
    expect(seen[0].text).toBe("🚨 [회차 노출 지체]");
    expect(seen[0].attachments[0].text).toBe("본문");
  });

  it("& < > 를 이스케이프한다 (<!channel> 멘션·링크 주입 차단)", async () => {
    vi.stubEnv("SLACK_ALERT_WEBHOOK", WEBHOOK);
    const m = await load();
    const seen: Payload[] = [];
    vi.stubGlobal("fetch", capture(seen));
    await m.postSlackAlert({
      severity: 1,
      title: "a <!channel> & b",
      body: "<https://evil.example|클릭> & <@U123>",
      details: [{ title: "x<y", description: "p>q" }],
    });
    expect(seen[0].text).toBe("⚠️ [a &lt;!channel&gt; &amp; b]");
    const t = seen[0].attachments[0].text;
    expect(t).not.toMatch(/[<>]/);
    expect(t).toContain("&lt;https://evil.example|클릭&gt; &amp; &lt;@U123&gt;");
    expect(t).toContain("x&lt;y: p&gt;q");
  });

  it("긴 본문은 잘리고 생략 표시가 붙는다", async () => {
    vi.stubEnv("SLACK_ALERT_WEBHOOK", WEBHOOK);
    const m = await load();
    const seen: Payload[] = [];
    vi.stubGlobal("fetch", capture(seen));
    await m.postSlackAlert({ severity: 1, title: "t", body: "가".repeat(9_000) });
    const t = seen[0].attachments[0].text;
    expect(t).toContain("…(이하 생략)");
    expect(t.length).toBeLessThan(4_000);
  });
});

describe("실패해도 URL 을 흘리지 않는다", () => {
  it("HTTP 오류는 코드만 남는다", async () => {
    vi.stubEnv("SLACK_ALERT_WEBHOOK", WEBHOOK);
    const m = await load();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no_service", { status: 404 })));
    const res = await m.postSlackAlert({ severity: 1, title: "t", body: "b" });
    expect(res).toEqual({ status: "failed", error: "HTTP 404" });
    expect(JSON.stringify(res)).not.toContain("hooks.slack.com");
  });

  it("네트워크 예외는 클래스 이름만 남는다 (메시지에 호스트가 붙는 경로 차단)", async () => {
    vi.stubEnv("SLACK_ALERT_WEBHOOK", WEBHOOK);
    const m = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`fetch failed for ${WEBHOOK}`);
      }),
    );
    const res = await m.postSlackAlert({ severity: 2, title: "t", body: "b" });
    expect(res.status).toBe("failed");
    expect(res.error).toBe("TypeError");
    expect(JSON.stringify(res)).not.toContain("hooks.slack.com");
  });

  it("절대 throw 하지 않는다: 감시 실패가 크론을 죽이면 안 된다", async () => {
    vi.stubEnv("SLACK_ALERT_WEBHOOK", WEBHOOK);
    const m = await load();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    await expect(
      m.postSlackAlert({ severity: 2, title: "t", body: "b" }),
    ).resolves.toMatchObject({ status: "failed" });
  });
});
