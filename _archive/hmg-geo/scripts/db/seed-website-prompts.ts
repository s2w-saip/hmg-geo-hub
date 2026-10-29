/**
 * 웹사이트 오피셜 사이트 프롬프트 갱신 스크립트
 *
 * prompt/작업용/*.xlsx → website_sites + website_prompts (DB upsert)
 *                      → scope createProject + createPrompt (신규/변경분 푸시)
 *
 * 갱신(idempotent): 재실행 시 변경된 prompt_text / target_url만 업데이트,
 * scope_prompt_id가 없는 행만 scope로 푸시.
 *
 *   npx tsx --env-file=.env.local scripts/db/seed-website-prompts.ts
 *
 * 옵션:
 *   --dry-run   DB/scope 쓰기 없이 파싱 결과만 출력
 *   --no-scope  DB upsert는 하되 scope 푸시 생략 (DB 적재만)
 */

import path from "path";
import fs from "fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import ExcelJS from "exceljs";
import {
  websiteSites,
  websitePrompts,
} from "../../lib/db/schema";
import { getScopeClient } from "../../lib/scope/index";
import { eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");

const isDryRun = process.argv.includes("--dry-run");
const noScope  = process.argv.includes("--no-scope");

// --only 109,143 → 해당 파일 시퀀스만 처리. 전량 시드는 수십 분이 걸려, 파일 한
// 건을 추가·수정할 때 나머지 100여 건을 다시 훑지 않도록 하는 스코프 한정 옵션.
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY_FILE_SEQS = onlyArg
  ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => parseInt(s, 10)))
  : null;

const sql = postgres(DATABASE_URL, { prepare: false });
const db  = drizzle(sql);

// ─── 파일명 파싱 ─────────────────────────────────────────────────────────────

// TLD → ISO alpha-2 country code 매핑 (도메인에 명시적 국가 코드 없는 경우)
const TLD_COUNTRY: Record<string, string> = {
  gr: "GR", dk: "DK", de: "DE", ru: "RU", lt: "LT", ba: "BA", bg: "BG",
  rs: "RS", sk: "SK", si: "SI", cz: "CZ", hr: "HR", pt: "PT", fi: "FI",
  hu: "HU", ro: "RO", am: "AM", ee: "EE", lv: "LV", il: "IL", cn: "CN",
  uz: "UZ", mm: "MM", ca: "CA", ua: "UA", br: "BR", kz: "KZ", uk: "GB",
};

// country suffix code 정규화 (uk → GB 등)
const CC_NORMALIZE: Record<string, string> = { uk: "GB" };

// country code → default lang 매핑
const COUNTRY_LANG: Record<string, string> = {
  GR: "el", DK: "da", DE: "de", RU: "ru", LT: "lt", BA: "bs", BG: "bg",
  RS: "sr", SK: "sk", SI: "sl", CZ: "cs", HR: "hr", PT: "pt", FI: "fi",
  HU: "hu", RO: "ro", AM: "hy", EE: "et", LV: "lv", IL: "he", CN: "zh",
  UZ: "uz", MM: "my", KR: "ko", JP: "ja", TW: "zh", CA: "en", AU: "en",
  GB: "en", UA: "uk", IN: "en", CL: "es", MX: "es", BR: "pt", KZ: "ru",
  NL: "nl", NO: "no", SE: "sv", PL: "pl", ES: "es", TR: "tr",
  EU: "en", // EU 허브 페이지(hyundai.com/eu)는 영어
};

