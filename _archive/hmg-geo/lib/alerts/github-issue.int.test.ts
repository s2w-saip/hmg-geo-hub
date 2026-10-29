// GitHub Issue 싱크 **도달 실증** — 실제 리포에 이슈를 열고·코멘트하고·닫는다.
//
// 왜 유닛 테스트로 부족한가: alert-routing 룰 4 는 "배선했으면 강제 전이로
// 도달을 실증하고, 실증 못 하면 배선하지 않은 것으로 친다"고 못 박는다. fetch 를
// mock 한 테스트는 내 코드가 의도한 요청을 만든다는 것만 증명하지, 그 요청을
// GitHub 이 받아준다는 것(토큰 권한·리포 경로·페이로드 형태)은 증명하지 않는다.
// 유령 토픽 16개가 전부 "만들었으니 됐다"로 끝난 것이 그 차이다.
//
// 기본 skip — 실 쓰기가 일어나므로 명시적 opt-in 이 필요하다:
//
//   GITHUB_ALERT_TOKEN=… GITHUB_ALERT_REPO=Kongventures/hmg-geo \
//   ALERT_REACH_TEST=1 npx vitest run lib/alerts/github-issue.int.test.ts
//
// 뒷정리까지 이 테스트가 한다(생성한 이슈를 닫는다). 제목에 타임스탬프를 넣어
// 운영 알림(ORPHAN_ISSUE_TITLE)과 절대 겹치지 않게 한다 — 겹치면 실증이 진짜
// 알림을 쿨다운으로 눌러버린다.
import { describe, expect, it } from "vitest";
import { reportIssue } from "./github-issue";

const enabled =
  process.env.ALERT_REACH_TEST === "1" &&
  !!process.env.GITHUB_ALERT_TOKEN &&
  !!process.env.GITHUB_ALERT_REPO;

const TITLE = `[reachability] github-issue sink 도달 실증 ${new Date().toISOString()}`;

async function closeIssue(n: number): Promise<number> {
  const res = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_ALERT_REPO}/issues/${n}`,
    {
      method: "PATCH",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${process.env.GITHUB_ALERT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
    },
  );
  return res.status;
}

describe.skipIf(!enabled)("GitHub Issue 싱크 도달 실증 (실 쓰기)", { timeout: 60_000 }, () => {
  it("생성 → 쿨다운 억제 → 코멘트 → 정리 가 전부 실제로 동작한다", async () => {
    // ① 없는 제목 → 새 이슈
    const created = await reportIssue({ title: TITLE, body: "① 생성" });
    expect(created.status).toBe("created");
    expect(created.issueNumber).toBeTypeOf("number");
    const n = created.issueNumber!;

    // ② 같은 제목 재호출 → **중복을 만들지 않고** 쿨다운으로 억제한다.
    //    이 단언이 이 파일의 존재 이유다. mock 테스트를 전부 통과한 두 번의
    //    구현이 여기서 실제로 중복 이슈를 만들었다:
    //      - 1차(재확인 없음)        → #79 · #80
    //      - 2차(고정 4초 재확인)     → #82 · #83
    //    원인은 GitHub 이슈 **목록**의 읽기 복제 지연(실측 3.5~7.5s, n=4)이고,
    //    현재 구현은 예산 안에서 폴링해 이 창을 넘긴다.
    const again = await reportIssue({ title: TITLE, body: "② 억제돼야 함" });
    expect(again).toEqual({ status: "throttled", issueNumber: n });

    // ③ 쿨다운 0 → 같은 이슈에 코멘트(새 이슈를 만들지 않는다)
    const commented = await reportIssue({
      title: TITLE,
      body: "③ 코멘트 경로",
      cooldownHours: 0,
    });
    expect(commented).toEqual({ status: "commented", issueNumber: n });

    // ④ 뒷정리
    expect(await closeIssue(n)).toBe(200);
  });
});
