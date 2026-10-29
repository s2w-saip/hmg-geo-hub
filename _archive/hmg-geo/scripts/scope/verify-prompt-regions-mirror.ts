/**
 * 로컬 카탈로그(`prompts`) ↔ 미러(`scope_prompts`) 의 `lang`·`regions` 대조.
 *
 * ── 무엇을 세는가 ─────────────────────────────────────────────────────────
 * ① **미러 충전율** — `scope_prompts` 전체 중 `regions`/`lang` 이 NULL 이 아닌 행 수.
 *    migration 0048 직후에는 전량 NULL 이고, 미러 싱크(`lib/scope/mirror/sync.ts`)가
 *    한 패스 돌면 scope 응답값으로 채워진다. **이 수치가 H3(집계 술어 교체)의 머지
 *    게이트다** — 미러가 비어 있는 상태로 술어를 바꾸면 무제외로 퇴화하거나 반대로
 *    전량 탈락한다(표준 화면 전체 공백 사고 전력 2회).
 * ② **불일치 행 수** — `prompts.scope_prompt_id` 로 이어지는 짝에서 두 쪽의
 *    `lang`/`regions` 가 다른 행. 카테고리별로 나눠 센다(아래).
 *
 * ── 무엇을 하지 않는가 ────────────────────────────────────────────────────
 * **쓰기를 하지 않는다. UPDATE 도 백필도 없다 — SELECT 뿐이다.**
 * 불일치를 덮어쓰면 지문이 사라진다. 이 스크립트의 목적은 그 지문을 보존한 채
 * 세는 것이다. 불일치는 결함이 아니라 **원인의 신호**이며, 어느 쪽이 정본인지는
 * 카테고리마다 다르다:
 *
 *   MIRROR_ROW_MISSING   카탈로그가 가리키는 scope prompt 가 미러에 아예 없다.
 *                        → 그 프로젝트가 아직 싱크되지 않았거나 scope 에서 삭제됨.
 *   MIRROR_NULL          카탈로그엔 값이 있는데 미러는 NULL.
 *                        → **발행 누락**(로컬 편집이 scope 로 push 되지 않음) 또는
 *                          싱크 미도달. 0048 적용 직후에는 전량 여기로 떨어진다.
 *   CATALOG_NULL         미러엔 값이 있는데 카탈로그는 NULL.
 *                        → scope 쪽에서 직접 편집됐거나 카탈로그 백필 누락.
 *   VALUE_DIFFERS        양쪽 다 값이 있는데 다르다.
 *                        → **어드민 편집 미전파**가 가장 흔한 원인. 편집 방향
 *                          (로컬→scope)을 생각하면 카탈로그가 새 값, 미러가 옛 값이다.
 *   CASE_ONLY (lang)     대소문자만 다르다(`ko` vs `KO`). 값 자체는 같으므로
 *                        VALUE_DIFFERS 와 분리해 센다 — 정규화 드리프트의 지문이다.
 *
 * regions 비교는 **순서 무관 집합**이다(중복 제거 후 정렬). 순서만 다른 것은
 * 불일치로 세지 않는다 — 배열 순서는 어느 쪽 계약에도 의미가 없다.
 * NULL 과 빈 배열은 **둘 다 '미지정'으로 접어서** 비교한다: 집계 술어가
 * `cardinality(regions) > 0` 로 가르므로 두 표현은 같은 판정을 낳는다.
 *
 * ⚠️ 다대일 주의 — 브랜드 분할 등으로 여러 카탈로그 행이 같은 `scope_prompt_id`
 * 를 가리킬 수 있다. 그 경우 "불일치 행 수"의 분모가 프롬프트 수가 아니게 되므로
 * 중복 링크 수를 따로 출력한다.
 *
 *   npm run verify:prompt-regions
 *   (= tsx --env-file=.env.local scripts/scope/verify-prompt-regions-mirror.ts)
 *
 * exit 0 = 불일치 0 · exit 1 = 불일치 발견 또는 실행 실패. 읽기 전용.
 */
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("✗ DATABASE_URL not set in .env.local");
  process.exit(1);
}
const sql = postgres(DATABASE_URL, { prepare: false });

/** 보고에 싣는 카테고리별 예시 개수 — 전량을 쏟지 않는다. */
const SAMPLE = 10;

type CoverageRow = {
  total: string;
  regions_filled: string;
  lang_filled: string;
  regions_empty_array: string;
};

type MismatchRow = {
  field: "lang" | "regions";
  category: string;
  n: string;
};

