// 데우기 후보 대조 하네스(동기화 S1 BE-9): front 의 실제 규칙 코드로 D7 brand_key 를 계산한다.
//
//   node tests/core/warm_candidates.mjs <front 루트> <사례 JSON>   → stdout 한 줄 JSON {사례 id: [brand_key 오름차순]}
//
// front 루트 = lib/scope/competitor-row.ts·lib/kpi/competitor-values.ts·lib/kpi/first-position-rank.ts·lib/hgh/convert.ts 가 있는 디렉터리
// (hub front/ 또는 같은 경로로 모은 hmg-geo 스냅샷). TypeScript 는 Node 형식 제거로 그대로 읽고, "@/…" 별칭·확장자 없는 상대 경로만 풀어 준다.
// 어댑터 접착(front/lib/hgh/adapters/dashboard.ts:423-455 toCompetitorBrandValue·candidateBrandKeys, trend.ts:156 오름차순)은 아래에
// 옮겨 적었다. dashboard.ts 는 react·서버 모듈을 끌어와 여기서 읽을 수 없어서다. 옮긴 줄이 원본과 같은지는 test_warm_cache.py 가 원문 대조로 지킨다.
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, casesPath] = [path.resolve(process.argv[2]), process.argv[3]];

function tsFile(p) {
  for (const c of [p, `${p}.ts`, `${p}.tsx`, path.join(p, "index.ts")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

registerHooks({
  resolve(spec, ctx, next) {
    let hit = null;
    if (spec.startsWith("@/")) hit = tsFile(path.join(root, spec.slice(2)));
    else if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.startsWith("file:")) {
      hit = tsFile(new URL(spec, ctx.parentURL).pathname);
    }
    return hit ? { url: pathToFileURL(hit).href, shortCircuit: true } : next(spec, ctx);
  },
});

const cr = await import(pathToFileURL(path.join(root, "lib/scope/competitor-row.ts")).href);
const cv = await import(pathToFileURL(path.join(root, "lib/hgh/convert.ts")).href);

// dashboard.ts toCompetitorBrandValue(후보 규칙이 읽는 필드만: 감정 4열은 Δ 지표 셋이 읽지 않는다)
const toCompetitorBrandValue = (b) => ({
  brand: b.name,
  mentions: b.mentions,
  share: cv.pct1OrZero(b.share),
  mentionRate: cv.pct1OrZero(b.exposure),
  avgPosition: cv.rankAvg(b.avg_rank),
  isTracked: b.is_own || b.is_hmg_own === true,
  ...(typeof b.brand_key === "number" ? { brandKey: b.brand_key } : {}),
});

// dashboard.ts candidateBrandKeys
function candidateBrandKeys(brands) {
  const byName = new Map(brands.map((b) => [b.brand, b.brandKey]));
  const keys = [];
  for (const name of cr.competitorDeltaBrands([...brands])) {
    const k = byName.get(name);
    if (typeof k === "number" && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")).cases;
const out = {};
for (const c of cases) {
  const keys = candidateBrandKeys(c.brands.map(toCompetitorBrandValue));
  out[c.id] = [...new Set(keys)].sort((a, b) => a - b); // trend.ts:156
}
process.stdout.write(`${JSON.stringify(out)}\n`);
