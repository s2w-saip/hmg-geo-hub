/**
 * Exports the raw GA4 data backing the Kia Italy GPT traffic report to a
 * multi-sheet .xlsx. Numbers are pulled live from the Data API (not transcribed),
 * so every figure in the report is auditable against these sheets.
 *
 *   npm run ga4:export
 *
 * Output: docs/data/2-extract/ga4/kia-italy-gpt-traffic-raw-<dates>.xlsx (gitignored)
 */
import fs from "node:fs";
import { OAuth2Client } from "google-auth-library";
import ExcelJS from "exceljs";

const PROP = process.env.GA4_PROPERTY_ID!;
const oauth = new OAuth2Client({ clientId: process.env.GA4_OAUTH_CLIENT_ID!, clientSecret: process.env.GA4_OAUTH_CLIENT_SECRET! });
oauth.setCredentials(JSON.parse(fs.readFileSync(".ga4-token.json", "utf8")));
const token = (await oauth.getAccessToken()).token!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PERIODS = {
  "현재 (2026-05-22~06-10)": { startDate: "2026-05-22", endDate: "2026-06-10" },
  "전년 (2025-05-22~06-10)": { startDate: "2025-05-22", endDate: "2025-06-10" },
  "직전 (2026-05-02~05-21)": { startDate: "2026-05-02", endDate: "2026-05-21" },
} as const;

async function rep(body: object): Promise<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }> {
  for (let a = 1; ; a++) {
    const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.ok) return res.json() as any;
    const t = await res.text();
    if ([429, 500, 502, 503, 504].includes(res.status) && a < 6) { await sleep(2000 * a); continue; }
    throw new Error(`GA4 ${res.status}: ${t.slice(0, 120)}`);
  }
}
const n = (s?: string) => Number(s ?? 0);
const pct = (cur: number, base: number) => (base === 0 ? (cur > 0 ? "new" : "—") : `${cur >= base ? "+" : ""}${(((cur - base) / base) * 100).toFixed(1)}%`);

// ── Pull everything ──────────────────────────────────────────────────────
type Row = Record<string, string | number>;
const totals: Record<string, { s: number; c: number }> = {};
const gptByMedium: Row[] = [];
const gptTotals: Record<string, { s: number; c: number }> = {};

for (const [label, p] of Object.entries(PERIODS)) {
  const tot = await rep({ dateRanges: [p], metrics: [{ name: "sessions" }, { name: "conversions" }] });
  totals[label] = { s: n(tot.rows?.[0]?.metricValues[0].value), c: n(tot.rows?.[0]?.metricValues[1].value) };

  const gpt = await rep({ dateRanges: [p], dimensions: [{ name: "sessionMedium" }], metrics: [{ name: "sessions" }, { name: "conversions" }], dimensionFilter: { filter: { fieldName: "sessionSource", stringFilter: { matchType: "EXACT", value: "chatgpt.com" } } }, limit: 25 });
  let gs = 0, gc = 0;
  for (const r of gpt.rows ?? []) { const s = n(r.metricValues[0].value), c = n(r.metricValues[1].value); gs += s; gc += c; gptByMedium.push({ 기간: label, source: "chatgpt.com", medium: r.dimensionValues[0].value, sessions: s, conversions: c }); }
  gptTotals[label] = { s: gs, c: gc };
}

const daily = await rep({ dateRanges: [PERIODS["현재 (2026-05-22~06-10)"]], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "conversions" }], dimensionFilter: { filter: { fieldName: "sessionMedium", stringFilter: { matchType: "EXACT", value: "ai-assistant" } } } });
const dailyRows: Row[] = (daily.rows ?? []).map((r) => ({ date: r.dimensionValues[0].value.replace(/(....)(..)(..)/, "$1-$2-$3"), sessions: n(r.metricValues[0].value), conversions: n(r.metricValues[1].value) })).sort((a, b) => String(a.date).localeCompare(String(b.date)));

// Daily: our GPT def (chatgpt.com, all medium) vs native ai-assistant by model — current period
const CUR = PERIODS["현재 (2026-05-22~06-10)"];
const gptDailyRep = await rep({ dateRanges: [CUR], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }], dimensionFilter: { filter: { fieldName: "sessionSource", stringFilter: { matchType: "EXACT", value: "chatgpt.com" } } }, limit: 50 });
const gptDaily: Record<string, number> = {};
(gptDailyRep.rows ?? []).forEach((r) => (gptDaily[r.dimensionValues[0].value] = n(r.metricValues[0].value)));
const aaModelRep = await rep({ dateRanges: [CUR], dimensions: [{ name: "date" }, { name: "sessionSource" }], metrics: [{ name: "sessions" }], dimensionFilter: { filter: { fieldName: "sessionMedium", stringFilter: { matchType: "EXACT", value: "ai-assistant" } } }, limit: 200 });
const aaModel: Record<string, Record<string, number>> = {};
(aaModelRep.rows ?? []).forEach((r) => { const dt = r.dimensionValues[0].value, src = r.dimensionValues[1].value; (aaModel[dt] ??= {})[src] = n(r.metricValues[0].value); });
const dailyCompare: Row[] = [...new Set([...Object.keys(gptDaily), ...Object.keys(aaModel)])].sort().map((dt) => {
  const a = aaModel[dt] ?? {};
  return { date: dt.replace(/(....)(..)(..)/, "$1-$2-$3"), "GPT(우리정의)": gptDaily[dt] ?? 0, "ai-asst합계": Object.values(a).reduce((x, y) => x + y, 0), chatgpt: a["chatgpt.com"] ?? 0, gemini: a["gemini.google.com"] ?? 0, perplexity: a["perplexity.ai"] ?? 0 };
});

