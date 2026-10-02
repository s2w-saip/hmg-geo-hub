/**
 * 발행 리포트 적재기 — 발행된 HTML 의 `sb-data` 를 `report_*` 3표에 넣는다.
 *
 *   npm run report:ingest -- <발행 HTML 경로>                 # DRY-RUN (기본, 쓰기 없음)
 *   npm run report:ingest -- <발행 HTML 경로> --yes            # 실제 적재
 *   npm run report:ingest -- <경로> --yes --no-verify="소급 적재: 2026-09-15 발행분"
 *
 * 선택 플래그: `--slug=` `--surface=` `--brand-scope=` `--volume=` `--version=`
 *              `--round=`(회차 라벨 날짜 강제)
 *
 * ── 안전 규약 ───────────────────────────────────────────────────────────────
 * ① **기본이 DRY-RUN 이다.** `--yes` 없이는 트랜잭션을 열지도 않는다.
 * ② **검산이 어긋나면 적재하지 않는다.** 발행물이 자기 자신에 대해 말하는 요약
 *    (bench·curAvg·prevAvg·brandAvgAll·trend)을 `sites[]` 에서 다시 계산해 전부
 *    대조하고, 한 줄이라도 틀리면 `--yes` 여도 멈춘다(dry-run 은 표를 보여 준 뒤 exit 1).
 * ③ **멱등.** 같은 sha256 이 같은 자리에 active 로 이미 있으면 **아무것도 하지 않는다.**
 *    다른 sha 가 들어오면 앞 행을 `superseded` 로 내리고(= 정정 발행) 새 행을 올린다.
 *    행을 지우지 않는다 — `raw` 가 감사 원본이다.
 * ④ **시크릿은 env 로만.** `DATABASE_URL` 을 읽고 값을 출력하지 않는다(argv 로 받지
 *    않는 이유는 `ps` 가 마스킹을 지나가기 때문 — secrets-handling 룰 6).
 * ⑤ 쓰기는 **단일 트랜잭션** + `SET LOCAL` 타임아웃 + rowcount 단언.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  assertChecksPass,
  brandScopeOf,
  extractSbData,
  parsePublication,
  pct2,
  type ParsedPublication,
} from "../../lib/reports/sb-data";
import {
  buildSlug,
  parseReportFilename,
  parseReportTitle,
} from "../../lib/reports/publication-meta";

const STATEMENT_TIMEOUT = "120s";
const LOCK_TIMEOUT = "10s";
const MANIFEST = "docs/data/.verify-manifest.json";

type Args = {
  file: string;
  yes: boolean;
  noVerify: string | null;
  slug?: string;
  surface: string;
  brandScope?: string;
  volume?: string;
  version?: string;
  round?: string;
};

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (const a of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a);
    if (m) flags.set(m[1], m[2] ?? "");
    else rest.push(a);
  }
  if (rest.length !== 1) {
    throw new Error(
      "사용법: npm run report:ingest -- <발행 HTML 경로> [--yes] [--slug=…] [--no-verify=\"사유\"]",
    );
  }
  // ⚠️ `--no-verify` 는 **사유가 값으로 있어야** 한다. 빈 값을 통과시키면 사유 없는
  //    우회가 되고 `verify_note` 가 빈 문자열로 남는다 — docs/development-guide.md 업로드 게이트의
  //    "사유 없으면 거부" 자세와 어긋난다(2026-09-20 검증 주의 5).
  if (flags.has("no-verify") && !(flags.get("no-verify") ?? "").trim()) {
    throw new Error(
      '--no-verify 에는 사유를 값으로 넣어야 한다 — 예: --no-verify="소급 적재: 2026-09-15 발행분 · 검수 매니페스트 밖"',
    );
  }
  return {
    file: rest[0],
    yes: flags.has("yes"),
    noVerify: flags.has("no-verify") ? (flags.get("no-verify") as string).trim() : null,
    slug: flags.get("slug"),
    surface: flags.get("surface") || "website",
    brandScope: flags.get("brand-scope"),
    volume: flags.get("volume"),
    version: flags.get("version"),
    round: flags.get("round"),
  };
}

/** 검수 매니페스트에 이 해시가 있는가. 파일이 없으면(워크트리에 docs/data 비추적) false. */
function manifestHas(sha: string): { verified: boolean; note: string } {
  const p = path.resolve(MANIFEST);
  if (!fs.existsSync(p)) {
    return { verified: false, note: `매니페스트 파일 없음(${MANIFEST}) — docs/data 는 git 비추적이다` };
  }
  try {
    const man = JSON.parse(fs.readFileSync(p, "utf8")) as { files?: Record<string, string> };
    const values = Object.values(man.files ?? {});
    if (values.includes(sha)) return { verified: true, note: "매니페스트에 같은 해시 존재" };
    return { verified: false, note: "매니페스트에 같은 해시 없음(검수 대상 밖이거나 소급 적재)" };
  } catch (e) {
    return { verified: false, note: `매니페스트 읽기 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function printChecks(parsed: ParsedPublication): boolean {
  const w = Math.max(...parsed.checks.map((c) => c.name.length), 10);
  console.log("\n── 검산 ──────────────────────────────────────────────────────────");
  for (const c of parsed.checks) {
    const mark = c.ok ? "✓" : "✗";
    const detail = c.ok ? c.actual : `기대 ${c.expected} · 실제 ${c.actual}`;
    console.log(`  ${mark} ${c.name.padEnd(w)}  ${detail}`);
  }
  const bad = parsed.checks.filter((c) => !c.ok).length;
  console.log(`  → ${parsed.checks.length - bad}/${parsed.checks.length} 통과${bad ? ` · ${bad} 실패` : ""}`);
  return bad === 0;
}

function printPlan(parsed: ParsedPublication, meta: Record<string, unknown>): void {
  const pool = parsed.sites.filter((s) => s.inHeadlinePool);
  const sum = (rows: typeof parsed.sites, k: "targetHitPrompts" | "ownedPrompts" | "measuredPrompts") =>
    rows.reduce((a, s) => a + s[k], 0);
  const th = sum(pool, "targetHitPrompts");
  const ow = sum(pool, "ownedPrompts");
  const de = sum(pool, "measuredPrompts");
  const thAll = sum(parsed.sites, "targetHitPrompts");
  const deAll = sum(parsed.sites, "measuredPrompts");
  const done = parsed.sites.filter((s) => s.agencyStatus === "완료");
  const dn = sum(done, "targetHitPrompts");
  const dd = sum(done, "measuredPrompts");

  console.log("\n── 적재 계획 ─────────────────────────────────────────────────────");
  for (const [k, v] of Object.entries(meta)) console.log(`  ${k.padEnd(18)} ${String(v)}`);
  console.log(`  ${"사이트".padEnd(18)} ${parsed.sites.length}행 (엔진 행 ${parsed.engineFacts.length})`);
  console.log(`  ${"헤드라인 풀".padEnd(18)} ${pool.length}개 · 제외 ${parsed.headlinePool.excludedFileSeqs.join(",") || "없음"}`);
  console.log(`  ${"  ↳ 도출".padEnd(18)} ${parsed.headlinePool.method}`);
  console.log("\n── 합계(적재될 값) ───────────────────────────────────────────────");
  console.log(`  타겟 URL 인용률  헤드라인 풀 ${th} / ${de} = ${pct2(th, de)}%   (전체 ${thAll} / ${deAll} = ${pct2(thAll, deAll)}%)`);
  console.log(`  자사 URL 인용률  헤드라인 풀 ${ow} / ${de} = ${pct2(ow, de)}%`);
  console.log(`  '완료' ${done.length}개     ${dn} / ${dd} = ${pct2(dn, dd)}%`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const abs = path.resolve(args.file);
  const bytes = fs.readFileSync(abs);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const filename = path.basename(abs);

  const html = bytes.toString("utf8");
  const parsed = parsePublication(extractSbData(html));
  const title = parseReportTitle(html);
  const fromName = parseReportFilename(filename);
  const brandScope = args.brandScope ?? fromName.brandScope ?? brandScopeOf(parsed.meta.brandScopeLabel);
  const version = args.version ?? fromName.version;
  if (!version) throw new Error("version 을 파일명에서 읽을 수 없다 — --version= 으로 지정할 것");
  const volume = args.volume ?? fromName.volume;
  const roundDate = args.round ?? parsed.meta.roundDate;
  const publishedOn = parsed.meta.publishedOn ?? fromName.publishedOn;
  const slug = args.slug ?? buildSlug({ volume, version, brandScope, publishedOn });
  const manifest = manifestHas(sha);

  printPlan(parsed, {
    파일: filename,
    sha256: `${sha.slice(0, 12)}…`,
    제목: title ?? "-",
    slug,
    표면: args.surface,
    "브랜드 범위": brandScope,
    "회차(round_date)": roundDate,
    "직전 회차": parsed.meta.prevRoundDate ?? "-",
    "측정일(asOf.cur)": parsed.meta.asofCur ?? "-",
    발행일: publishedOn ?? "-",
    엔진: parsed.meta.engines.join(",") || "-",
    "고객 제외 유닛": parsed.meta.excludedFs.join(",") || "없음",
    "검수 매니페스트": `${manifest.verified} — ${manifest.note}`,
  });

  const ok = printChecks(parsed);
  if (!ok) {
    console.error("\n✗ 검산 실패 — 적재하지 않는다. 발행물이나 파서를 확인할 것.");
    process.exit(1);
  }
  assertChecksPass(parsed.checks);

  if (!manifest.verified && args.noVerify === null) {
    console.log(
      `\n⚠️  매니페스트 미검증이다. 적재는 가능하지만 기록이 manifest_verified=false 로 남는다.\n` +
        `    사유를 남기려면 --no-verify="<사유>" 를 붙일 것(제품 결정 J-4: 화면 표식은 같게, 기록만 구분).`,
    );
  }

  if (!args.yes) {
    console.log("\n▶ DRY-RUN — 쓰기 없음. 실제 적재는 --yes 를 붙인다.");
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 이 없다 — .env.local 확인(값을 출력하지 않는다)");
  const conn = postgres(url, { prepare: false, connect_timeout: 15 });
  const newId = crypto.randomUUID();
  try {
    await conn.begin(async (tx) => {
      await tx.unsafe("SET TRANSACTION READ WRITE");
      await tx.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

      const same = await tx<Array<{ id: string; slug: string }>>`
        SELECT id::text AS id, slug FROM report_publications
         WHERE surface = ${args.surface} AND round_date = ${roundDate}::date
           AND brand_scope = ${brandScope} AND status = 'active'
           AND source_sha256 = ${sha}`;
      if (same.length > 0) {
        console.log(`\n= 멱등: 같은 해시가 이미 active 다 (${same[0].slug}) — 아무것도 하지 않는다.`);
        return;
      }

      const prior = await tx<Array<{ id: string; slug: string; source_sha256: string }>>`
        SELECT id::text AS id, slug, source_sha256 FROM report_publications
         WHERE surface = ${args.surface} AND round_date = ${roundDate}::date
           AND brand_scope = ${brandScope} AND status = 'active'`;
      if (prior.length > 0) {
        const demoted = await tx`
          UPDATE report_publications
             SET status = 'superseded', superseded_by = ${newId}::uuid
           WHERE id = ${prior[0].id}::uuid AND status = 'active'`;
        if (demoted.count !== 1) throw new Error(`정정 발행: 앞 행을 내리지 못했다(rowcount ${demoted.count})`);
        console.log(`\n↻ 정정 발행: ${prior[0].slug}(sha ${prior[0].source_sha256.slice(0, 12)}…) → superseded`);
      }

      const ins = await tx`
        INSERT INTO report_publications (
          id, slug, surface, brand_scope, volume, version, title,
          cycle_label, cycle_label_en, round_date, prev_round_date,
          asof_cur, asof_prev, published_on, engines, excluded_fs,
          bench_n, bench_n_all, src_cite, source_filename, source_sha256,
          manifest_verified, verify_note, sb_data_version, status
        ) VALUES (
          ${newId}::uuid, ${slug}, ${args.surface}, ${brandScope}, ${volume ?? null},
          ${version}, ${title}, ${parsed.meta.cycleLabel},
          ${parsed.meta.cycleLabelEn}, ${roundDate}::date, ${parsed.meta.prevRoundDate},
          ${parsed.meta.asofCur}, ${parsed.meta.asofPrev}, ${publishedOn},
          ${parsed.meta.engines}::text[], ${parsed.meta.excludedFs}::int[],
          ${parsed.meta.benchN}, ${parsed.meta.benchNAll}, ${parsed.meta.srcCite},
          ${filename}, ${sha}, ${manifest.verified},
          ${args.noVerify ?? manifest.note}, ${parsed.meta.sbDataVersion}, 'active'
        )`;
      if (ins.count !== 1) throw new Error(`발행물 INSERT rowcount ${ins.count}`);

      const siteRows = parsed.sites.map((s) => ({
        publication_id: newId,
        file_seq: s.fileSeq,
        brand: s.brand,
        country_code: s.countryCode,
        country_name: s.countryName,
        region_label: s.regionLabel,
        lang_code: s.langCode,
        lang_label: s.langLabel,
        agency_status: s.agencyStatus,
        in_headline_pool: s.inHeadlinePool,
        target_hit_prompts: s.targetHitPrompts,
        measured_prompts: s.measuredPrompts,
        owned_prompts: s.ownedPrompts,
        owned_prompts_den: s.ownedPromptsDen,
        owned_answers: s.ownedAnswers,
        monitored_answers: s.monitoredAnswers,
        prompts: s.prompts,
        answers: s.answers,
        prev_target_hit_prompts: s.prevTargetHitPrompts,
        prev_measured_prompts: s.prevMeasuredPrompts,
        prev_owned_prompts: s.prevOwnedPrompts,
        prev_owned_prompts_den: s.prevOwnedPromptsDen,
        raw: JSON.stringify(s.raw),
      }));
      const sf = await tx`INSERT INTO report_site_facts ${tx(siteRows)}`;
      if (sf.count !== siteRows.length) {
        throw new Error(`사이트 INSERT rowcount ${sf.count} (기대 ${siteRows.length})`);
      }

      if (parsed.engineFacts.length > 0) {
        const engRows = parsed.engineFacts.map((e) => ({
          publication_id: newId,
          file_seq: e.fileSeq,
          engine: e.engine,
          target_hit_prompts: e.targetHitPrompts,
          prev_target_hit_prompts: e.prevTargetHitPrompts,
        }));
        const ef = await tx`INSERT INTO report_site_engine_facts ${tx(engRows)}`;
        if (ef.count !== engRows.length) {
          throw new Error(`엔진 INSERT rowcount ${ef.count} (기대 ${engRows.length})`);
        }
      }

      // 적재 직후 **DB 에서 다시 읽어** 합계를 확인한다 — 옮기다 틀린 것을 잡는 마지막 관문.
      const [back] = await tx<Array<{ n: number; th: number; de: number; ow: number }>>`
        SELECT count(*)::int AS n,
               coalesce(sum(target_hit_prompts) FILTER (WHERE in_headline_pool), 0)::int AS th,
               coalesce(sum(measured_prompts)   FILTER (WHERE in_headline_pool), 0)::int AS de,
               coalesce(sum(owned_prompts)      FILTER (WHERE in_headline_pool), 0)::int AS ow
          FROM report_site_facts WHERE publication_id = ${newId}::uuid`;
      const pool = parsed.sites.filter((s) => s.inHeadlinePool);
      const want = {
        n: parsed.sites.length,
        th: pool.reduce((a, s) => a + s.targetHitPrompts, 0),
        de: pool.reduce((a, s) => a + s.measuredPrompts, 0),
        ow: pool.reduce((a, s) => a + s.ownedPrompts, 0),
      };
      if (back.n !== want.n || back.th !== want.th || back.de !== want.de || back.ow !== want.ow) {
        throw new Error(
          `적재 후 재조회가 다르다 — 롤백. DB ${JSON.stringify(back)} vs 파서 ${JSON.stringify(want)}`,
        );
      }
      console.log(
        `\n✅ 적재 완료: ${slug} · 사이트 ${back.n}행 · 헤드라인 풀 ${back.th} / ${back.de} = ${pct2(back.th, back.de)}%`,
      );
    });
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