// 가상 권역 코드 → scope 측정 대표 ISO 국가 코드
// DB country_code는 논리적 그룹(worldwide/EU/MIDDLEEAST) 그대로 유지하되,
// scope createProject.regions에는 유효한 ISO 코드를 넘겨야 함.
const VIRTUAL_REGION_COUNTRY: Record<string, string> = {
  worldwide: "KR",   // 글로벌 페이지 → 한국 IP (결정: 2026-07-02)
  EU: "DE",          // HME 소재지 독일
  MIDDLEEAST: "AE",  // Genesis MENA 소재지 UAE
  // 베이징현대 — 로컬은 중국(CN)과 별개 사이트. 측정 IP 는 US: 중국 IP 로는
  // ChatGPT/Gemini 작업이 전량 실패하는 것이 확인돼(현대 중국 152런 중 147건
  // failed) 측정 자체가 성립하지 않는다.
  "CN-BJ": "US",
  CPO: "KR",       // 현대·제네시스 인증중고차 — 한국 서비스
  // 제네시스 사우디 도시별 사이트(2026-09-05 분리) — 셋 다 같은 scope 프로젝트를
  // 공유한다(migration 0056). 여기 값은 새 프로젝트를 만들 일이 생길 때의 측정 IP.
  "SA-Dammam": "SA",
  "SA-Jeddah": "SA",
  "SA-Riyadh": "SA",
};

// 언어 코드 → 대표 국가 매핑 (국가 코드와 다른 순수 언어 코드만 포함)
// e.g. 'ko'는 국가코드가 아니므로 → KR
const LANG_TO_COUNTRY: Record<string, string> = {
  ko: "KR", ja: "JP", zh: "CN", ar: "SA", sv: "SE", da: "DK",
  el: "GR", et: "EE", bs: "BA", sr: "RS", sl: "SI", cs: "CZ",
  hy: "AM", my: "MM", he: "IL",
};

// 도메인 이름에서 국가 추론 ("canada" 등 명시적 국가명)
function inferCountryFromDomain(domain: string): string | null {
  if (domain.includes("canada")) return "CA";
  if (domain.includes("israel")) return "IL";
  return null;
}

interface SiteMeta {
  fileSeq:     number;
  brand:       string;
  domain:      string;
  countryCode: string;
  langCode:    string;
}

// 파일명 규칙만으로 판정할 수 없는 예외 파일의 명시 오버라이드 (2차 배치,
// 2026-07-27 실물 프롬프트 대조로 확정 — 파일명과 실제 내용이 다른 케이스들):
//   109 certified.hyundai.com = 한국 인증중고차(한국어) — US 아님
//   114/116/117 sa-{dammam,jeddah,riyadh} = 사우디 도시별 — 처음엔 SA 로 합쳤으나
//       2026-09-05 도시별 사이트로 분리(필터·계정이 도시 단위라서, migration 0056)
//   119 hyundai.com_id = URL /id/en, 영어 프롬프트 (120이 인니어판)
//   125~127 hyundai.pe/hyundaipr/hyundaicolombia = 중남미(스페인어)
//   128/129 hyundai-me.com = 중동 허브 → MIDDLEEAST (genesis와 동일 가상코드)
//   130/131 hyundaiksa.com = 사우디 (130 아랍어 / 131 영어)
//   132~138 kia.com/{at,ie,mt,my,vn} = 사이트 언어 실물 기준
// 웹사이트 파이프라인에서 제외할 파일 — 109 certified.hyundai.com(현대·제네시스
// 인증중고차 CPO)는 웹사이트 사이트가 아니라 별도 프로젝트로 관리하기로 결정
// (2026-07-27). scripts/db/migrate-cpo-to-project.ts가 프로젝트로 이관.
// 109(CPO)는 프롬프트 확정 전까지 제외였으나 2026-08-12 확정되어 편입.
const SKIP_FILE_SEQS = new Set<number>([]);