// ── Build workbook ───────────────────────────────────────────────────────
const wb = new ExcelJS.Workbook();
wb.creator = "hmg-geo ga4:export";
const head = (ws: ExcelJS.Worksheet) => { ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF002C5F" } }; ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; };

// README
const readme = wb.addWorksheet("README");
readme.columns = [{ header: "항목", key: "k", width: 22 }, { header: "내용", key: "v", width: 90 }];
[
  ["리포트", "Kia Italy — GPT(ChatGPT) 유입 성과"],
  ["GA4 속성", `${PROP} (KIA-EU_ITA_NATIONAL, kia.com/it)`],
  ["측정 기준", "GPT = sessionSource = chatgpt.com (= OpenAI utm_source=chatgpt.com + referrer)"],
  ["기간", "현재 2026-05-22~06-10 / 전년 동기 / 직전 2026-05-02~05-21 (각 20일)"],
  ["데이터 출처", "GA4 Data API runReport — 본 파일은 쿼리 결과 원본(가공 전)"],
  ["한계1 (floor)", "모바일 앱·noreferrer는 (direct)로 누락 → 수치는 하한"],
  ["한계2", "Google AI Overviews/AI Mode 제외(organic 분류). 본 리포트는 ChatGPT 챗봇 인용 한정"],
  ["한계3", "소표본 — GA4 thresholding으로 소수값 ±1~2 변동"],
  ["생성", "scripts/ga4/export-raw.ts (npm run ga4:export)"],
].forEach(([k, v]) => readme.addRow({ k, v }));
head(readme);

// Summary
const sum = wb.addWorksheet("Summary");
sum.columns = [
  { header: "지표", key: "m", width: 16 }, { header: "전년(2025)", key: "y", width: 12 },
  { header: "현재(2026)", key: "c", width: 12 }, { header: "YoY Δ", key: "yd", width: 10 },
  { header: "직전(PoP)", key: "p", width: 12 }, { header: "PoP Δ", key: "pd", width: 10 },
];
const cur = "현재 (2026-05-22~06-10)", yoy = "전년 (2025-05-22~06-10)", pop = "직전 (2026-05-02~05-21)";
const share = (x: number, t: number) => `${((x / t) * 100).toFixed(3)}%`;
sum.addRow({ m: "GPT 세션", y: gptTotals[yoy].s, c: gptTotals[cur].s, yd: pct(gptTotals[cur].s, gptTotals[yoy].s), p: gptTotals[pop].s, pd: pct(gptTotals[cur].s, gptTotals[pop].s) });
sum.addRow({ m: "전체 세션", y: totals[yoy].s, c: totals[cur].s, yd: pct(totals[cur].s, totals[yoy].s), p: totals[pop].s, pd: pct(totals[cur].s, totals[pop].s) });
sum.addRow({ m: "GPT 점유율", y: share(gptTotals[yoy].s, totals[yoy].s), c: share(gptTotals[cur].s, totals[cur].s), yd: "", p: share(gptTotals[pop].s, totals[pop].s), pd: "" });
sum.addRow({ m: "GPT 전환", y: gptTotals[yoy].c, c: gptTotals[cur].c, yd: pct(gptTotals[cur].c, gptTotals[yoy].c), p: gptTotals[pop].c, pd: pct(gptTotals[cur].c, gptTotals[pop].c) });
sum.addRow({ m: "전체 전환", y: totals[yoy].c, c: totals[cur].c, yd: pct(totals[cur].c, totals[yoy].c), p: totals[pop].c, pd: pct(totals[cur].c, totals[pop].c) });
head(sum);

// GPT by medium
const g = wb.addWorksheet("GPT_by_medium");
g.columns = [{ header: "기간", key: "기간", width: 26 }, { header: "source", key: "source", width: 14 }, { header: "medium", key: "medium", width: 14 }, { header: "sessions", key: "sessions", width: 10 }, { header: "conversions", key: "conversions", width: 12 }];
gptByMedium.forEach((r) => g.addRow(r));
head(g);

// Totals
const t = wb.addWorksheet("Totals_by_period");
t.columns = [{ header: "기간", key: "k", width: 26 }, { header: "total_sessions", key: "s", width: 16 }, { header: "total_conversions", key: "c", width: 18 }];
Object.entries(totals).forEach(([k, v]) => t.addRow({ k, s: v.s, c: v.c }));
head(t);

// AI Assistant daily
const d = wb.addWorksheet("AI_Assistant_daily");
d.columns = [{ header: "date", key: "date", width: 14 }, { header: "sessions", key: "sessions", width: 10 }, { header: "conversions", key: "conversions", width: 12 }];
dailyRows.forEach((r) => d.addRow(r));
head(d);

// AI daily compare — our GPT def vs native ai-assistant by model (current period)
const dc = wb.addWorksheet("AI_daily_compare");
dc.columns = [{ header: "date", key: "date", width: 12 }, { header: "GPT(우리정의)", key: "GPT(우리정의)", width: 14 }, { header: "ai-asst합계", key: "ai-asst합계", width: 12 }, { header: "ai:chatgpt", key: "chatgpt", width: 12 }, { header: "ai:gemini", key: "gemini", width: 10 }, { header: "ai:perplexity", key: "perplexity", width: 12 }];
dailyCompare.forEach((r) => dc.addRow(r));
head(dc);

const out = "docs/data/2-extract/ga4/kia-italy-gpt-traffic-raw-2026-0522-0610.xlsx";
await wb.xlsx.writeFile(out);
console.log(`✅ wrote ${out}`);
console.log(`   sheets: README, Summary, GPT_by_medium, Totals_by_period, AI_Assistant_daily, AI_daily_compare`);