type SampleRow = {
  field: string;
  category: string;
  scope_prompt_id: string;
  catalog_value: string | null;
  mirror_value: string | null;
};

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(2)}%`;
}

async function main() {
  // ── 0. 스키마 선확인 — 0048 미적용 환경에서 42703 으로 죽지 않고 명확히 보고한다.
  const cols = await sql<{ attname: string }[]>`
    SELECT attname FROM pg_attribute
    WHERE attrelid = 'public.scope_prompts'::regclass
      AND attname IN ('lang', 'regions')
      AND NOT attisdropped
  `;
  const have = new Set(cols.map((c) => c.attname));
  if (!have.has("lang") || !have.has("regions")) {
    console.error(
      `✗ scope_prompts 에 lang/regions 가 없다 (있는 것: ${[...have].join(", ") || "없음"}).\n` +
        `  migration 0048 을 먼저 적용할 것: npm run db:apply -- 0048`,
    );
    process.exit(1);
  }

  // ── 1. 미러 충전율 (H3 머지 게이트)
  const [cov] = await sql<CoverageRow[]>`
    SELECT count(*)::text                                          AS total,
           count(*) FILTER (WHERE regions IS NOT NULL)::text        AS regions_filled,
           count(*) FILTER (WHERE lang IS NOT NULL)::text           AS lang_filled,
           count(*) FILTER (WHERE regions IS NOT NULL
                              AND cardinality(regions) = 0)::text   AS regions_empty_array
    FROM scope_prompts
  `;
  const total = Number(cov.total);
  const regionsFilled = Number(cov.regions_filled);
  const langFilled = Number(cov.lang_filled);

  console.log("── 미러 충전율 (scope_prompts 전체) ──────────────────────────");
  console.log(`  행 수                 ${total.toLocaleString()}`);
  console.log(
    `  regions NOT NULL      ${regionsFilled.toLocaleString()} (${pct(regionsFilled, total)})` +
      `  · 그중 빈 배열 ${Number(cov.regions_empty_array).toLocaleString()}`,
  );
  console.log(`  lang    NOT NULL      ${langFilled.toLocaleString()} (${pct(langFilled, total)})`);

  // ── 2. 링크 현황
  const [link] = await sql<{ linked: string; distinct_scope: string; orphan: string }[]>`
    SELECT count(*)::text                              AS linked,
           count(DISTINCT p.scope_prompt_id)::text     AS distinct_scope,
           count(*) FILTER (
             WHERE NOT EXISTS (SELECT 1 FROM scope_prompts sp
                               WHERE sp.prompt_id = p.scope_prompt_id)
           )::text                                     AS orphan
    FROM prompts p
    WHERE p.scope_prompt_id IS NOT NULL
  `;
  const linked = Number(link.linked);
  const distinctScope = Number(link.distinct_scope);
  console.log("\n── 카탈로그 ↔ 미러 링크 ─────────────────────────────────────");
  console.log(`  scope_prompt_id 보유 카탈로그 행   ${linked.toLocaleString()}`);
  console.log(
    `  그 중 서로 다른 scope prompt       ${distinctScope.toLocaleString()}` +
      (linked === distinctScope
        ? "  (1:1)"
        : `  ⚠️ 다대일 ${(linked - distinctScope).toLocaleString()}행 — 아래 불일치 분모 주의`),
  );
  console.log(`  미러에 짝이 없는 링크 (MIRROR_ROW_MISSING)  ${Number(link.orphan).toLocaleString()}`);

  // ── 3. 불일치 — 카테고리별 집계
  //    양쪽 값을 같은 규칙으로 정규화한 뒤 비교한다. regions 는 NULL/빈배열을
  //    '미지정'으로 접고 중복 제거 + 정렬(순서 무관), lang 은 공백 trim.
  const paired = sql`
    WITH cat AS (
      SELECT p.scope_prompt_id AS pid,
             nullif(btrim(p.lang), '') AS lang,
             CASE
               WHEN p.regions IS NULL OR cardinality(p.regions) = 0 THEN NULL
               ELSE (SELECT array_agg(DISTINCT v ORDER BY v)
                     FROM unnest(p.regions) AS v
                     WHERE nullif(btrim(v), '') IS NOT NULL)
             END AS regions
      FROM prompts p
      WHERE p.scope_prompt_id IS NOT NULL
    ),
    mir AS (
      SELECT sp.prompt_id AS pid,
             nullif(btrim(sp.lang), '') AS lang,
             CASE
               WHEN sp.regions IS NULL OR cardinality(sp.regions) = 0 THEN NULL
               ELSE (SELECT array_agg(DISTINCT v ORDER BY v)
                     FROM unnest(sp.regions) AS v
                     WHERE nullif(btrim(v), '') IS NOT NULL)
             END AS regions
      FROM scope_prompts sp
    )
    SELECT cat.pid,
           cat.lang AS c_lang, mir.lang AS m_lang,
           cat.regions AS c_regions, mir.regions AS m_regions
    FROM cat JOIN mir ON mir.pid = cat.pid
  `;

  const counts = await sql<MismatchRow[]>`
    WITH p AS (${paired})
    SELECT 'lang' AS field, cat AS category, count(*)::text AS n
    FROM (
      SELECT CASE
        WHEN c_lang IS NOT DISTINCT FROM m_lang THEN 'MATCH'
        WHEN c_lang IS NOT NULL AND m_lang IS NULL THEN 'MIRROR_NULL'
        WHEN c_lang IS NULL AND m_lang IS NOT NULL THEN 'CATALOG_NULL'
        WHEN upper(c_lang) = upper(m_lang) THEN 'CASE_ONLY'
        ELSE 'VALUE_DIFFERS'
      END AS cat FROM p
    ) t GROUP BY cat
    UNION ALL
    SELECT 'regions', cat, count(*)::text
    FROM (
      SELECT CASE
        WHEN c_regions IS NOT DISTINCT FROM m_regions THEN 'MATCH'
        WHEN c_regions IS NOT NULL AND m_regions IS NULL THEN 'MIRROR_NULL'
        WHEN c_regions IS NULL AND m_regions IS NOT NULL THEN 'CATALOG_NULL'
        ELSE 'VALUE_DIFFERS'
      END AS cat FROM p
    ) t GROUP BY cat
  `;

  const byField = (f: string) =>
    counts
      .filter((c) => c.field === f)
      .sort((a, b) => Number(b.n) - Number(a.n))
      .map((c) => ({ ...c, num: Number(c.n) }));

  let mismatchTotal = 0;
  console.log("\n── 불일치 (짝이 있는 행만) ──────────────────────────────────");
  for (const field of ["lang", "regions"] as const) {
    const rows = byField(field);
    const denom = rows.reduce((s, r) => s + r.num, 0);
    console.log(`  ${field} (짝 ${denom.toLocaleString()}행)`);
    for (const r of rows) {
      if (r.category !== "MATCH") mismatchTotal += r.num;
      const mark = r.category === "MATCH" ? "·" : "✗";
      console.log(
        `    ${mark} ${r.category.padEnd(14)} ${r.num.toLocaleString().padStart(9)} (${pct(r.num, denom)})`,
      );
    }
  }
  mismatchTotal += Number(link.orphan);

  // ── 4. 카테고리별 예시
  if (mismatchTotal > 0) {
    const samples = await sql<SampleRow[]>`
      WITH p AS (${paired}),
      tagged AS (
        SELECT 'lang' AS field, pid,
               CASE
                 WHEN c_lang IS NOT DISTINCT FROM m_lang THEN 'MATCH'
                 WHEN c_lang IS NOT NULL AND m_lang IS NULL THEN 'MIRROR_NULL'
                 WHEN c_lang IS NULL AND m_lang IS NOT NULL THEN 'CATALOG_NULL'
                 WHEN upper(c_lang) = upper(m_lang) THEN 'CASE_ONLY'
                 ELSE 'VALUE_DIFFERS'
               END AS category,
               c_lang AS cv, m_lang AS mv
        FROM p
        UNION ALL
        SELECT 'regions', pid,
               CASE
                 WHEN c_regions IS NOT DISTINCT FROM m_regions THEN 'MATCH'
                 WHEN c_regions IS NOT NULL AND m_regions IS NULL THEN 'MIRROR_NULL'
                 WHEN c_regions IS NULL AND m_regions IS NOT NULL THEN 'CATALOG_NULL'
                 ELSE 'VALUE_DIFFERS'
               END,
               array_to_string(c_regions, ','), array_to_string(m_regions, ',')
        FROM p
      )
      SELECT field, category, pid::text AS scope_prompt_id,
             cv AS catalog_value, mv AS mirror_value
      FROM (
        SELECT *, row_number() OVER (PARTITION BY field, category ORDER BY pid) AS rn
        FROM tagged WHERE category <> 'MATCH'
      ) s
      WHERE rn <= ${SAMPLE}
      ORDER BY field, category, scope_prompt_id
    `;
    if (samples.length) {
      console.log(`\n── 예시 (카테고리당 최대 ${SAMPLE}건) ───────────────────────`);
      let head = "";
      for (const s of samples) {
        const key = `${s.field}/${s.category}`;
        if (key !== head) {
          head = key;
          console.log(`  [${key}]`);
        }
        console.log(
          `    ${s.scope_prompt_id}  카탈로그=${s.catalog_value ?? "NULL"}  미러=${s.mirror_value ?? "NULL"}`,
        );
      }
    }
  }

  console.log("\n────────────────────────────────────────────────────────────");
  if (mismatchTotal === 0) {
    console.log("✓ PASS — 불일치 0건. 쓰기는 하지 않았다(SELECT 전용).");
  } else {
    console.log(
      `✗ 불일치 ${mismatchTotal.toLocaleString()}건. **덮어쓰지 않았다** — 위 카테고리로\n` +
        `  원인(발행 누락 / 싱크 미도달 / 어드민 편집 미전파)을 먼저 판정할 것.`,
    );
  }
  await sql.end();
  process.exit(mismatchTotal === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("✗ 실행 실패:", e);
  await sql.end().catch(() => {});
  process.exit(1);
});
