// 회차 **원장 숨김** 토글 (0070) + **숨김 범위** (0071) — 수집이 깨진 회차를 화면에서
// 내리되 데이터는 남긴다. 범위를 주면 깨진 계열만 내린다.
//
// 실행: bash (내부 작업 파일) <워크트리> \
//         npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/hide-cycle.ts \
//         <cycle_id> --reason=collection_error|operator [--scope=all|citations] [--unhide] [--yes]
//
//   · 인자만 주고 `--yes` 를 빼면 **dry-run** — 대상 1행을 출력하고 아무것도 안 쓴다.
//     (read-switch.ts 와 달리 이 스크립트는 값을 바꾸므로 기본값을 쓰기가 아닌 쪽에 둔다.)
//   · `--unhide` 는 `hidden_reason`·`hidden_at`·`hidden_scope` 를 **전부** NULL 로 되돌린다.
//     가역이 숨김의 존재 이유이므로 되돌리기가 같은 스크립트 안에 있어야 한다.
//   · **`--scope`(0071)** 는 숨김의 **범위**다. 기본 `all` = 회차 전체(0071 이전과 동일).
//     `citations` 는 인용 계열만 내리고 **언급 계열 값은 그대로 낸다** — 2026-09-11 운영
//     지시("8/24 인용만 누락된거라 멘션에 대한 부분은 살려줘야해")의 집행 지점이다.
//     0071 미적용 DB 에서 `--scope=citations` 는 **거절**한다(조용히 all 로 안 떨어뜨린다).
//   · 같은 회차·같은 사유에서 범위만 바꾸면 **`hidden_at` 은 보존**한다(D-3 A) —
//     "언제 내렸나" 의 진실이 범위 변경으로 흔들리면 안 된다.
//   · 접속은 `DATABASE_URL` env 하나뿐이다 — 값을 argv 로 받지 않는다(`ps` 노출).
//
// ⚠️ **무엇이 바뀌는가**
//   숨긴 회차는 세 곳에서 동시에 빠진다:
//     ① 미러 리더 — `excludeHiddenCycleRuns()` 가 그 회차 귀속 run 의 답변을 통째로 뺀다
//        (인용 주별 도메인·언급 주별·경쟁사 brand/rank 추이).
//     ② 집계층 회차 집합 — `cycle-set.ts` 가 skipped 로 판정해 창에서 뺀다(**구멍이 아니다**).
//     ③ 스냅샷 픽 — `pickGlobalCycle`·`pickWebsiteCycles` 가 그 회차를 안 고른다.
//        즉 **가장 최근 회차를 숨기면 화면의 "측정 기준일"이 직전 회차로 물러난다.**
//   그리고 사유가 `collection_error` 면 그 자리에 **갭 슬롯**(음영 + "오류로 인해 수집되지
//   않음")이 생긴다. `operator` 는 값만 빠지고 슬롯은 안 생긴다(문구가 사실이 아니므로).
//
// ⚠️ **캐시** — 리더 결과는 `mirrorCache`(unstable_cache TTL 7,200s = 2시간)에 있다.
//   갭 슬롯 자체는 캐시 **밖**에서 얹으므로 즉시 반영되지만, ①의 값 제외는 캐시된 셀이
//   만료되거나 무효화될 때까지 남는다. 즉시 반영이 필요하면 아래 출력의 revalidate 를 돌린다.

import postgres from "postgres";
import { hideCycleWarnings } from "./hide-cycle-warning";

const REASONS = ["collection_error", "operator"] as const;
type Reason = (typeof REASONS)[number];

/** 원장 CHECK(`summary_cycles_hidden_scope_ck`)와 같은 어휘. NULL = 'all'. */
const SCOPES = ["all", "citations"] as const;
type Scope = (typeof SCOPES)[number];

const USAGE = `usage: hide-cycle.ts <cycle_id> --reason=${REASONS.join("|")} [--scope=${SCOPES.join("|")}] [--unhide] [--yes]
  --unhide 면 --reason·--scope 는 필요 없다(있으면 무시하지 않고 거절한다 — 의도가 모순이다).
  --scope 기본값은 all(회차 전체). citations 는 인용 계열만 내린다(0071).
  --yes 가 없으면 dry-run(대상만 출력).`;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