const FILE_OVERRIDES: Record<number, Partial<Pick<SiteMeta, "brand" | "countryCode" | "langCode">>> = {
  // 3차 배치(2026-08-10) — 파일명에 국가 세그먼트가 없고 도메인에 국가가 붙어
  // 있어 TLD 규칙이 잡지 못하는 건들. 143 은 브랜드 접두사(beijing-)로 브랜드
  // 판정이 Unknown 이 되고, 정본상 China(ZH) 와 별개 사이트라 CN-BJ 로 분리한다.
  1:   { countryCode: "MX", langCode: "es" },
  109: { countryCode: "CPO", langCode: "ko" },
  38:  { countryCode: "CL", langCode: "es" },
  // 캐나다 불어판 — 슬러그 끝의 _fr 이 언어로 인식되지 않아 en 으로 잡히던 건
  // (정본상 Canada(EN)/Canada(FR) 별도 항목이라 언어를 분리해야 한다).
  64:  { countryCode: "CA", langCode: "fr" },
  142: { countryCode: "SG", langCode: "en" },
  143: { brand: "Hyundai", countryCode: "CN-BJ", langCode: "zh" },
  144: { countryCode: "PH", langCode: "en" },
  114: { countryCode: "SA-Dammam" },
  116: { countryCode: "SA-Jeddah" },
  117: { countryCode: "SA-Riyadh" },
  119: { langCode: "en" },
  125: { countryCode: "PE", langCode: "es" },
  126: { countryCode: "PR", langCode: "es" },
  127: { countryCode: "CO", langCode: "es" },
  128: { countryCode: "MIDDLEEAST", langCode: "en" },
  129: { countryCode: "MIDDLEEAST", langCode: "ar" },
  130: { countryCode: "SA", langCode: "ar" },
  131: { countryCode: "SA", langCode: "en" },
  132: { langCode: "de" },
  134: { langCode: "en" },
  136: { langCode: "en" },
  137: { countryCode: "MY", langCode: "en" },
  138: { langCode: "vi" },
};

function parseSiteSlug(filename: string): SiteMeta {
  // HMG-GEO_002_hyundaiusa.com_us_en_PROMPT_작업용.xlsx
  const m = filename.match(/^HMG-GEO_(\d+)_(.+?)_PROMPT_/);
  if (!m) throw new Error(`Cannot parse filename: ${filename}`);

  const fileSeq = parseInt(m[1], 10);
  const slug    = m[2];

  // 브랜드 — www./certified. 등 서브도메인 접두사를 걷어내고 판정 (2차 배치의
  // www.kia.com_* / certified.hyundai.com 대응; 1차 배치 파일명은 접두사가 없어
  // 동작 불변).
  const brandSlug = slug.replace(/^(www|certified)\./, "");
  const brand = brandSlug.startsWith("genesis")  ? "Genesis"
    // hyundai-n.com 은 정본이 별도 항목으로 두는 사이트다. 부모 브랜드로 매핑하면
    // 현대 한국·글로벌 사이트에 N 프롬프트가 섞여 들어가 같은 프롬프트가 두 scope
    // 프로젝트에서 중복 측정되고, 리포트도 자기 base 밖 타겟을 집계하게 된다.
    : brandSlug.startsWith("hyundai-n")          ? "Hyundai N"
    : brandSlug.startsWith("hyundai")            ? "Hyundai"
    : (brandSlug.startsWith("kia") || brandSlug.startsWith("worldwide.kia")) ? "Kia"
    : "Unknown";

  // 도메인 = underscore 분리 후 첫 번째 dot 포함 파트
  const parts = slug.split("_");
  const domainParts: string[] = [];
  const codeParts:   string[] = [];
  let inDomain = true;
  for (const p of parts) {
    if (inDomain && p.includes(".")) { domainParts.push(p); }
    else { inDomain = false; codeParts.push(p); }
  }
  const domain = domainParts.join(""); // 단일 파트

  // TLD 파싱 (com.mx → mx, co.uk → uk, com.cn → cn)
  const tldParts = domain.split(".");
  const tld  = tldParts[tldParts.length - 1].toLowerCase();
  const tld2 = tldParts.length >= 3 ? tldParts[tldParts.length - 2].toLowerCase() : null;

  // 도메인 TLD → 국가 코드 (다단 TLD 우선)
  const tldCountry = (tld2 && TLD_COUNTRY[tld2]) ? TLD_COUNTRY[tld2]
    : TLD_COUNTRY[tld] ?? null;

  // 의미있는 suffix 코드: 2~14자, 알파벳만, 무의미 단어 제거
  const NOISE = new Set(["genesis", "worldwide", "anasayfa", "com"]);
  const meaningfulCodes = codeParts
    .filter((c) => c.length >= 2 && /^[a-z]+$/.test(c) && !NOISE.has(c));

  let countryCode: string;
  let langCode: string;

  if (slug.includes("worldwide")) {
    // worldwide 글로벌 페이지
    countryCode = "worldwide";
    langCode = meaningfulCodes[meaningfulCodes.length - 1] ?? "en";
  } else if (meaningfulCodes.length >= 2) {
    // 패턴: {country}_{lang} (e.g. us_en, it_it, ca_fr, middleeast_ar)
    const [cc, lc] = meaningfulCodes;
    countryCode = CC_NORMALIZE[cc] ?? cc.toUpperCase();
    langCode    = lc;
  } else if (meaningfulCodes.length === 1) {
    const code = meaningfulCodes[0];
    const domainCountry = inferCountryFromDomain(domain);
    if (domainCountry) {
      // 도메인 이름 자체가 국가를 제공 → suffix = 언어
      // e.g. hyundaicanada.com_fr → country=CA(domain), lang=fr
      countryCode = domainCountry;
      langCode    = code;
    } else if (tldCountry) {
      // 도메인 TLD → 국가, TLD 국가의 기본 언어 우선
      // suffix가 URL 경로 접미사일 뿐 실제 언어와 다른 경우 대응
      // e.g. kia.lv_ru → country=LV, lang=lv (현지어, ru 아님)
      countryCode = tldCountry;
      langCode    = COUNTRY_LANG[tldCountry] ?? code;
    } else if (LANG_TO_COUNTRY[code]) {
      // 순수 언어 코드 (국가코드와 다른 것) → 언어로 처리
      // e.g. hyundai-n.com_ko → lang=ko, country=KR
      langCode    = code;
      countryCode = LANG_TO_COUNTRY[code];
    } else {
      // 남은 경우: suffix = 국가 코드(언어와 동일한 경우 포함)
      // e.g. hyundai.com_nl → country=NL, lang=nl
      //      hyundai.com_kr → country=KR, lang=ko
      countryCode = CC_NORMALIZE[code] ?? code.toUpperCase();
      langCode    = COUNTRY_LANG[countryCode] ?? code;
    }
  } else {
    // suffix 없음 — TLD 또는 도메인 이름에서 국가 추론
    const domainCountry = inferCountryFromDomain(domain);
    countryCode = domainCountry ?? tldCountry ?? "worldwide";
    langCode    = COUNTRY_LANG[countryCode] ?? "en";
  }

  // 규칙 파싱 결과 위에 파일별 명시 오버라이드를 덮는다 (FILE_OVERRIDES 참조).
  return { fileSeq, brand, domain, countryCode, langCode, ...FILE_OVERRIDES[fileSeq] };
}

