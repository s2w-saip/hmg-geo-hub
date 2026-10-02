import "server-only";

// Slack 알림 싱크: 사내 운영 규칙의 두 목적지 중 **라이브 이슈** 쪽.
// "지금 서비스가 아프다 · 사람이 지금 봐야 한다" 가 여기로 온다. 사람이 코드를
// 고쳐야 해소되는 신호는 반대쪽(`lib/alerts/github-issue.ts`)이다.
//
// ── 이력 ──────────────────────────────────────────────────────────────────
// 2026-09-16: 회차 사슬 감시와 함께 `lib/alerts/jandi.ts` 로 신설.
// 2026-09-25: 제품 결정 "잔디 알림 배선 해제, hmg-geo 는 Slack 운영 알림 채널로" 에 따라
//   Slack Incoming Webhook 으로 교체(사내 공용 알림 헬퍼, aeorank PR #9 와
//   같은 전환). 잔디 전용 헤더(`Accept: …jandi-v2+json`)·`connectColor`·`connectInfo` 는 없앴다.
//
// ── 계약 (사내 공용 알림 헬퍼 와 **같은 형태**) ───────────
// 페이로드 `{ text, attachments: [{ color, text }] }`. 색·아이콘·등급 어휘를 그 스크립트와
// 일부러 일치시킨다. 발신처마다 생김새가 다르면 사람이 등급을 읽는 법을 매번 새로 배운다.
//   0=PASS(초록 ✅) · 1=주의(주황 ⚠️, 비적색) · 2=긴급(적색 🚨)
//
// ── 이스케이프 ────────────────────────────────────────────────────────────
// Slack 은 `&` `<` `>` 를 제어문자로 쓴다(`<!channel>` 멘션, `<url|label>` 링크). 본문에는
// DB 값·로그 조각이 들어갈 수 있으므로 **제목·본문·부가 정보 전부** 이스케이프한다.
//
// ── 시크릿 경계 ───────────────────────────────────────────────────────────
// 웹훅 URL 은 그 자체가 발송 권한이다(누구나 그 URL 로 채널에 글을 쓸 수 있다).
// 이 모듈에서만 읽고, 어떤 응답·로그·에러 메시지에도 싣지 않는다.
// 실패는 HTTP 코드만 남긴다: URL 을 찍으면 그 줄이 곧 유출이다.

/** 등급: alert-routing 룰 6. 상시 재발 신호를 매번 2로 내면 긴급이 묻힌다. */
export type AlertSeverity = 0 | 1 | 2;

const SEVERITY_STYLE: Record<AlertSeverity, { color: string; icon: string }> = {
  0: { color: "#2E7D32", icon: "✅" },
  1: { color: "#FB8C00", icon: "⚠️" },
  2: { color: "#E53935", icon: "🚨" },
};

export type AlertPostStatus =
  // Slack 이 200 으로 받았다.
  | "sent"
  // env 미설정: 채널이 **배선되지 않았다**. 통과가 아니다(룰 4).
  | "unconfigured"
  // Slack 이 거부했거나 닿지 않음.
  | "failed";

export interface AlertPostResult {
  status: AlertPostStatus;
  /** 실패 진단용. URL 은 **절대** 들어가지 않는다. */
  error?: string;
}

export interface LiveAlert {
  severity: AlertSeverity;
  /** 한 줄 제목. 사람이 채널 목록에서 이것만 보고 등급을 판단한다. */
  title: string;
  body: string;
  /** 표 형태 부가 정보. 본문 뒤에 `제목: 설명` 줄로 붙는다. */
  details?: Array<{ title: string; description: string }>;
}

/** 본문 상한: 긴 본문은 읽히지 않는다. 잘릴 바엔 우리가 자르고 표시한다. */
const MAX_BODY_CHARS = 3_500;

const SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/services/";

/** Slack 제어문자 이스케이프(`&` 먼저). */
export function escapeSlackText(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function webhookUrl(): string | null {
  const url = process.env.SLACK_ALERT_WEBHOOK;
  if (!url) return null;
  // 형식 검증은 값을 출력하지 않고 한다. 오타로 내부망에 POST 하는 것을 막는다.
  if (!url.startsWith(SLACK_WEBHOOK_PREFIX)) return null;
  return url;
}

/** 채널이 배선돼 있는지: 값은 노출하지 않고 여부만. 진단 응답용. */
export function isSlackSinkConfigured(): boolean {
  return webhookUrl() !== null;
}

/**
 * Slack 으로 한 건 보낸다. **절대 throw 하지 않는다**: 알림 실패가 자신을 호출한
 * 크론을 죽이면 감시가 감시 대상을 무너뜨린다.
 */
export async function postSlackAlert(
  alert: LiveAlert,
): Promise<AlertPostResult> {
  const url = webhookUrl();
  if (!url) return { status: "unconfigured" };
  const { color, icon } = SEVERITY_STYLE[alert.severity];
  const detailLines = (alert.details ?? []).map(
    (d) => `${d.title}: ${d.description}`,
  );
  const raw = detailLines.length
    ? `${alert.body}\n\n${detailLines.join("\n")}`
    : alert.body;
  // 자르기는 이스케이프 **앞**: 뒤에서 자르면 `&amp;` 가 반 토막 날 수 있다.
  const clipped =
    raw.length > MAX_BODY_CHARS
      ? `${raw.slice(0, MAX_BODY_CHARS)}\n…(이하 생략)`
      : raw;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `${icon} [${escapeSlackText(alert.title)}]`,
        attachments: [{ color, text: escapeSlackText(clipped) }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { status: "failed", error: `HTTP ${res.status}` };
    return { status: "sent" };
  } catch (err) {
    // 메시지에 URL 이 섞일 수 있는 유일한 경로가 fetch 의 네트워크 에러다
    // (`TypeError: fetch failed` 는 안전하지만 cause 에 호스트가 붙는다).
    // 클래스 이름만 남긴다.
    return {
      status: "failed",
      error: err instanceof Error ? err.name : "unknown",
    };
  }
}
