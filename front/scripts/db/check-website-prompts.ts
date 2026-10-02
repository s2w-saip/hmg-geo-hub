import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { websitePrompts, websiteSites } from "../../lib/db/schema.js";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });
const db = drizzle(sql);

function detectScript(text: string): string {
  if (/[가-힣ᄀ-ᇿ]/.test(text)) return "ko";
  if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja";
  if (/[؀-ۿ]/.test(text)) return "ar";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[Ѐ-ӿ]/.test(text)) return "cyrillic";
  return "latin";
}

const EXPECTED_SCRIPT: Record<string, string> = {
  ko: "ko", ja: "ja", zh: "zh", ar: "ar",
  ru: "cyrillic", uk: "cyrillic", bg: "cyrillic", sr: "cyrillic",
};

async function main() {
  const rows = await db
    .select({
      id: websitePrompts.id,
      brand: websiteSites.brand,
      countryCode: websiteSites.countryCode,
      langCode: websitePrompts.langCode,
      domain: websitePrompts.domain,
      fileSeq: websitePrompts.fileSeq,
      seqNo: websitePrompts.seqNo,
      promptText: websitePrompts.promptText,
    })
    .from(websitePrompts)
    .innerJoin(websiteSites, eq(websitePrompts.siteId, websiteSites.id))
    .orderBy(websitePrompts.fileSeq, websitePrompts.seqNo);

  // ── 1. 언어-스크립트 불일치 ──────────────────────────────────────────────
  console.log("\n## 언어-스크립트 불일치\n");
  const mismatch: typeof rows = [];
  for (const r of rows) {
    const expected = EXPECTED_SCRIPT[r.langCode];
    if (!expected) continue;
    const actual = detectScript(r.promptText);
    if (actual !== expected) mismatch.push(r);
  }

  if (mismatch.length === 0) {
    console.log("불일치 없음 ✅");
  } else {
    const byFile = new Map<string, typeof rows>();
    for (const r of mismatch) {
      const key = `[${String(r.fileSeq).padStart(3,"0")}] ${r.brand}/${r.countryCode}/${r.langCode} (${r.domain})`;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(r);
    }
    for (const [file, items] of byFile) {
      console.log(`${file}  → ${items.length}개`);
      const s = items[0];
      console.log(`  샘플 seq=${s.seqNo} detected=${detectScript(s.promptText)}: "${s.promptText.slice(0,70)}"`);
    }
  }

  // ── 2. 정확 중복 ─────────────────────────────────────────────────────────
  console.log("\n## 정확 중복\n");
  const textMap = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.promptText.trim();
    if (!textMap.has(key)) textMap.set(key, []);
    textMap.get(key)!.push(r);
  }
  const dups = [...textMap.entries()].filter(([, v]) => v.length > 1);
  const crossFile = dups.filter(([, v]) => new Set(v.map(r => r.fileSeq)).size > 1);
  const sameFile  = dups.filter(([, v]) => new Set(v.map(r => r.fileSeq)).size === 1);

  console.log(`중복 텍스트: ${dups.length}종  (파일 횡단: ${crossFile.length}종 / 동일 파일 내: ${sameFile.length}종)`);
  console.log(`중복 총 행: ${dups.reduce((s,[,v])=>s+v.length,0)}개\n`);

  if (crossFile.length > 0) {
    console.log("### 파일 횡단 중복 상위 15종");
    crossFile.slice(0,15).forEach(([text, items]) => {
      const files = items.map(r => `[${String(r.fileSeq).padStart(3,"0")}]${r.countryCode}/${r.langCode}`).join("  ");
      console.log(`  "${text.slice(0,65)}"`);
      console.log(`    → ${files}`);
    });
  }

  if (sameFile.length > 0) {
    console.log(`\n### 동일 파일 내 중복 상위 10종`);
    sameFile.slice(0,10).forEach(([text, items]) => {
      const r = items[0];
      console.log(`  [${String(r.fileSeq).padStart(3,"0")}] ${r.countryCode}/${r.langCode}  seq=${items.map(i=>i.seqNo).join(",")}  "${text.slice(0,60)}"`);
    });
  }

  // ── 요약 ─────────────────────────────────────────────────────────────────
  console.log("\n## 요약");
  console.log(`총 프롬프트: ${rows.length}개`);
  console.log(`언어 불일치: ${mismatch.length}개`);
  console.log(`파일 횡단 중복: ${crossFile.reduce((s,[,v])=>s+v.length,0)}행 (${crossFile.length}종)`);
  console.log(`동일 파일 내 중복: ${sameFile.reduce((s,[,v])=>s+v.length,0)}행 (${sameFile.length}종)`);

  await sql.end();
}

main().catch(console.error);
