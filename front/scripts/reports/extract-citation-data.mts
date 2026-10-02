import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { writeFileSync, readFileSync } from "fs";

const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
const db = drizzle(pg);
// lib/scope/url-match.ts::normalizeUrlForMatch / scope-aggregates.ts::
// citationTrackedNormSql 과 동일한 규칙(트래킹 파라미터 3패스 제거, 자원을
// 식별하는 쿼리는 보존). 자사 판정(NORM)과 타겟 판정(NORM_T)이 서로 다르면
// 타겟 URL 인용률만 조용히 어긋난다 — 반드시 같은 함수를 쓴다.
const TRACK =
  "(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)";
const NORM = (col: string) => {
  const base = `regexp_replace(regexp_replace(regexp_replace(lower(regexp_replace(${col},'^\\s+|\\s+$','','g')),'^https?://',''),'^www\\.',''),'#.*$','')`;
  const noMid = `regexp_replace(${base},'&${TRACK}=[^&]*','','g')`;
  const noHead = `regexp_replace(${noMid},'\\?${TRACK}=[^&]*&','?')`;
  const noOnly = `regexp_replace(${noHead},'\\?${TRACK}=[^&]*$','')`;
  return `regexp_replace(${noOnly},'/+$','')`;
};
const NORM_T = NORM;