const kv = new Map(
  argv
    .filter((a) => a.startsWith("--") && a.includes("="))
    .map((a) => [a.slice(2, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] as const),
);
const positional = argv.filter((a) => !a.startsWith("--"));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(msg: string): never {
  console.error(`${msg}\n${USAGE}`);
  process.exit(1);
}

const cycleId = positional[0];
if (!cycleId || !UUID_RE.test(cycleId)) fail(`cycle_id 가 uuid 가 아니다: ${cycleId ?? "(없음)"}`);

const unhide = flags.has("--unhide");
const apply = flags.has("--yes");
const reasonArg = kv.get("reason");
const scopeArg = kv.get("scope");
if (unhide && reasonArg) fail("--unhide 와 --reason 을 같이 줄 수 없다.");
if (unhide && scopeArg) fail("--unhide 와 --scope 를 같이 줄 수 없다.");
if (!unhide && !reasonArg) fail("--reason 이 필요하다.");
if (!unhide && !REASONS.includes(reasonArg as Reason)) fail(`알 수 없는 사유: ${reasonArg}`);
if (scopeArg && !SCOPES.includes(scopeArg as Scope)) fail(`알 수 없는 범위: ${scopeArg}`);
const reason = unhide ? null : (reasonArg as Reason);
// 기본값은 **종전 동작**(회차 전체). 범위를 좁히는 것은 명시적 의도여야 한다.
const scope: Scope | null = unhide ? null : ((scopeArg as Scope) ?? "all");

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) fail("DATABASE_URL 이 없다 — 환경변수로 주입해 실행할 것.");

const sql = postgres(dbUrl, { max: 1, prepare: false, ssl: "require" });

