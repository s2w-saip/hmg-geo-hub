import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportIssue, isIssueSinkConfigured } from "@/lib/alerts/github-issue";

// fetch 를 통째로 가로채 GitHub API 호출 순서/본문을 검사한다. 네트워크 없음.
const fetchMock = vi.fn();

const OK = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function url(call: number): string {
  return String(fetchMock.mock.calls[call][0]);
}
function init(call: number): RequestInit {
  return fetchMock.mock.calls[call][1] as RequestInit;
}

const NOW = new Date("2026-08-20T12:00:00.000Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  // clearAllMocks 는 mockResolvedValueOnce 큐를 비우지 않는다 — 한 테스트가
  // 큐를 다 안 쓰면 다음 테스트로 새어 들어가 엉뚱한 실패를 만든다. reset 필수.
  fetchMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GITHUB_ALERT_TOKEN", "ghp_test");
  vi.stubEnv("GITHUB_ALERT_REPO", "Kongventures/hmg-geo");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("미배선 (env 없음)", () => {
  // alert-routing 룰 4: 배선 안 된 채널은 통과가 아니라 `unconfigured` 다.
  it("토큰이 없으면 unconfigured — 네트워크를 치지 않는다", async () => {
    vi.stubEnv("GITHUB_ALERT_TOKEN", "");
    expect(isIssueSinkConfigured()).toBe(false);
    expect(await reportIssue({ title: "T", body: "B" })).toEqual({
      status: "unconfigured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("repo 가 없어도 unconfigured", async () => {
    vi.stubEnv("GITHUB_ALERT_REPO", "");
    expect(await reportIssue({ title: "T", body: "B" })).toEqual({
      status: "unconfigured",
    });
  });
});

describe("열린 이슈가 없을 때", () => {
  // confirmAbsentMs: 0 = "재확인 예산 없음" → 조회 1회 후 곧바로 생성.
  // 폴링 자체는 아래 별도 describe 가 가짜 타이머로 검증한다.
  const noWait = { confirmAbsentMs: 0 };

  it("새 이슈를 만든다", async () => {
    fetchMock
      .mockResolvedValueOnce(OK([]))
      .mockResolvedValueOnce(OK({ number: 91 }, 201));
    const res = await reportIssue({ title: "T", body: "B", ...noWait });
    expect(res).toEqual({ status: "created", issueNumber: 91 });
    expect(url(1)).toBe(
      "https://api.github.com/repos/Kongventures/hmg-geo/issues",
    );
    expect(init(1).method).toBe("POST");
    expect(JSON.parse(String(init(1).body))).toEqual({ title: "T", body: "B" });
  });

  it("제목이 다른 열린 이슈는 재사용하지 않는다", async () => {
    fetchMock
      .mockResolvedValueOnce(
        OK([{ number: 5, title: "다른 제목", updated_at: hoursAgo(100) }]),
      )
      .mockResolvedValueOnce(OK({ number: 92 }, 201));
    expect(await reportIssue({ title: "T", body: "B", ...noWait })).toEqual({
      status: "created",
      issueNumber: 92,
    });
  });

  it("PR 은 이슈 목록에 섞여 오지만 매치 대상이 아니다", async () => {
    fetchMock
      .mockResolvedValueOnce(
        OK([
          { number: 7, title: "T", updated_at: hoursAgo(100), pull_request: {} },
        ]),
      )
      .mockResolvedValueOnce(OK({ number: 93 }, 201));
    expect(await reportIssue({ title: "T", body: "B", ...noWait })).toEqual({
      status: "created",
      issueNumber: 93,
    });
  });
});

describe("생성 전 '없음' 재확인 (목록 복제 지연 방어)", () => {
  // 왜 있는가: GitHub 이슈 **목록**은 생성 후 3.5~7.5s(실측 n=4) 동안 그 이슈를
  // 돌려주지 않는다. 재확인 없이 만들면 중복 이슈가 생긴다 — 도달 실증에서
  // 실제로 두 번 발생했다(#79·#80, 그리고 고정 4초 대기로 고치려 한 #82·#83).
  it("폴링 중 나타나면 만들지 않고 코멘트로 간다", async () => {
    fetchMock
      .mockResolvedValueOnce(OK([])) // t=0 아직 안 보임
      .mockResolvedValueOnce(
        OK([{ number: 42, title: "T", updated_at: hoursAgo(100) }]),
      ) // t=2s 나타남
      .mockResolvedValueOnce(OK({ id: 1 }, 201));
    const p = reportIssue({ title: "T", body: "B", confirmAbsentMs: 15_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await p).toEqual({ status: "commented", issueNumber: 42 });
    // 생성(POST /issues)은 한 번도 호출되지 않았다.
    expect(
      fetchMock.mock.calls.filter(
        (c) => String(c[0]).endsWith("/issues") && (c[1] as RequestInit)?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("예산을 다 써도 안 나타나면 그때 만든다", async () => {
    // 예산 6s / 폴 간격 2s → 최초 조회 1 + 폴링 3(t=2·4·6s) = 목록 4회, 그 뒤 생성.
    for (let i = 0; i < 4; i++) fetchMock.mockResolvedValueOnce(OK([]));
    fetchMock.mockResolvedValueOnce(OK({ number: 94 }, 201));
    const p = reportIssue({ title: "T", body: "B", confirmAbsentMs: 6_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ status: "created", issueNumber: 94 });
  });

  it("첫 조회에서 찾으면 폴링하지 않는다 (대기 비용은 생성 경로에서만)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        OK([{ number: 42, title: "T", updated_at: hoursAgo(100) }]),
      )
      .mockResolvedValueOnce(OK({ id: 1 }, 201));
    await reportIssue({ title: "T", body: "B", confirmAbsentMs: 15_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("열린 이슈가 있을 때 — 중복 억제", () => {
  it("쿨다운을 지났으면 코멘트한다 (새 이슈를 만들지 않는다)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        OK([{ number: 42, title: "T", updated_at: hoursAgo(13) }]),
      )
      .mockResolvedValueOnce(OK({ id: 1 }, 201));
    const res = await reportIssue({
      title: "T",
      body: "B",
      cooldownHours: 12,
      confirmAbsentMs: 0,
    });
    expect(res).toEqual({ status: "commented", issueNumber: 42 });
    expect(url(1)).toBe(
      "https://api.github.com/repos/Kongventures/hmg-geo/issues/42/comments",
    );
  });

  it("쿨다운 안이면 아무것도 하지 않는다 — 20분 크론이 하루 72개를 쌓지 않게", async () => {
    fetchMock.mockResolvedValueOnce(
      OK([{ number: 42, title: "T", updated_at: hoursAgo(1) }]),
    );
    const res = await reportIssue({
      title: "T",
      body: "B",
      cooldownHours: 12,
      confirmAbsentMs: 0,
    });
    expect(res).toEqual({ status: "throttled", issueNumber: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("실패는 삼키되 보고한다 (호출한 크론을 죽이지 않는다)", () => {
  it("목록 조회가 4xx 면 failed", async () => {
    fetchMock.mockResolvedValueOnce(OK({ message: "Bad credentials" }, 401));
    const res = await reportIssue({ title: "T", body: "B", confirmAbsentMs: 0 });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("401");
  });
  it("생성이 4xx 면 failed", async () => {
    fetchMock
      .mockResolvedValueOnce(OK([]))
      .mockResolvedValueOnce(OK({ message: "no" }, 403));
    const res = await reportIssue({
      title: "T",
      body: "B",
      confirmAbsentMs: 0,
    });
    expect(res).toEqual({ status: "failed", error: "create 403" });
  });
  it("네트워크 예외도 throw 하지 않는다", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const res = await reportIssue({ title: "T", body: "B", confirmAbsentMs: 0 });
    expect(res).toEqual({ status: "failed", error: "ECONNRESET" });
  });
});

describe("자격증명 취급", () => {
  it("토큰은 Authorization 헤더로만 나간다 — URL·본문에 실리지 않는다", async () => {
    fetchMock
      .mockResolvedValueOnce(OK([]))
      .mockResolvedValueOnce(OK({ number: 1 }, 201));
    await reportIssue({ title: "T", body: "B", confirmAbsentMs: 0 });
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      expect(url(i)).not.toContain("ghp_test");
      expect(String(init(i).body ?? "")).not.toContain("ghp_test");
      const headers = init(i).headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer ghp_test");
    }
  });
});
