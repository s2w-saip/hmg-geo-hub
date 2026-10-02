/**
 * Exports activeUsers-based raw GA4 data to a multi-sheet .xlsx:
 *   - daily activeUsers (total vs GPT chatgpt.com) over 90 days + daily ratio
 *   - ratio averages split at 작업시작일 5/6
 *   - 3-period activeUsers summary (sessionSource vs firstUserSource)
 *
 *   npm run ga4:export:au
 * Output: docs/data/2-extract/ga4/kia-italy-gpt-activeusers-raw.xlsx (gitignored)
 */
import fs from "node:fs";
import { OAuth2Client } from "google-auth-library";
import ExcelJS from "exceljs";

const PROP = process.env.GA4_PROPERTY_ID!;
const oauth = new OAuth2Client({ clientId: process.env.GA4_OAUTH_CLIENT_ID!, clientSecret: process.env.GA4_OAUTH_CLIENT_SECRET! });
oauth.setCredentials(JSON.parse(fs.readFileSync(".ga4-token.json", "utf8")));
const token = (await oauth.getAccessToken()).token!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n = (s?: string) => Number(s ?? 0);
const eq = (f: string, v: string) => ({ filter: { fieldName: f, stringFilter: { matchType: "EXACT", value: v } } });

async function rep(body: object): Promise<any> {
  for (let a = 1; ; a++) {
    const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const t = await res.text();
    if ([429, 500, 502, 503, 504].includes(res.status) && a < 6) { await sleep(2000 * a); continue; }
    throw new Error(`GA4 ${res.status}: ${t.slice(0, 120)}`);
  }
}
async function metrics(period: [string, string], ms: string[], filter?: object): Promise<number[]> {
  const j = await rep({ dateRanges: [{ startDate: period[0], endDate: period[1] }], metrics: ms.map((name) => ({ name })), ...(filter ? { dimensionFilter: filter } : {}) });
  return ms.map((_, i) => n(j.rows?.[0]?.metricValues[i]?.value));
}
async function dailyAU(period: [string, string], filter?: object): Promise<Record<string, number>> {
  const j = await rep({ dateRanges: [{ startDate: period[0], endDate: period[1] }], dimensions: [{ name: "date" }], metrics: [{ name: "activeUsers" }], ...(filter ? { dimensionFilter: filter } : {}), limit: 120 });
  const o: Record<string, number> = {};
  (j.rows ?? []).forEach((r: any) => (o[r.dimensionValues[0].value] = n(r.metricValues[0].value)));
  return o;
}