interface CycleRow {
  cycle_id: string;
  surface: string;
  project_id: string;
  cycle_anchor_at: Date;
  cycle_week: Date;
  status: string;
  active_generation_id: string | null;
  expected_units: number | null;
  completed_units: number | null;
  hidden_reason: string | null;
  hidden_at: Date | null;
  hidden_scope: string | null;
  runs: number;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

try {
  // 컬럼이 없으면 0070 미적용이다 — 조용히 실패하지 않고 먼저 말한다.
  const [cols] = await sql<[{ n: number }]>`
    SELECT count(*)::int AS n FROM pg_attribute
    WHERE attrelid = to_regclass('public.summary_cycles')
      AND attname IN ('hidden_reason','hidden_at') AND NOT attisdropped
  `;
  if (!cols || cols.n < 2) {
    throw new Error("summary_cycles.hidden_reason/hidden_at 이 없다 — 0070 을 먼저 적용할 것.");
  }

  // 0071(범위)은 따로 묻는다 — 0070 만 적용된 DB 에서도 종전 사용법은 그대로 돼야 한다.
  const [scopeCols] = await sql<[{ n: number }]>`
    SELECT count(*)::int AS n FROM pg_attribute
    WHERE attrelid = to_regclass('public.summary_cycles')
      AND attname = 'hidden_scope' AND NOT attisdropped
  `;
  const hasScope = (scopeCols?.n ?? 0) > 0;
  // 조용히 `all` 로 떨어뜨리지 않는다 — 그러면 "인용만 내렸다"고 믿는 채로 회차 전체가
  // 내려간다(= 이 작업이 고치려는 바로 그 사고의 재현).
  if (!hasScope && scope === "citations") {
    throw new Error(
      "summary_cycles.hidden_scope 가 없다 — --scope=citations 를 쓰려면 0071 을 먼저 적용할 것(npm run db:apply -- 0071).",
    );
  }

  // 대상 1행 — 무엇을 숨기는지 눈으로 확인하고 쓴다(회차 id 는 눈으로 못 읽는다).
  const before = await sql<CycleRow[]>`
    SELECT c.cycle_id::text, c.surface, c.project_id::text, c.cycle_anchor_at, c.cycle_week,
           c.status, c.active_generation_id::text, c.expected_units, c.completed_units,
           c.hidden_reason, c.hidden_at,
           ${hasScope ? sql`c.hidden_scope` : sql`NULL::text AS hidden_scope`},
           (SELECT count(*)::int FROM summary_cycle_runs r WHERE r.cycle_id = c.cycle_id) AS runs
    FROM summary_cycles c WHERE c.cycle_id = ${cycleId}::uuid
  `;
  if (before.length !== 1) throw new Error(`회차를 못 찾았다(rows=${before.length}): ${cycleId}`);
  const b = before[0];
  console.log("대상 회차:");
  console.log(`  cycle_id   = ${b.cycle_id}`);
  console.log(`  surface    = ${b.surface}   project_id = ${b.project_id}`);
  console.log(`  anchor     = ${b.cycle_anchor_at.toISOString()}   cycle_week = ${day(b.cycle_week)}`);
  console.log(`  status     = ${b.status}   generation = ${b.active_generation_id ?? "(없음)"}`);
  console.log(`  units      = completed ${b.completed_units ?? "-"} / expected ${b.expected_units ?? "-"}   runs = ${b.runs}`);
  console.log(`  hidden     = ${b.hidden_reason ?? "(아님)"}${b.hidden_at ? ` @ ${b.hidden_at.toISOString()}` : ""}`);
  // 범위는 **현재값과 요청값을 나란히** 찍는다 — 두 값 중 하나만 보이면 "이미 그 상태"
  // 인지 "넓히는 중"인지 눈으로 못 가른다.
  console.log(
    `  scope      = ${hasScope ? `${b.hidden_scope ?? "(NULL = all)"}` : "(0071 미적용 — 항상 all)"}`,
  );
  console.log(
    `\n요청: ${unhide ? "숨김 해제" : `숨김(${reason}) · 범위 ${scope}${scope === "citations" ? " — 인용 계열만" : " — 회차 전체"}`}`,
  );

  if (!apply) {
    console.log("\n--yes 가 없다 → **dry-run**. 아무것도 쓰지 않았다.");
    process.exit(0);
  }

  // 멱등 — 이미 같은 상태면 0행이고, 그때는 rowcount 단언이 아니라 안내로 닫는다.
  // 범위는 NULL = 'all' 이므로 COALESCE 로 접어 비교한다(0071 미적용이면 항상 'all').
  const curScope = hasScope ? (b.hidden_scope ?? "all") : "all";
  const noop = unhide
    ? b.hidden_reason === null
    : b.hidden_reason === reason && curScope === scope;
  if (noop) {
    console.log("\n이미 그 상태다 — 쓰지 않았다(멱등).");
    process.exit(0);
  }

  // 사유가 그대로면 `hidden_at` 을 **보존**한다(D-3 A, 운영 2026-09-11) — 범위만 바꾸는데
  // "언제 내렸나" 가 흔들리면 원장이 거짓말을 한다. 사유가 바뀌면 그때는 새로 내린 것이다.
  const keepHiddenAt = !unhide && b.hidden_reason === reason && b.hidden_at !== null;
  const hiddenAtExpr = keepHiddenAt ? sql`hidden_at` : sql`now()`;
  // 세 칸을 **한 문장**으로 쓴다 — 두 문장으로 나누면 그 사이에 CHECK 를 위반하는
  // 중간 상태가 생긴다(0070 이 사유·시각을 한 쌍으로 묶은 것과 같은 이유).
  const scopeSet = hasScope ? sql`, hidden_scope = ${scope}` : sql``;
  const scopeRet = hasScope ? sql`, hidden_scope` : sql`, NULL::text AS hidden_scope`;
  const updated = unhide
    ? await sql<CycleRow[]>`
        UPDATE summary_cycles SET hidden_reason = NULL, hidden_at = NULL${
          hasScope ? sql`, hidden_scope = NULL` : sql``
        }
        WHERE cycle_id = ${cycleId}::uuid
        RETURNING cycle_id::text, surface, project_id::text, cycle_anchor_at, cycle_week,
                  status, active_generation_id::text, expected_units, completed_units,
                  hidden_reason, hidden_at${scopeRet}, 0 AS runs
      `
    : await sql<CycleRow[]>`
        UPDATE summary_cycles SET hidden_reason = ${reason}, hidden_at = ${hiddenAtExpr}${scopeSet}
        WHERE cycle_id = ${cycleId}::uuid
        RETURNING cycle_id::text, surface, project_id::text, cycle_anchor_at, cycle_week,
                  status, active_generation_id::text, expected_units, completed_units,
                  hidden_reason, hidden_at${scopeRet}, 0 AS runs
      `;
  // rowcount 단언 — 1행이 아니면 술어가 틀린 것이다(uuid 라 2행은 불가능하지만, 0행은
  // 경합으로 가능하다. 0행을 성공으로 세면 "숨겼다"는 보고가 거짓이 된다).
  if (updated.length !== 1) throw new Error(`expected 1 row updated, got ${updated.length}`);
  const a = updated[0];
  console.log(
    `\n✅ 갱신: hidden_reason = ${a.hidden_reason ?? "NULL"}${a.hidden_at ? ` @ ${a.hidden_at.toISOString()}` : ""}` +
      `${hasScope ? ` · hidden_scope = ${a.hidden_scope ?? "NULL"}` : ""}` +
      `${keepHiddenAt ? "   (hidden_at 보존 — 사유가 그대로다)" : ""}`,
  );

  // 같은 주에 남는 회차 — 갭 슬롯이 생기는지 여기서 미리 보인다.
  const siblings = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM summary_cycles c
    WHERE c.surface = ${b.surface} AND c.project_id = ${b.project_id}::uuid
      AND c.cycle_week = ${day(b.cycle_week)}::date
      AND c.cycle_id <> ${cycleId}::uuid
      AND c.hidden_reason IS NULL
  `;
  const rest = siblings[0]?.n ?? 0;
  // 이 회차가 **축의 마지막 점**이었나. 갭 슬롯은 축 안쪽(첫 점~마지막 점)에만 끼워
  // 넣는다(`insertTrendGapSlots` 의 `trendGapKeyInAxis`) — 마지막 점을 숨기면 끼울
  // 자리가 없어 슬롯이 안 생기고, 축이 한 칸 짧아지면서 기준일만 물러난다.
  const newer = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM summary_cycles c
    WHERE c.surface = ${b.surface} AND c.project_id = ${b.project_id}::uuid
      AND c.cycle_anchor_at > ${b.cycle_anchor_at}
      AND c.hidden_reason IS NULL
  `;
  const wasLatest = (newer[0]?.n ?? 0) === 0;
  if (!unhide) {
    for (const warning of hideCycleWarnings({
      cycleWeek: day(b.cycle_week),
      remainingVisibleCyclesInWeek: rest,
      newerVisibleCycles: wasLatest ? 0 : (newer[0]?.n ?? 0),
      reason,
      scope: scope ?? "all",
    })) {
      console.log(warning);
    }
  }

  console.log(
    [
      "",
      "다음(캐시) — 값 제외는 mirrorCache(TTL 2시간) 안이라 즉시 반영되지 않는다:",
      "  · 앱에서 revalidateTag('summary') 를 태우거나(사실표 경로),",
      "  · 미러 셀은 TTL 만료를 기다리거나 배포로 캐시 세대를 올린다.",
      "  갭 슬롯 자체는 캐시 밖에서 얹으므로 다음 요청부터 바로 보인다.",
      "",
      "되돌리기:",
      `  npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/hide-cycle.ts ${cycleId} --unhide --yes`,
      ...(hasScope
        ? [
            "범위만 되돌리기(숨김은 유지):",
            `  npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/hide-cycle.ts ${cycleId} --reason=${reason} --scope=${scope === "citations" ? "all" : "citations"} --yes`,
          ]
        : []),
    ].join("\n"),
  );
} finally {
  await sql.end();
}
