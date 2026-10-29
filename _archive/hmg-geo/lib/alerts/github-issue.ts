import "server-only";

// GitHub Issue 알림 싱크 — 워크스페이스 alert-routing 룰의 두 목적지 중
// "코드·빌드성" 쪽. 사람이 **코드/데이터를 고쳐야** 해소되지만 지금 당장
// 깨어날 일은 아닌 신호가 여기로 온다. (라이브 장애=잔디는 이 리포에 아직
// 배선이 없다 — 없는 채널을 만들지 않는 것이 룰 4·5다.)
//
// 왜 앱 런타임에서 직접 이슈를 여는가:
//   hmg-geo 에는 GitHub Actions 가 하나도 없다(.github 디렉토리 자체가 없음).
//   scope 리포의 헬스 워크플로 패턴을 그대로 옮기려면 ① 첫 워크플로 ②
//   스케줄 러너 ③ DB 자격증명(또는 CRON_SECRET+앱 URL)의 GH Secrets 복제가
//   함께 필요하다. 반면 감시 대상(projects 테이블)에 이미 닿아 있는 프로세스가
//   20분마다 도는 Vercel cron 이라, 거기에 판정+알림만 얹는 것이 새로 만드는
//   인프라가 가장 적다. 대신 이슈 생성/코멘트/중복억제 로직은 scope 의
//   digest-queue-health.yml 이 검증한 것과 동일하게 맞춘다.
//
// 자격증명 경계 (BFF 원칙): 토큰은 이 모듈에서만 읽는다. server-only 이고,
// 값은 어떤 응답·로그에도 실리지 않는다. issues:write 하나짜리 fine-grained
// PAT 를 전제로 한다 — repo 쓰기 권한을 주지 마라.

const API = "https://api.github.com";

export type IssueReportStatus =
  // 새 이슈를 열었다.
  | "created"
  // 같은 제목의 열린 이슈에 코멘트를 달았다.
  | "commented"
  // 같은 제목의 열린 이슈가 쿨다운 안에서 이미 갱신돼 있어 아무것도 안 했다.
  // 20분 주기 크론이 매 패스마다 코멘트를 달면 하루 72개가 쌓여 신호가 묻힌다.
  | "throttled"
  // env 미설정 — 채널이 **배선되지 않았다**. 통과가 아니다(룰 4).
  | "unconfigured"
  // GitHub API 가 거부했거나 닿지 않음.
  | "failed";

export interface IssueReportResult {
  status: IssueReportStatus;
  issueNumber?: number;
  error?: string;
}

export interface IssueReport {
  /** 제목은 **안정적인 식별자**여야 한다 — 중복 억제가 제목 완전일치로 돈다. */
  title: string;
  body: string;
  /**
   * 열린 이슈가 이 시간 안에 이미 갱신됐으면 코멘트를 생략한다(기본 12시간).
   * 상태는 GitHub 이 들고 있으므로 앱 쪽 상태 테이블이 필요 없다.
   */
  cooldownHours?: number;
  /**
   * "없다"고 판단한 뒤 생성 전에 재확인을 반복할 총 예산(ms).
   * 근거는 아래 DEFAULT_CONFIRM_ABSENT_MS 주석. 테스트에서 0.
   */
  confirmAbsentMs?: number;
}

const DEFAULT_COOLDOWN_HOURS = 12;

// 목록 조회가 "없다"고 답해도 곧바로 만들지 않는다 — GitHub 의 이슈 **목록**
// 엔드포인트는 읽기 복제 지연이 있어, 방금 만든 이슈가 한동안 보이지 않는다.
//
// ── 실측 (2026-08-20, Kongventures/hmg-geo, 열린 이슈 3건 = 페이지네이션 무관) ──
// 생성(201) 응답을 받은 시점부터 그 이슈가 목록에 나타나기까지:
//     3.5s · 4.1s · 5.8s · 7.5s   (n=4, 변동이 크다)
// 캐시가 아니라 복제 지연이다 — 응답의 `age` 는 항상 null 이었고, 같은 60초
// `max-age` 창 안에서 본문과 ETag 가 바뀌었다.
//
// 이 지연을 모르고 만든 첫 구현은 도달 실증에서 **중복 이슈 2건(#79·#80)** 을
// 실제로 만들었고, 고정 4초 재확인으로 고치려 한 두 번째 시도도 **또 중복
// (#82·#83)** 을 만들었다. 관측 범위 상단이 7.5s 였기 때문이다. mock 테스트는
// 이 실패를 절대 잡지 못한다 — alert-routing 룰 4 가 도달 실증을 요구하는 이유다.
//
// 그래서 고정 대기가 아니라 **예산 안에서 폴링**한다. 찾으면 즉시 빠져나오므로
// 대기 비용은 "정말로 없을 때"만, 그것도 알림 사이클당 최초 1회만 지불한다
// (그 뒤로는 첫 조회에서 바로 찾는다). 크론 maxDuration 300s 대비 무시할 만하다.
//
// search API 로 바꾸는 것은 해법이 아니다 — 그쪽 색인 지연은 수십 초~분 단위로
// 더 나쁘다.
const DEFAULT_CONFIRM_ABSENT_MS = 15_000;
const CONFIRM_POLL_INTERVAL_MS = 2_000;