// ── Daily (90 days) ──
const RANGE: [string, string] = ["2026-03-13", "2026-06-10"];
const totalD = await dailyAU(RANGE);
const gptD = await dailyAU(RANGE, eq("sessionSource", "chatgpt.com"));
const pad = (x: number) => String(x).padStart(2, "0");
const dates: string[] = [];
for (let d = new Date(`${RANGE[0]}T00:00:00Z`), e = new Date(`${RANGE[1]}T00:00:00Z`); d <= e; d.setUTCDate(d.getUTCDate() + 1))
  dates.push(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`);

const dailyRows = dates.map((d) => {
  const t = totalD[d] ?? 0, g = gptD[d] ?? 0;
  return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, total_activeUsers: t, gpt_activeUsers: g, "ratio_GPT/전체(%)": t ? Math.round((g / t) * 1e6) / 1e4 : 0 };
});

function split(from: string, to: string) {
  const sel = dates.filter((d) => d >= from && d <= to);
  const ratios = sel.map((d) => { const t = totalD[d] ?? 0; return t ? (gptD[d] ?? 0) / t : 0; });
  const sumG = sel.reduce((a, d) => a + (gptD[d] ?? 0), 0), sumT = sel.reduce((a, d) => a + (totalD[d] ?? 0), 0);
  return { days: sel.length, mean: ratios.reduce((a, b) => a + b, 0) / ratios.length, sumRatio: sumG / sumT, sumG, sumT };
}
const p1 = split("20260313", "20260505"), p2 = split("20260506", "20260610");

// ── 3-period summary ──
const PERIODS: Record<string, [string, string]> = { "현재 (2026-05-22~06-10)": ["2026-05-22", "2026-06-10"], "전년 (2025-05-22~06-10)": ["2025-05-22", "2025-06-10"], "직전 (2026-05-02~05-21)": ["2026-05-02", "2026-05-21"] };
const periodRows: any[] = [];
for (const [k, p] of Object.entries(PERIODS)) {
  const [ts, tau] = await metrics(p, ["sessions", "activeUsers"]);
  const [gs, gau] = await metrics(p, ["sessions", "activeUsers"], eq("sessionSource", "chatgpt.com"));
  const [, fau] = await metrics(p, ["sessions", "activeUsers"], eq("firstUserSource", "chatgpt.com"));
  periodRows.push({ 기간: k, 전체_activeUsers: tau, "GPT_거쳐감(sessionSource)": gau, "GPT_최초획득(firstUserSource)": fau, GPT_세션: gs, "세션/사용자": Math.round((gs / gau) * 100) / 100, 전체_세션: ts });
}

// ── Workbook ──
const wb = new ExcelJS.Workbook();
const head = (ws: ExcelJS.Worksheet) => { ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF002C5F" } }; };
const pctf = (x: number) => (x * 100).toFixed(4) + "%";

const readme = wb.addWorksheet("README");
readme.columns = [{ header: "항목", key: "k", width: 22 }, { header: "내용", key: "v", width: 92 }];
[
  ["기준 지표", "activeUsers (활성 사용자) — GA4 UI '사용자'와 일치"],
  ["GPT 정의", "sessionSource = chatgpt.com (= OpenAI utm_source=chatgpt.com + referrer)"],
  ["GA4 속성", `${PROP} (KIA-EU_ITA_NATIONAL, kia.com/it)`],
  ["일별 기간", "2026-03-13 ~ 06-10 (90일)"],
  ["비율 분할", "작업시작일 5/6 기준 (3/13~5/5 vs 5/6~6/10)"],
  ["출처", "GA4 Data API runReport — 쿼리 결과 원본"],
  ["한계", "소표본(GPT 일 2~13) · 모바일/noreferrer는 (direct) 누락(하한) · firstUserSource=최초획득 / sessionSource=유입경험"],
  ["생성", "scripts/ga4/export-activeusers.ts (npm run ga4:export:au)"],
].forEach(([k, v]) => readme.addRow({ k, v }));
head(readme);

const daily = wb.addWorksheet("Daily_activeUsers");
daily.columns = [{ header: "date", key: "date", width: 12 }, { header: "total_activeUsers", key: "total_activeUsers", width: 16 }, { header: "gpt_activeUsers", key: "gpt_activeUsers", width: 14 }, { header: "ratio_GPT/전체(%)", key: "ratio_GPT/전체(%)", width: 16 }];
dailyRows.forEach((r) => daily.addRow(r));
head(daily);

const ratio = wb.addWorksheet("Ratio_split_5-6");
ratio.columns = [{ header: "구간", key: "k", width: 20 }, { header: "일수", key: "d", width: 8 }, { header: "일별비율 평균", key: "m", width: 14 }, { header: "합계기준 비율", key: "s", width: 14 }, { header: "GPT 합", key: "g", width: 10 }, { header: "전체 합", key: "t", width: 12 }];
ratio.addRow({ k: "3/13 ~ 5/5 (작업 전)", d: p1.days, m: pctf(p1.mean), s: pctf(p1.sumRatio), g: p1.sumG, t: p1.sumT });
ratio.addRow({ k: "5/6 ~ 6/10 (작업 후)", d: p2.days, m: pctf(p2.mean), s: pctf(p2.sumRatio), g: p2.sumG, t: p2.sumT });
ratio.addRow({ k: "배수 (후/전, 일별비율)", d: "", m: (p2.mean / p1.mean).toFixed(2) + "x", s: "", g: "", t: "" });
head(ratio);

const per = wb.addWorksheet("User_3periods");
per.columns = [{ header: "기간", key: "기간", width: 26 }, { header: "전체_activeUsers", key: "전체_activeUsers", width: 16 }, { header: "GPT_거쳐감(sessionSource)", key: "GPT_거쳐감(sessionSource)", width: 22 }, { header: "GPT_최초획득(firstUserSource)", key: "GPT_최초획득(firstUserSource)", width: 24 }, { header: "GPT_세션", key: "GPT_세션", width: 10 }, { header: "세션/사용자", key: "세션/사용자", width: 12 }, { header: "전체_세션", key: "전체_세션", width: 12 }];
periodRows.forEach((r) => per.addRow(r));
head(per);

const out = "docs/data/2-extract/ga4/kia-italy-gpt-activeusers-raw.xlsx";
await wb.xlsx.writeFile(out);
console.log(`✅ wrote ${out}`);
console.log(`   sheets: README, Daily_activeUsers(${dailyRows.length}), Ratio_split_5-6, User_3periods`);
console.log(`   ratio 3/13~5/5 = ${pctf(p1.mean)} · 5/6~6/10 = ${pctf(p2.mean)} (${(p2.mean / p1.mean).toFixed(2)}x)`);
