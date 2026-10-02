/**
 * 발행값 동일성 대조 — 스펙 §U. **읽기 전용**(DB 에 쓰지 않는다).
 *
 *   npm run report:verify-parity -- <발행 HTML 경로> [--round=YYYY-MM-DD] [--surface=website]
 *
 * 무엇을 대조하나 — 셋 다 **정수 쌍**으로 본다(백분율은 반올림이 오차를 가린다):
 *   (a) 발행 HTML 의 `sb-data`  ↔  적재된 `report_site_facts` 전수
 *       105행 × 7지표(c6·co·cs·np·na·q6·qo) + 분류 4종(브랜드·국가·언어·상태)
 *   (b) 발행 HTML  ↔  **리더가 내는 값**. 리더의 부분합 규칙은 순수 함수
 *       (`lib/reports/truth-axes.ts`)이므로 그 함수를 **그대로 import 해서** DB 행에
 *       먹인다 — 규칙을 여기 다시 적으면 두 벌이 되어 한쪽만 낡는다.
 *       무필터 · 브랜드 3 · 국가 표본 · 언어 표본 · **상태 그룹 4**(화면에는 없고
 *       여기서만 본다 — 제품 결정 J-2).
 *   (c) **런타임 합성** — 리더가 실제로 거치는 경로. `website_sites` 어휘의 분류를 DB 에서
 *       읽어 리더와 **같은 판정 함수**(`decidePublishedSelection`)에 함께 먹인다.
 *       브랜드 부분합이 발행물 `brandAvgAll` 과 정수 쌍까지 같은지, 어휘가 갈리는 유닛에
 *       닿는 국가 선택이 라이브로 떨어지는지를 본다.
 *
 *       ⚠️ (b) 만으로는 **부족하다**: (b) 는 `selectPublishedSites` 를 발행물 105행에
 *       직접 먹여 항상 통과한다. 2026-09-20 독립 검증이 잡은 결함(브랜드 = Hyundai 가
 *       42개가 아니라 40개 · 66.1% 로 나가면서 `published` 표식을 달던 것)이 정확히
 *       그 사각이었다. 어휘 두 벌(발행물 `sites[].b`·`dash.geo` vs 런타임
 *       `website_sites.brand`·`.country_code`, fs 40·41 에서 갈림)은 런타임을 태워야 보인다.
 *
 * 불일치가 하나라도 있으면 exit 1.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { extractSbData, parsePublication, pct1, pct2 } from "../../lib/reports/sb-data";
import {
  decidePublishedSelection,
  publishedSubtotal,
  selectPublishedSites,
  vocabularySplit,
  type PublishedSiteRow,
  type RuntimeSiteClass,
} from "../../lib/reports/truth-axes";

type Row = PublishedSiteRow & {
  countryName: string | null;
  langLabel: string | null;
  agencyStatus: string | null;
  ownedAnswers: number | null;
  monitoredAnswers: number | null;
  prompts: number | null;
  answers: number | null;
};

let failures = 0;
function check(name: string, expected: unknown, actual: unknown): void {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  const ok = e === a;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  기대 ${e} · 실제 ${a}`}`);
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (const a of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a);
    if (m) flags.set(m[1], m[2] ?? "");
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Error("사용법: npm run report:verify-parity -- <발행 HTML 경로>");
  return { file: rest[0], round: flags.get("round"), surface: flags.get("surface") || "website" };
}

const pair = (rows: readonly PublishedSiteRow[], applyPool: boolean) => {
  const sub = publishedSubtotal(applyPool ? rows : rows.map((r) => ({ ...r, inHeadlinePool: true })));
  return sub ? [sub.hitPrompts, sub.measuredPrompts] : null;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const abs = path.resolve(args.file);
  const bytes = fs.readFileSync(abs);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const sbRoot = extractSbData(bytes.toString("utf8")) as Record<string, unknown>;
  const parsed = parsePublication(sbRoot);
  const roundDate = args.round ?? parsed.meta.roundDate;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 이 없다 — .env.local 확인(값을 출력하지 않는다)");
  const conn = postgres(url, { prepare: false, connect_timeout: 15 });
  try {
    // 읽기 전용을 선언한다(Supavisor 트랜잭션 풀에서 GUC 가 새지 않도록 SET LOCAL).
    const pubs = await conn<Array<Record<string, unknown>>>`
      SELECT id::text AS id, slug, source_sha256, bench_n, bench_n_all,
             round_date::text AS round_date, manifest_verified, status
        FROM report_publications
       WHERE surface = ${args.surface} AND round_date = ${roundDate}::date AND status = 'active'`;
    if (pubs.length !== 1) {
      console.error(`✗ ${roundDate} 회차의 active 발행물이 ${pubs.length}건이다(기대 1건) — 적재부터 확인할 것`);
      process.exit(1);
    }
    const pub = pubs[0];
    console.log(`\n발행물  ${String(pub.slug)} · 회차 ${String(pub.round_date)} · 매니페스트 ${String(pub.manifest_verified)}`);

    console.log("\n── (0) 발행물 신원 ───────────────────────────────────────────────");
    check("source_sha256 = 이 HTML 의 해시", sha, String(pub.source_sha256));
    check("bench_n", parsed.meta.benchN, Number(pub.bench_n));
    check("bench_n_all", parsed.meta.benchNAll, Number(pub.bench_n_all));

    const raw = await conn<Array<Record<string, unknown>>>`
      SELECT file_seq, brand, country_code, country_name, lang_code, lang_label,
             agency_status, in_headline_pool,
             target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den,
             owned_answers, monitored_answers, prompts, answers,
             prev_target_hit_prompts, prev_measured_prompts,
             prev_owned_prompts, prev_owned_prompts_den
        FROM report_site_facts WHERE publication_id = ${String(pub.id)}::uuid ORDER BY file_seq`;
    const rows: Row[] = raw.map((r) => ({
      fileSeq: Number(r.file_seq),
      brand: String(r.brand),
      countryCode: (r.country_code as string | null) ?? null,
      countryName: (r.country_name as string | null) ?? null,
      langCode: (r.lang_code as string | null) ?? null,
      langLabel: (r.lang_label as string | null) ?? null,
      agencyStatus: (r.agency_status as string | null) ?? null,
      inHeadlinePool: r.in_headline_pool === true,
      targetHitPrompts: Number(r.target_hit_prompts),
      measuredPrompts: Number(r.measured_prompts),
      ownedPrompts: Number(r.owned_prompts),
      ownedPromptsDen: Number(r.owned_prompts_den),
      ownedAnswers: r.owned_answers === null ? null : Number(r.owned_answers),
      monitoredAnswers: r.monitored_answers === null ? null : Number(r.monitored_answers),
      prompts: r.prompts === null ? null : Number(r.prompts),
      answers: r.answers === null ? null : Number(r.answers),
      prevTargetHitPrompts: r.prev_target_hit_prompts === null ? null : Number(r.prev_target_hit_prompts),
      prevMeasuredPrompts: r.prev_measured_prompts === null ? null : Number(r.prev_measured_prompts),
      prevOwnedPrompts: r.prev_owned_prompts === null ? null : Number(r.prev_owned_prompts),
      prevOwnedPromptsDen: r.prev_owned_prompts_den === null ? null : Number(r.prev_owned_prompts_den),
    }));

    // ── (a) 전수 대조 ────────────────────────────────────────────────────────
    console.log("\n── (a) sb-data ↔ report_site_facts 전수 ──────────────────────────");
    check("사이트 행 수", parsed.sites.length, rows.length);
    const byFs = new Map(rows.map((r) => [r.fileSeq, r]));
    let siteMismatch = 0;
    for (const want of parsed.sites) {
      const got = byFs.get(want.fileSeq);
      if (!got) {
        siteMismatch += 1;
        console.log(`  ✗ fs ${want.fileSeq} 행이 표에 없다`);
        continue;
      }
      const w = [
        want.targetHitPrompts, want.measuredPrompts, want.ownedPrompts, want.ownedPromptsDen,
        want.ownedAnswers, want.monitoredAnswers, want.prompts, want.answers,
        want.prevTargetHitPrompts, want.prevMeasuredPrompts, want.prevOwnedPrompts, want.prevOwnedPromptsDen,
        want.brand, want.countryCode, want.langCode, want.agencyStatus, want.inHeadlinePool,
      ];
      const g = [
        got.targetHitPrompts, got.measuredPrompts, got.ownedPrompts, got.ownedPromptsDen,
        got.ownedAnswers, got.monitoredAnswers, got.prompts, got.answers,
        got.prevTargetHitPrompts, got.prevMeasuredPrompts, got.prevOwnedPrompts, got.prevOwnedPromptsDen,
        got.brand, got.countryCode, got.langCode, got.agencyStatus, got.inHeadlinePool,
      ];
      if (JSON.stringify(w) !== JSON.stringify(g)) {
        siteMismatch += 1;
        console.log(`  ✗ fs ${want.fileSeq}  기대 ${JSON.stringify(w)}\n            실제 ${JSON.stringify(g)}`);
      }
    }
    check(`사이트 × 17필드 불일치 (${parsed.sites.length}행)`, 0, siteMismatch);

    // ── (b) 리더 값 ──────────────────────────────────────────────────────────
    console.log("\n── (b) 리더 부분합 (truth-axes 순수 함수 그대로) ─────────────────");
    const want = (sel: typeof parsed.sites) => [
      sel.reduce((a, s) => a + s.targetHitPrompts, 0),
      sel.reduce((a, s) => a + s.measuredPrompts, 0),
    ];
    const poolOf = (sel: typeof parsed.sites) => sel.filter((s) => s.inHeadlinePool);

    check("무필터 (헤드라인 풀)", want(poolOf(parsed.sites)), pair(rows, true));
    const noFilter = publishedSubtotal(rows)!;
    console.log(
      `      → ${noFilter.hitPrompts} / ${noFilter.measuredPrompts} = ${pct1(noFilter.hitPrompts, noFilter.measuredPrompts)}% ` +
        `(발행물 ${pct2(noFilter.hitPrompts, noFilter.measuredPrompts)}%) · 사이트 ${noFilter.siteCount}개`,
    );
    check(
      "무필터 자사 URL 인용률",
      [poolOf(parsed.sites).reduce((a, s) => a + s.ownedPrompts, 0), want(poolOf(parsed.sites))[1]],
      [noFilter.ownedPrompts, noFilter.measuredPrompts],
    );
    check(
      "무필터 직전 회차 쌍(증감의 분모)",
      [
        poolOf(parsed.sites).reduce((a, s) => a + (s.prevTargetHitPrompts ?? 0), 0),
        poolOf(parsed.sites).reduce((a, s) => a + (s.prevMeasuredPrompts ?? 0), 0),
      ],
      [noFilter.prev.hitPrompts, noFilter.prev.measuredPrompts],
    );

    for (const brand of ["Hyundai", "Kia", "Genesis"]) {
      check(
        `brand=${brand}`,
        want(poolOf(parsed.sites.filter((s) => s.brand === brand))),
        pair(selectPublishedSites(rows, { brand: [brand] }), true),
      );
    }

    const countries = [...new Set(parsed.sites.map((s) => s.countryCode).filter(Boolean))].slice(0, 12);
    for (const c of countries) {
      check(
        `country=${c}`,
        want(poolOf(parsed.sites.filter((s) => s.countryCode === c))),
        pair(selectPublishedSites(rows, { countryCode: [c as string] }), true),
      );
    }

    const langs = [...new Set(parsed.sites.map((s) => s.langCode).filter(Boolean))].slice(0, 8);
    for (const l of langs) {
      check(
        `lang=${l}`,
        want(poolOf(parsed.sites.filter((s) => s.langCode === l))),
        pair(selectPublishedSites(rows, { langCode: [l as string] }), true),
      );
    }

    // 상태 그룹 — **화면에는 없다**(J-2). 제품 책임자의 대조 기준('완료 13개')을 여기서 재현한다.
    console.log("\n── (b') 상태 그룹 — 대조 전용(화면 미노출) ──────────────────────");
    for (const st of ["완료", "진행중", "논의중", "무응답"]) {
      const sel = rows.filter((r) => r.agencyStatus === st);
      const sub = publishedSubtotal(sel);
      check(`status=${st}`, want(poolOf(parsed.sites.filter((s) => s.agencyStatus === st))), sub ? [sub.hitPrompts, sub.measuredPrompts] : null);
      if (st === "완료" && sub) {
        console.log(`      → ${sub.hitPrompts} / ${sub.measuredPrompts} = ${pct1(sub.hitPrompts, sub.measuredPrompts)}%  (기대 641 / 966 = 66.4%)`);
      }
    }

    // 제외 유닛만 고른 경우 — 헤드라인 풀 교집합이 비어 그 유닛 자신의 값이 나와야 한다.
    const excludedFs = parsed.headlinePool.excludedFileSeqs;
    if (excludedFs.length > 0) {
      const only = rows.filter((r) => excludedFs.includes(r.fileSeq));
      const sub = publishedSubtotal(only);
      const src = parsed.sites.filter((s) => excludedFs.includes(s.fileSeq));
      check(
        `제외 유닛만 선택(fs ${excludedFs.join(",")}) — 그 유닛 값이 보인다`,
        [src.reduce((a, s) => a + s.targetHitPrompts, 0), src.reduce((a, s) => a + s.measuredPrompts, 0)],
        sub ? [sub.hitPrompts, sub.measuredPrompts] : null,
      );
    }

    // ── (c) **런타임 합성** — 리더가 실제로 거치는 경로 그대로 ────────────────
    //
    // 2026-09-20 검증이 잡은 결함이 여기서 안 보였다: (b) 는 `selectPublishedSites` 를
    // 발행물 105행에 **직접** 먹여 항상 통과했지만, 런타임은 `website_sites` 어휘로
    // 스코프를 좁힌 뒤 부분합을 냈다. 두 어휘가 fs 40·41 에서 갈려 브랜드 = Hyundai 가
    // 42개가 아니라 40개(66.1%)로 나갔다. 그래서 여기서는 **런타임 분류를 DB 에서 읽어**
    // 리더와 같은 함수(`decidePublishedSelection`)에 함께 먹인다.
    console.log("\n── (c) 런타임 합성 (리더와 같은 판정 함수) ──────────────────────");
    const runtimeRows = await conn<
      Array<{ file_seq: number; brand: string; country_code: string | null; lang_codes: string[] }>
    >`
      SELECT wp.file_seq AS file_seq, ws.brand AS brand, ws.country_code AS country_code,
             array_agg(DISTINCT wp.lang_code) AS lang_codes
        FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
       WHERE ws.scope_project_id IS NOT NULL
       GROUP BY wp.file_seq, ws.brand, ws.country_code`;
    const runtime: RuntimeSiteClass[] = runtimeRows.map((r) => ({
      fileSeq: Number(r.file_seq),
      brand: String(r.brand),
      countryCode: r.country_code,
      langCodes: (r.lang_codes ?? []).filter((v): v is string => typeof v === "string"),
    }));
    const runtimeFs = new Set(runtime.map((r) => r.fileSeq));
    check(
      "발행 유닛이 전부 website_prompts 에 있다 (없으면 권한 게이트가 항상 라이브로 떨어진다)",
      [],
      rows.filter((r) => !runtimeFs.has(r.fileSeq)).map((r) => r.fileSeq),
    );

    // 어휘가 갈리는 유닛은 **오류가 아니다** — 갈린다는 사실을 드러내고, 그 유닛에
    // 닿는 국가·언어 선택이 라이브로 떨어지는지를 아래에서 본다.
    const split = [...vocabularySplit(rows, runtime)].sort((a, b) => a - b);
    const byFsRun = new Map(runtime.map((r) => [r.fileSeq, r]));
    console.log(`  · 어휘 분기 ${split.length}건${split.length ? `: fs ${split.join(",")}` : ""}`);
    for (const fs of split) {
      const p = rows.find((r) => r.fileSeq === fs)!;
      const r = byFsRun.get(fs);
      console.log(
        `      fs ${fs}  발행물(${p.brand}, ${p.countryCode}, ${p.langCode})` +
          `  vs  런타임(${r?.brand}, ${r?.countryCode}, ${r?.langCodes.join("/")})`,
      );
    }

    const decide = (axes: Parameters<typeof decidePublishedSelection>[0]["axes"]) =>
      decidePublishedSelection({ published: rows, runtime, axes });
    const decidedPair = (axes: Parameters<typeof decidePublishedSelection>[0]["axes"]) => {
      const d = decide(axes);
      if (!d.ok) return { live: d.reason };
      const sub = publishedSubtotal(d.selected);
      return sub ? [sub.hitPrompts, sub.measuredPrompts] : { live: "empty" };
    };

    // ① 무필터 = 리포트 헤드라인. 여기서 갈리면 다른 모든 것이 의미 없다.
    check("런타임 합성 · 무필터 = 헤드라인", want(poolOf(parsed.sites)), decidedPair({}));

    // ② 브랜드 = 발행물 `brandAvgAll` 과 **정수 쌍까지** 같아야 한다.
    //    이것이 차단 1 의 회귀 가드다.
    const brandAvgAll = (sbRoot.brandAvgAll ?? {}) as Record<string, { n?: number; k6?: number }>;
    for (const [brand, avg] of Object.entries(brandAvgAll)) {
      const sel = poolOf(parsed.sites.filter((s) => s.brand === brand));
      check(`런타임 합성 · brand=${brand}`, want(sel), decidedPair({ brand: [brand] }));
      check(`런타임 합성 · brand=${brand} 모수(brandAvgAll.n)`, avg?.n, sel.length);
      const p = want(sel);
      console.log(`      → ${p[0]} / ${p[1]} = ${pct1(p[0], p[1])}% (발행물 ${avg?.k6}%)`);
    }

    // ③ 런타임에만 있는 브랜드(예: 'Hyundai N')는 대응 부분합이 없으므로 라이브여야 한다.
    const pubBrands = new Set(rows.map((r) => r.brand.toLowerCase()));
    const runtimeOnly = [...new Set(runtime.map((r) => r.brand))].filter(
      (b) => !pubBrands.has(b.toLowerCase()),
    );
    console.log(`  · 런타임 전용 브랜드: ${runtimeOnly.join(", ") || "없음"}`);
    for (const b of runtimeOnly) {
      const d = decide({ brand: [b] });
      check(`런타임 합성 · brand=${b} 는 라이브`, false, d.ok);
    }

    // ④ 어휘가 갈리는 유닛에 닿는 국가·언어 선택은 라이브여야 한다(차단 2 회귀 가드).
    const touched = new Set<string>();
    for (const fs of split) {
      const p = rows.find((r) => r.fileSeq === fs)!;
      const r = byFsRun.get(fs);
      for (const v of [p.countryCode, r?.countryCode]) if (v) touched.add(v);
    }
    for (const cc of touched) {
      const d = decide({ countryCode: [cc] });
      check(`런타임 합성 · country=${cc} 는 라이브 (어휘 분기)`, false, d.ok);
    }

    // ④' **무기간 기본 화면이 이 회차를 보는가** (2026-09-20 프리뷰 실측의 회귀 가드)
    //
    // 실측: 무기간으로 열면 라이브(57.5%)가 나오고 기간을 09-11 하루로 지정해야
    // 발행값(58.5%)이 나왔다. 최신 회차 판정이 노출 게이트만 보고 `max(round_date)` =
    // 09-18 을 골랐는데, 그 회차는 원장에서 숨김이라 화면의 실제 최신 회차는 09-11
    // 이었기 때문이다. 리더는 이제 화면과 같은 함수를 부르지만(§1), 이 스크립트는
    // **독립 재계산**이 일이므로 게이트를 여기 한 번 더 써서 대조한다 — 여기서 갈리면
    // 화면 쪽 술어가 바뀐 것이다.
    console.log("\n── (c') 무기간 최신 회차 = 발행 회차인가 ────────────────────────");
    const [rawLatest] = await conn<Array<{ d: string | null }>>`
      SELECT max(ca.round_date)::text AS d
        FROM scope_answer_cycle_anchors ca
       WHERE ca.surface = 'website'
         AND ca.view_anchor_date IS NOT NULL AND ca.view_anchor_date <= hmg_anchor_today()`;
    const [gatedLatest] = await conn<Array<{ d: string | null }>>`
      SELECT max(ca.round_date)::text AS d
        FROM scope_answer_cycle_anchors ca
       WHERE ca.surface = 'website'
         AND ca.view_anchor_date IS NOT NULL AND ca.view_anchor_date <= hmg_anchor_today()
         AND ca.is_default_engine
         AND NOT EXISTS (
           SELECT 1 FROM summary_cycles c
            WHERE c.cycle_id = ca.cycle_id AND c.hidden_reason IS NOT NULL)
         AND EXISTS (
           SELECT 1 FROM summary_cycles sc
            WHERE sc.cycle_id = ca.cycle_id AND sc.fleet_visible
              AND sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at <= now()
              AND sc.active_generation_id IS NOT NULL)`;
    console.log(
      `  · 노출 게이트만: ${rawLatest?.d ?? "없음"}  ·  전체 게이트(화면과 같은 한 벌): ${gatedLatest?.d ?? "없음"}`,
    );
    if (rawLatest?.d !== gatedLatest?.d) {
      console.log(
        `      → 둘이 다르다. 숨김·함대 게이트가 ${rawLatest?.d} 를 걸러냈다는 뜻이고, 이것이 그 결함의 지문이다.`,
      );
    }
    check("무기간 최신 회차 = 이 발행물의 회차", String(pub.round_date), gatedLatest?.d ?? null);

    // ⑤ 갈리지 않는 국가·언어는 published 이고 발행 정수 쌍 그대로다.
    const safeCountries = countries
      .filter((c) => !touched.has(String(c)))
      .slice(0, 10) as string[];
    for (const c of safeCountries) {
      check(
        `런타임 합성 · country=${c}`,
        want(poolOf(parsed.sites.filter((s) => s.countryCode === c))),
        decidedPair({ countryCode: [c] }),
      );
    }
  } finally {
    await conn.end();
  }

  console.log(`\n${failures === 0 ? "✅ 불일치 0 — 통과" : `✗ 불일치 ${failures}건`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