function config(): { token: string; repo: string } | null {
  const token = process.env.GITHUB_ALERT_TOKEN;
  const repo = process.env.GITHUB_ALERT_REPO;
  if (!token || !repo) return null;
  return { token, repo };
}

/** 채널이 배선돼 있는지 — 값은 노출하지 않고 여부만. 진단 응답용. */
export function isIssueSinkConfigured(): boolean {
  return config() !== null;
}

async function gh(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    // 크론 안에서 도는 부수 작업이다 — 캐시에 걸리면 안 된다.
    cache: "no-store",
  });
}

interface OpenIssue {
  number: number;
  title: string;
  updated_at: string;
}

// 열린 이슈를 제목 **완전일치**로 찾는다. search API 대신 issues 목록을 쓰는
// 이유: search 는 인덱싱 지연(수십 초~분)이 있어 방금 만든 이슈를 못 찾고
// 중복을 만든다. 감시가 20분마다 도는 이 경로에서는 치명적이다.
async function findOpenIssueByTitle(
  repo: string,
  token: string,
  title: string,
): Promise<OpenIssue | null> {
  const res = await gh(
    `/repos/${repo}/issues?state=open&per_page=100&sort=updated&direction=desc`,
    token,
  );
  if (!res.ok) throw new Error(`issue list ${res.status}`);
  const rows = (await res.json()) as Array<
    OpenIssue & { pull_request?: unknown }
  >;
  // /issues 는 PR 도 함께 돌려준다 — pull_request 가 있는 행은 버린다.
  return rows.find((r) => !r.pull_request && r.title === title) ?? null;
}

/**
 * 이슈를 열거나(없으면) 코멘트한다(있으면). 절대 throw 하지 않는다 — 알림
 * 실패가 자신을 호출한 크론을 죽이면 안 된다.
 */
export async function reportIssue(
  report: IssueReport,
): Promise<IssueReportResult> {
  const cfg = config();
  if (!cfg) return { status: "unconfigured" };
  const { token, repo } = cfg;
  const cooldownMs =
    (report.cooldownHours ?? DEFAULT_COOLDOWN_HOURS) * 60 * 60 * 1000;

  try {
    let existing = await findOpenIssueByTitle(repo, token, report.title);
    // 복제 지연 방어 — DEFAULT_CONFIRM_ABSENT_MS 주석 참조. "없다"를 예산이
    // 다 소진될 때까지 확인한 뒤에만 새로 만든다.
    const budget = report.confirmAbsentMs ?? DEFAULT_CONFIRM_ABSENT_MS;
    const deadline = Date.now() + budget;
    while (!existing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, CONFIRM_POLL_INTERVAL_MS));
      existing = await findOpenIssueByTitle(repo, token, report.title);
    }
    if (existing) {
      const age = Date.now() - new Date(existing.updated_at).getTime();
      if (Number.isFinite(age) && age < cooldownMs) {
        return { status: "throttled", issueNumber: existing.number };
      }
      const res = await gh(
        `/repos/${repo}/issues/${existing.number}/comments`,
        token,
        { method: "POST", body: JSON.stringify({ body: report.body }) },
      );
      if (!res.ok) {
        return {
          status: "failed",
          issueNumber: existing.number,
          error: `comment ${res.status}`,
        };
      }
      return { status: "commented", issueNumber: existing.number };
    }

    const res = await gh(`/repos/${repo}/issues`, token, {
      method: "POST",
      body: JSON.stringify({ title: report.title, body: report.body }),
    });
    if (!res.ok) return { status: "failed", error: `create ${res.status}` };
    const created = (await res.json()) as { number: number };
    return { status: "created", issueNumber: created.number };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