// spec: [{brand, cc, lang, fs, urlLike?, urlNotLike?, pathSeg?}]
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out: any[] = [];
for (const c of spec) {
  const site = (await db.execute(sql.raw(
    `SELECT id, scope_project_id pid FROM website_sites WHERE brand='${c.brand}' AND country_code='${c.cc}'`))) as any[];
  if (!site.length) { console.log("no site:", c.brand, c.cc); continue; }
  const sid = site[0].id, pid = site[0].pid;
  const langFilter = c.langCode ? ` AND lang_code='${c.langCode}'` : "";
  const urlF = (c.urlLike ? ` AND ${NORM("target_url")} LIKE '${c.urlLike}'` : "")
             + (c.urlNotLike ? ` AND ${NORM("target_url")} NOT LIKE '${c.urlNotLike}'` : "");
  const filter = langFilter + urlF;

  const baseRows = (await db.execute(sql.raw(`
    SELECT CASE WHEN split_part(u,'/',1) IN ('hyundai.com','kia.com','genesis.com') AND split_part(u,'/',2)<>''
      THEN split_part(u,'/',1)||'/'||split_part(u,'/',2) ELSE split_part(u,'/',1) END AS b, count(*) n
    FROM (SELECT ${NORM("target_url")} AS u FROM website_prompts WHERE site_id='${sid}'${filter}) t
    GROUP BY 1 ORDER BY n DESC LIMIT 1`))) as any[];
  if (!baseRows.length) { console.log("no base:", c.brand, c.cc, c.lang); continue; }
  // 자사 base — 유닛이 **선언한 값**(website_prompts.owned_base_url, migration 0049)을 우선하고,
  // 선언이 없을 때만 종전 휴리스틱(타겟 최다 호스트)으로 폴백한다. 대시보드(websiteDeclaredOwnedBases)
  // 와 같은 소스라 두 표면의 ⑤ 가 같은 base 를 본다. 휴리스틱은 언어를 가른 사이트에서 다른 언어
  // 페이지(hyundaicanada.com 의 /fr, hyundai-n.com 의 /ko)를 자사로 삼켰다(2026-09-05 현대 N /ko 39건).
  const declRows = (await db.execute(sql.raw(`
    SELECT owned_base_url AS b, count(*) n FROM website_prompts
    WHERE site_id='${sid}'${filter} AND owned_base_url IS NOT NULL AND owned_base_url <> ''
    GROUP BY 1 ORDER BY n DESC LIMIT 1`))) as any[];
  const BASE = (declRows[0]?.b as string | undefined) ?? (baseRows[0].b as string);
  // 형제 base — 같은 호스트의 **더 긴 선언 base**(hyundai-n.com 의 /ko 처럼 이 유닛 base 아래에
  // 놓인 다른 유닛의 base)는 그쪽 자산이라 자사에서 뺀다. 대시보드 ownedBasePrefixClause 의
  // '긴 접두 우선' 과 같은 규칙, 모집단은 선언 목록(카탈로그 아님).
  const sibRows = (await db.execute(sql.raw(`
    SELECT DISTINCT owned_base_url AS b FROM website_prompts
    WHERE owned_base_url LIKE '${BASE}/%'`))) as any[];
  const SIBS = sibRows.map((r) => r.b as string);

  const CTE = `
    WITH lastday AS (SELECT max(a.measured_at)::date AS d FROM scope_answers a JOIN scope_runs r ON r.run_id=a.run_id
      WHERE r.project_id='${pid}' AND a.status='completed' AND r.status IN ('completed','partial_failed')),
    lp AS (SELECT scope_prompt_id, seq_no, prompt_text, target_url FROM website_prompts
           WHERE site_id='${sid}'${filter}),
    latest AS (SELECT DISTINCT ON (a.prompt_id,a.target) a.job_id,a.prompt_id,a.measured_at
      FROM scope_answers a JOIN scope_runs r ON r.run_id=a.run_id, lastday ld
      WHERE r.project_id='${pid}' AND a.status='completed' AND r.status IN ('completed','partial_failed')
        AND a.measured_at >= ld.d - interval '6 days' AND a.prompt_id::text IN (SELECT scope_prompt_id FROM lp)
      ORDER BY a.prompt_id,a.target,a.measured_at DESC),
    cit AS (SELECT l.job_id,l.prompt_id, ${NORM("c.url")} AS bn, ${NORM_T("c.url")} AS tn
      FROM latest l JOIN scope_citations c ON c.job_id=l.job_id WHERE c.url IS NOT NULL),
    tset AS (SELECT DISTINCT ${NORM_T("target_url")} AS turl FROM lp WHERE target_url <> '')`;
  // 자사 판정 — base prefix **또는 이 유닛의 타겟 URL 과 일치**(타겟 ⊂ 자사, 2026-09-06 제품 결정).
  // 유닛이 지정한 타겟은 정의상 자사 페이지인데 base prefix 밖(차종 서브도메인·/newsroom·루트·
  // 현대 N EN 루트)에 놓이면 "타겟 도달인데 자사 아님"이 됐다(2026-09-04 회차 46건). 대시보드
  // (scope-aggregates websiteTargetOwnedClause, PR #213)와 같은 규칙. 세 곳(oc·oa·owned_answers)이
  // 같은 술어를 써야 하므로 문자열 하나로 고정한다.
  const under = (a: string, b: string) => `(${a}.bn='${b}' OR ${a}.bn LIKE '${b}/%')`;
  const notSib = (a: string) => SIBS.map((b) => ` AND NOT ${under(a, b)}`).join("");
  // 사이트 루트 홈 = 자사(공유 글로벌 호스트 제외) — lib/geo-catalog/owned.ts isSiteRootHome 와 동일.
  const HOST = BASE.split("/")[0];
  const rootHome = (a: string) =>
    ["hyundai.com", "kia.com", "genesis.com"].includes(HOST) ? "" : ` OR rtrim(split_part(${a}.bn,'?',1),'/')='${HOST}'`;
  const OWNED = (a: string) => `((${under(a, BASE)}${notSib(a)}) OR ${a}.tn IN (SELECT turl FROM tset)${rootHome(a)})`;

  const summary = (await db.execute(sql.raw(`${CTE}
    SELECT (SELECT min(measured_at)::date FROM latest) ws,(SELECT max(measured_at)::date FROM latest) we,
      (SELECT count(DISTINCT job_id) FROM latest) answers,(SELECT count(DISTINCT prompt_id) FROM latest) mp,
      (SELECT count(*) FROM cit) tc,
      (SELECT count(*) FROM cit WHERE ${OWNED("cit")}) oc,
      (SELECT count(DISTINCT job_id) FROM cit WHERE ${OWNED("cit")}) oa`))) as any[];
  if (Number(summary[0].answers) === 0) { console.log("no answers:", c.brand, c.cc, c.lang); continue; }

  const prompts = (await db.execute(sql.raw(`${CTE}
    SELECT lp.seq_no, lp.prompt_text, lp.target_url,
      (SELECT count(DISTINCT l2.job_id) FROM latest l2 WHERE l2.prompt_id::text=lp.scope_prompt_id) answers,
      (SELECT count(DISTINCT c2.job_id) FROM cit c2 WHERE c2.prompt_id::text=lp.scope_prompt_id AND ${OWNED("c2")}) owned_answers,
      EXISTS (SELECT 1 FROM cit c3 WHERE c3.prompt_id::text=lp.scope_prompt_id AND c3.tn=${NORM_T("lp.target_url")}) target_hit
    FROM lp ORDER BY lp.seq_no`))) as any[];
  const alt = (await db.execute(sql.raw(`${CTE},
    keyed AS (SELECT CASE WHEN split_part(bn,'/',1) IN ('hyundai.com','kia.com','genesis.com') AND split_part(bn,'/',2)<>''
      THEN split_part(bn,'/',1)||'/'||split_part(bn,'/',2) ELSE split_part(bn,'/',1) END AS k
      -- 출처는 호스트 단위 집계이므로 보존된 쿼리는 여기서만 떼어낸다
      FROM (SELECT split_part(bn,'?',1) AS bn FROM cit) q)
    SELECT k, count(*) n FROM keyed WHERE k <> '${BASE}' GROUP BY k ORDER BY n DESC LIMIT 12`))) as any[];

  out.push({ brand: c.brand, cc: c.cc, lang: c.lang, fs: c.fs, pathSeg: c.pathSeg ?? null,
             base: BASE, summary: summary[0], prompts, alt });
  console.log(`${c.brand}/${c.cc}/${c.lang} base=${BASE}${SIBS.length ? ` -sib[${SIBS.join(",")}]` : ""} ans=${summary[0].answers} oc=${summary[0].oc}/${summary[0].tc}`);
}
writeFileSync(process.argv[3], JSON.stringify(out));
console.log("SPEC DONE:", out.length);
await pg.end();
process.exit(0);
