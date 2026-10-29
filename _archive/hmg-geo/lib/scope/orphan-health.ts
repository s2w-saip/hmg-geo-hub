import "server-only";
import { projectRepository, type UnmirroredProject } from "@/lib/db/repositories/projects";
import { isMockMode } from "@/lib/scope";
import { isDemoProject } from "@/lib/demo";

// 고아 프로젝트 감시 — `scope_project_id IS NULL` 인 프로젝트를 주기적으로
// 표면화한다.
//
// ── 왜 필요한가 ────────────────────────────────────────────────────────────
// 2026-08-15 12:58Z ~ 08-19 03:07Z scope 공개 API 장애(POST /api/v1/projects
// 전건 400) 때 hmg-geo 가 만든 프로젝트 6건이 미러 없이 남았고, **사용자 제보로
// 뒤늦게** 발견됐다. 미러가 없으면 그 프로젝트는 영원히 측정되지 않는데, 화면
// 어디에도 그 사실이 나타나지 않는다 — 조용히 썩는 데이터 결함이다.
// 실패 삼킴은 #76, RUN 회수 게이트는 #77 이 고쳤지만 "사람보다 먼저 알아채는"
// 눈은 없었다(#76 이 남긴 미구현 부채).
//
// ── 술어 (무엇을 세는가) ───────────────────────────────────────────────────
//   scope_project_id IS NULL
//   AND 데모 프로젝트가 아님        — 데모는 합성 미러 id 를 갖지만 방어적으로 제외
//   AND created_at 이 grace 보다 오래됨 — 생성 요청이 in-flight 인 행을 세지 않는다
//                                        (행 INSERT 후 createScopeMirror 를 부르는
//                                         순서라 그 사이 크론이 지나갈 수 있다)
// mock 모드에서는 **아무것도 세지 않는다** — 미러가 없는 것이 설계상 정상이라
// (project-sync 의 LIVE-ONLY 규약) 로컬·프리뷰에서 전건이 고아로 보인다.
// 이 구분을 빼면 감시가 매번 우는 감시가 된다.
//
// soft-delete 컬럼은 없다 — projectRepository.delete() 는 하드 삭제 캐스케이드다.
// 따라서 "활성"의 기계적 정의가 곧 "행이 존재함"이다.

/** 생성 in-flight 를 고아로 오판하지 않기 위한 유예. */
export const ORPHAN_GRACE_MINUTES = 10;

export type OrphanScan =
  // mock 모드 — 판정 대상이 아니다(통과가 아니라 "재지 않음").
  | { mode: "mock" }
  | { mode: "live"; orphans: UnmirroredProject[]; graceHeld: number };

export async function scanOrphanProjects(
  now: Date = new Date(),
  graceMinutes: number = ORPHAN_GRACE_MINUTES,
): Promise<OrphanScan> {
  if (isMockMode()) return { mode: "mock" };
  const rows = await projectRepository.listUnmirrored();
  const cutoff = now.getTime() - graceMinutes * 60 * 1000;
  const candidates = rows.filter((r) => !isDemoProject(r.id));
  const orphans = candidates.filter((r) => r.createdAt.getTime() <= cutoff);
  return {
    mode: "live",
    orphans,
    graceHeld: candidates.length - orphans.length,
  };
}

export const ORPHAN_ISSUE_TITLE =
  "[scope-sync] 고아 프로젝트 — scope 미러 없이 남은 프로젝트가 있다";

function fmt(d: Date): string {
  return d.toISOString().replace(".000", "").replace(/\.\d{3}Z$/, "Z");
}

/** 알림 본문. 대응 절차를 함께 실어 이슈만 보고 처리할 수 있게 한다. */
export function buildOrphanIssueBody(
  orphans: UnmirroredProject[],
  at: Date = new Date(),
): string {
  const withPrompts = orphans.filter((o) => o.promptCount > 0);
  const rows = orphans
    .map(
      (o) =>
        `| \`${o.id}\` | ${o.name} | ${o.brand ?? "—"} | ${o.country} | ${fmt(o.createdAt)} | ${o.promptCount} |`,
    )
    .join("\n");
  return `**고아 프로젝트 ${orphans.length}건** (프롬프트가 이미 있는 것 ${withPrompts.length}건) — 감지 ${fmt(at)}

\`scope_project_id\` 가 NULL 이라 **측정 엔진(scope)에 존재하지 않는** 프로젝트다.
이 상태로는 아무리 기다려도 답변이 수집되지 않는다. 프롬프트가 있는 행은
사용자가 "측정 중"으로 알고 있을 가능성이 높다.

| project id | 이름 | 브랜드 | 국가 | 생성 | 프롬프트 |
| --- | --- | --- | --- | --- | --- |
${rows}

**대응 (순서대로)**
1. scope 공개 API 가 살아 있는지 먼저 본다 — \`npm run verify:scope\`.
   전건 실패면 이것은 hmg-geo 결함이 아니라 scope 장애다(2026-08-15 #454 회귀 전례).
2. 살아 있으면 회수한다: 해당 프로젝트를 열고 **프롬프트 탭 → "저장 + 실행"(RUN)**.
   RUN 은 미러가 없으면 만들고(지연 미러), scope 에 없는 queued 프롬프트까지
   회수 대상에 넣는다(#77).
3. 프롬프트가 0건인 행은 한 번도 쓰이지 않은 껍데기일 수 있다 — 사용자에게
   확인하고 불필요하면 삭제한다. 방치하면 이 알림이 계속 울린다.
4. RUN 후에도 NULL 이면 \`[scope-sync]\` 로그(Vercel Runtime Logs)에서
   \`createProject failed\` 를 찾아 scope 응답 본문을 확인한다.

---
술어 정본: \`lib/scope/orphan-health.ts\` · 감시 경로: \`/api/cron/sync-mirror\` (20분 주기)
경위: PR #76(실패 삼킴 차단) · #77(RUN 회수 게이트)`;
}
