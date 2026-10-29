// 회차 관제 드라이런 (PR① T6/T16) — **읽기 전용**. 쓰기 0.
//
// 실행:
//   bash (내부 작업 파일) <워크트리> \
//     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/cycle-control-dryrun.ts
//
// 옵션:
//   --json           표 대신 원본 JSON
//   --root=<uuid>    surface='global' 로 볼 scope 루트(기본 SCOPE_ROOT_PROJECT_ID)
//   --now=<ISO>      판정 기준 시각(재확인 창 3일의 기준)
//   --max=<n>        한 틱 귀속 상한(기본 5000) — 표시에만 영향
//
// ⚠️ 이 스크립트는 `--yes` 같은 적용 스위치를 **갖지 않는다**. 적용은 sync 크론
//    (`app/api/cron/sync-mirror/route.ts`)만 한다 — 손으로 도는 적용 경로를 두지
//    않는 것이 의도다(회차 원장은 20분마다 스스로 수렴해야 한다).
import { runCycleControl } from "@/lib/summary/cycle-control";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const nowRaw = arg("now");
const now = nowRaw ? new Date(nowRaw) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error(`invalid --now: ${nowRaw}`);
  process.exit(1);
}
const maxRaw = arg("max");
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

const rootProjectId = arg("root") ?? process.env.SCOPE_ROOT_PROJECT_ID ?? null;
if (!rootProjectId) {
  // 없으면 루트 회차가 surface='project' 로 열린다 — 글로벌 화면이 그 회차를 못 본다.
  // 프로덕션 런타임에는 env 가 있지만 이 CLI 는 DATABASE_URL 만 받고 도는 일이 많다.
  console.warn(
    "⚠️ SCOPE_ROOT_PROJECT_ID 없음 — 루트 회차가 surface='project' 로 판정된다. --root=<uuid> 로 넘겨라.",
  );
}

const res = await runCycleControl({
  dryRun: true,
  now,
  rootProjectId,
  maxAttributions: maxRaw ? Number(maxRaw) : undefined,
});

if (argv.includes("--json")) {
  console.log(JSON.stringify(res, null, 2));
} else if (res.skipped) {
  console.log(`관제 건너뜀: ${res.skipped}  (${res.ms} ms)`);
} else {
  const t = res.table!;
  console.log(
    `\n■ 회차 관제 드라이런 — 기준 ${now.toISOString()} · root=${rootProjectId ?? "(없음)"}` +
      `  (판정 ${t.judgeMs} ms / 전체 ${res.ms} ms)\n`,
  );

  console.log(`── 열릴 회차 ${t.open.length}개 ──────────────────────────────────`);
  console.log(`  ${pad("surface", 8)} ${pad("project", 38)} ${pad("anchor", 26)} ${pad("week", 12)} runs`);
  for (const r of t.open) {
    console.log(`  ${pad(r.surface, 8)} ${pad(r.projectId, 38)} ${pad(r.anchorAt, 26)} ${pad(r.cycleWeek, 12)} ${r.runs}`);
  }

  const a = t.attribution;
  console.log(`\n── 귀속 ──────────────────────────────────────────────────────`);
  console.log(`  scope ${a.scope} · derived ${a.derived} · late ${a.late}  (프로젝트 ${a.projects})`);
  console.log(
    `  이월(상한 초과) ${a.deferred} — 다음 패스가 이어받는다` +
      (a.deferred > 0 ? "  ⚠ 적체" : ""),
  );
  console.log(`  미귀속(첫 anchor 이전) ${a.unattributed} — 사실표 밖, 미러 경로에만 남는다`);

  console.log(`\n── 종결 판정 ${t.close.length}건 ──────────────────────────────`);
  console.log(`  ${pad("surface", 8)} ${pad("project", 38)} ${pad("anchor", 26)} ${pad("status", 10)} ${pad("closed_by", 15)} 비고`);
  for (const r of t.close) {
    console.log(`  ${pad(r.surface, 8)} ${pad(r.projectId, 38)} ${pad(r.anchorAt, 26)} ${pad(r.status, 10)} ${pad(r.closedBy, 15)} ${r.blockedBy ? `집행 안 함 (${r.blockedBy})` : "집행"}`);
  }

  console.log(`\n── 카운터(귀속 후 예상) ${t.counters.length}건 ────────────────`);
  console.log(`  ${pad("project", 38)} ${pad("anchor", 26)} ${pad("expected", 9)} ${pad("completed", 10)} ${pad("완료율", 8)} 분석갭`);
  for (const r of t.counters) {
    const cr = r.completionRatio === null ? "—" : `${(Number(r.completionRatio) * 100).toFixed(2)}%`;
    const gr = r.analysisGapRatio === null ? "—" : `${(Number(r.analysisGapRatio) * 100).toFixed(2)}%`;
    console.log(`  ${pad(r.projectId, 38)} ${pad(r.anchorAt, 26)} ${pad(String(r.expectedUnits), 9)} ${pad(String(r.completedUnits), 10)} ${pad(cr, 8)} ${gr}${Number(r.analysisGapRatio) > 0.05 ? "  ⚠ 게이트 초과(생성 보류)" : ""}`);
  }

  console.log(`\n요약: 열림 ${res.opened} · 종결 ${res.closed} · 귀속 ${res.attributed} (late ${res.late}) · 미귀속 ${res.unattributed}`);
  if (res.errors.length) console.log(`오류: ${res.errors.join(" | ")}`);
  console.log("");
}
process.exit(0);