// ─── xlsx 파싱 ────────────────────────────────────────────────────────────────

interface PromptRow {
  seqNo:      number;
  targetUrl:  string;
  promptText: string;
}

async function parseXlsx(filePath: string): Promise<PromptRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const rows: PromptRow[] = [];

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // 헤더 스킵 (No / URL / text)
    const seqNo      = Number(row.getCell(1).value);   // col A: No
    const targetUrl  = String(row.getCell(2).value ?? "").trim(); // col B: URL
    const promptText = String(row.getCell(3).value ?? "").trim(); // col C: text
    if (!targetUrl || !promptText) return;
    rows.push({ seqNo, targetUrl, promptText });
  });

  return rows;
}

// ─── 메인 ────────────────────────────────────────────────────────────────────

const PROMPT_DIR = path.resolve(process.cwd(), "prompt/작업용");
const files = fs.readdirSync(PROMPT_DIR)
  .filter((f) => f.endsWith(".xlsx"))
  .sort();

console.log(`[seed-website-prompts] ${files.length} xlsx files found`);
if (isDryRun) console.log("[dry-run] No writes will be performed.\n");

const scopeClient = (noScope || isDryRun) ? null : getScopeClient();

let siteNew = 0, siteExist = 0, promptNew = 0, promptUpdated = 0, scopePushed = 0;

for (const filename of files) {
  let meta: SiteMeta;
  try {
    meta = parseSiteSlug(filename);
  } catch (e) {
    console.warn(`  SKIP parse error: ${filename}`, e);
    continue;
  }
  if (ONLY_FILE_SEQS && !ONLY_FILE_SEQS.has(meta.fileSeq)) continue;
  if (SKIP_FILE_SEQS.has(meta.fileSeq)) {
    console.log(`  SKIP [${String(meta.fileSeq).padStart(3, "0")}] 웹사이트 제외 대상 (SKIP_FILE_SEQS): ${filename}`);
    continue;
  }

  const { fileSeq, brand, domain, countryCode, langCode } = meta;
  const rows = await parseXlsx(path.join(PROMPT_DIR, filename));

  if (isDryRun) {
    console.log(
      `[${String(fileSeq).padStart(3, "0")}] ${brand} / ${countryCode} / ${langCode}` +
      `  domain=${domain}  prompts=${rows.length}`
    );
    continue;
  }

  // ── 1. website_sites upsert ──────────────────────────────────────────────
  const [site] = await db
    .insert(websiteSites)
    .values({ brand, countryCode })
    .onConflictDoUpdate({
      target: [websiteSites.brand, websiteSites.countryCode],
      set: { updatedAt: new Date() },
    })
    .returning();

  // scope 프로젝트 생성 (scope_project_id 아직 없으면)
  if (!site.scopeProjectId && !noScope && scopeClient) {
    try {
      const scopeRegion = VIRTUAL_REGION_COUNTRY[countryCode] ?? countryCode;
      const proj = await scopeClient.createProject({
        name: `Website — ${brand} / ${countryCode}`,
        domain,
        tracked_brands: [{ brand_name: brand }],
        regions: [scopeRegion],
      });
      await db
        .update(websiteSites)
        .set({ scopeProjectId: proj.project_id, updatedAt: new Date() })
        .where(eq(websiteSites.id, site.id));
      site.scopeProjectId = proj.project_id;
      console.log(`  [scope] created project: ${proj.project_id} (${brand}/${countryCode})`);
      siteNew++;
    } catch (e) {
      console.warn(`  [scope] createProject failed (${brand}/${countryCode}):`, e);
    }
  } else {
    siteExist++;
  }

  // ── 2. website_prompts upsert ────────────────────────────────────────────
  for (const r of rows) {
    const [prompt] = await db
      .insert(websitePrompts)
      .values({
        siteId:     site.id,
        fileSeq,
        domain,
        langCode,
        seqNo:      r.seqNo,
        targetUrl:  r.targetUrl,
        promptText: r.promptText,
      })
      .onConflictDoUpdate({
        target: [websitePrompts.siteId, websitePrompts.fileSeq, websitePrompts.seqNo],
        set: {
          targetUrl:  r.targetUrl,
          promptText: r.promptText,
          domain,
          langCode,
          updatedAt:  new Date(),
        },
      })
      .returning();

    const isNew = !prompt.scopePromptId;
    if (isNew) promptNew++; else promptUpdated++;

    // scope 프롬프트 푸시 (scope_prompt_id 없는 신규 행만)
    if (isNew && !noScope && scopeClient && site.scopeProjectId) {
      try {
        const sp = await scopeClient.createPrompt(site.scopeProjectId, {
          text: r.promptText,
          keywords: [r.targetUrl],
        });
        await db
          .update(websitePrompts)
          .set({ scopePromptId: sp.prompt_id, updatedAt: new Date() })
          .where(eq(websitePrompts.id, prompt.id));
        scopePushed++;
      } catch (e) {
        console.warn(`  [scope] createPrompt failed (seq=${fileSeq} row=${r.seqNo}):`, e);
      }
    }
  }

  console.log(
    `[${String(fileSeq).padStart(3, "0")}] ${brand}/${countryCode}/${langCode}` +
    `  domain=${domain}  rows=${rows.length}`
  );
}

if (!isDryRun) {
  console.log(
    `\ndone. sites new=${siteNew} exist=${siteExist} |` +
    ` prompts new=${promptNew} updated=${promptUpdated} scope_pushed=${scopePushed}`
  );
}

await sql.end();
