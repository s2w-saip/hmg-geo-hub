/**
 * seed.json 보강 — 사람이 전수 판정한 "도메인 분류사전"을 큐레이션 seed 로 병합한다.
 *
 * 사전은 둘이다(2026-08-24):
 *   · 앤서 Quick-Win 사전  — 인용 6,801건 전수 판정, 513 호스트
 *   · 고객(이노션/HMG) GGMD 사전 — 인용 8,821건 전수 판정, 593 호스트
 * 겹치는 252개 중 40건이 불일치했고, 교차하니 **양쪽 다 틀린 곳**이 드러났다. 그래서
 * 사전 병합 위에 **판정 원장**(./dictionary-rulings.json)을 한 겹 더 둔다 — 어느 사전이
 * 뭐라 했든 원장이 이긴다. 원장의 category="Other" 는 "seed 에 넣지 않는다"는 뜻이다
 * (Other 는 fallback 이라 명시 엔트리가 필요 없다).
 *
 * 입력(JSON 배열 또는 CSV):
 *   JSON: [{ "host": "yna.co.kr", "count": 123, "cat_ko": "뉴스·미디어", "why": "연합뉴스" }, …]
 *   CSV : 헤더에 host|domain / category|cat_ko / count|citations|*_citations 컬럼이 있으면 된다.
 * 카테고리 라벨은 messages/ko.json::citationCategories 값과 문자 단위로 같아야 한다.
 *
 * 왜 스크립트인가 — 사전은 **호스트** 단위(newsroom.genesis.com, car.chosun.com)인데
 * 분류기 입력은 **registrable domain** 이다. 손으로 접으면 접기 규칙이 또 갈린다
 * (이 PR 이 고치는 결함이 정확히 그것). 접기는 lib/public-suffix 하나만 쓰고,
 * 한 registrable domain 아래 호스트들의 판정이 갈리면 **인용 건수 가중 다수결**로
 * 정하고 충돌을 전부 출력한다.
 *
 * 사용:
 *   npx tsx scripts/citations/merge-domain-dictionary.ts <dict.json|dict.csv> \
 *     [--rulings scripts/citations/dictionary-rulings.json] [--write]
 * --write 없이는 아무것도 쓰지 않고 통계만 낸다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { registrableDomainOfHost } from "@/lib/public-suffix";
import { ownedBrandOf } from "@/lib/geo-catalog/owned";
import { categorizeDomain, normalizeCitationDomain } from "@/lib/citation-categorizer";
import { ruleCategory } from "@/lib/citation-categorizer/rules";
import {
  CITATION_CATEGORIES,
  FALLBACK_CATEGORY,
  isCitationCategory,
  type CitationCategory,
} from "@/lib/citation-categorizer/taxonomy";

const SEED_PATH = path.join(process.cwd(), "lib", "citation-categorizer", "seed.json");

/** messages/ko.json::citationCategories 의 역방향. 사전의 한글 라벨 → 택소노미 값. */
const KO_TO_CATEGORY: Record<string, CitationCategory> = {
  "공식 (HMG)": "Official (HMG)",
  "공식 (경쟁사)": "Official (Competitor)",
  "딜러·마켓플레이스": "Dealer & Marketplace",
  "자동차 미디어": "Automotive Media",
  "뉴스·미디어": "News & Media",
  "커뮤니티·포럼": "Community & Forums",
  "소셜·영상": "Social & Video",
  "블로그·리뷰": "Blogs & Reviews",
  "위키·백과": "Wiki & Reference",
  "정부·공공": "Government & Public",
  기타: FALLBACK_CATEGORY,
};

interface DictRow {
  host: string;
  count?: number;
  cat_ko: string;
  why?: string;
}

interface Ruling {
  category: string;
  winner?: string;
  rows?: number;
  reason?: string;
}

/** 아주 단순한 CSV 파서 — 이 입력들은 따옴표·임베디드 개행이 없다(사전 생성 시 확인). */
function readDict(path: string): DictRow[] {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return JSON.parse(raw) as DictRow[];
  const [header, ...lines] = raw.trim().split("\n");
  const cols = header!.split(",").map((c) => c.trim());
  const idx = (...names: string[]): number =>
    cols.findIndex((c) => names.includes(c) || names.some((n) => c.endsWith(n)));
  const hi = idx("host", "domain");
  const ci = idx("category", "cat_ko");
  const ni = idx("count", "citations", "_citations");
  if (hi < 0 || ci < 0) throw new Error(`CSV 헤더에 host/domain·category 컬럼이 없다: ${header}`);
  return lines
    .filter((l) => l.trim())
    .map((l) => {
      const f = l.split(",");
      return {
        host: (f[hi] ?? "").trim(),
        cat_ko: (f[ci] ?? "").trim(),
        count: ni >= 0 ? Number(f[ni]) || 0 : 0,
      };
    });
}

function main(): void {
  const [input, ...flags] = process.argv.slice(2);
  if (!input) throw new Error("usage: merge-domain-dictionary.ts <dict.json|dict.csv> [--rulings f] [--write]");
  const write = flags.includes("--write");
  const rIdx = flags.indexOf("--rulings");
  const rulingsPath = rIdx >= 0 ? flags[rIdx + 1] : undefined;

  const rows = readDict(input);
  const seed = JSON.parse(readFileSync(SEED_PATH, "utf8")) as Record<string, string>;

  // registrable domain → category → 가중치(인용 건수) + 근거 호스트
  const votes = new Map<string, Map<CitationCategory, { weight: number; hosts: string[] }>>();
  let badLabel = 0;
  let badHost = 0;

  for (const r of rows) {
    const category = KO_TO_CATEGORY[r.cat_ko?.trim() ?? ""];
    if (!category) {
      badLabel += 1;
      console.warn(`  ! 알 수 없는 카테고리 라벨: ${JSON.stringify(r.cat_ko)} (${r.host})`);
      continue;
    }
    const domain = normalizeCitationDomain(registrableDomainOfHost(r.host));
    if (!domain) {
      badHost += 1;
      continue;
    }
    const byCat = votes.get(domain) ?? new Map();
    const cur = byCat.get(category) ?? { weight: 0, hosts: [] };
    cur.weight += Math.max(1, r.count ?? 1);
    cur.hosts.push(r.host);
    byCat.set(category, cur);
    votes.set(domain, byCat);
  }

  const conflicts: string[] = [];
  const inertOwned: string[] = [];
  const seedConflicts: string[] = [];
  const added: string[] = [];
  const skippedOther: string[] = [];
  const correctedToOther: string[] = [];

  for (const [domain, byCat] of [...votes.entries()].sort()) {
    const ranked = [...byCat.entries()].sort((a, b) => b[1].weight - a[1].weight);
    // 동률·해석충돌 시 **apex 호스트**(호스트 == registrable domain)의 판정이 이긴다.
    // 사람이 그 도메인 자체를 보고 내린 판정이라, 서브도메인 표본의 가중합보다
    // 도메인 단위 라벨에 가깝다. apex 행이 없으면 인용 건수 가중 다수결.
    const apex = ranked.find(([, v]) => v.hosts.includes(domain));
    const winner = (apex ?? ranked[0]!)[0];
    if (ranked.length > 1) {
      conflicts.push(
        `${domain} → ${winner} (승) | ${ranked
          .map(([c, v]) => `${c}:${v.weight}[${v.hosts.join(",")}]`)
          .join(" vs ")}`,
      );
    }

    // owned 판정이 seed 보다 위라(index.ts 우선순위 1) 이 도메인의 seed 는 무효.
    if (ownedBrandOf(domain) !== null) {
      inertOwned.push(`${domain} (사전=${winner}, 카탈로그 owned)`);
      continue;
    }

    const current = categorizeDomain(domain);
    if (winner === FALLBACK_CATEGORY) {
      // "기타"는 fallback 이라 seed 에 넣을 이유가 없다 — 단 현재 분류기가
      // 엉뚱한 카테고리를 주고 있으면(오탐) 명시 seed 로 눌러야 한다.
      if (current === FALLBACK_CATEGORY) {
        skippedOther.push(domain);
        continue;
      }
      correctedToOther.push(`${domain} (현행 ${current} → Other)`);
    }

    const existing = seed[domain];
    if (existing === winner) continue;
    if (existing && existing !== winner) {
      seedConflicts.push(`${domain}: seed=${existing} → 사전=${winner}`);
    } else {
      added.push(`${domain}=${winner}`);
    }
    seed[domain] = winner;
  }

  // ── 판정 원장 — 사전보다 위. 두 사전이 서로 다르거나 둘 다 틀린 지점의 최종 값이다.
  const applied: string[] = [];
  const removed: string[] = [];
  if (rulingsPath) {
    const rulings = JSON.parse(readFileSync(rulingsPath, "utf8")) as Record<string, Ruling>;
    for (const [domain, r] of Object.entries(rulings)) {
      if (domain.startsWith("_")) continue;
      const before = seed[domain];
      if (r.category === FALLBACK_CATEGORY) {
        // "어느 사전이 뭐라 했든 seed 에 넣지 않는다" — 다만 규칙이 발화하면 그 값이 남는다.
        if (before !== undefined) {
          delete seed[domain];
          removed.push(`${domain} (seed=${before} 삭제, ${r.winner ?? "?"})`);
        }
        const stillRules = ruleCategory(domain);
        if (stillRules) {
          console.warn(
            `  ! ${domain}: Other 판정이지만 rules.ts 가 ${stillRules} 를 준다 — 규칙 쪽 확인 필요`,
          );
        }
        continue;
      }
      if (!isCitationCategory(r.category)) {
        throw new Error(`판정 원장의 카테고리가 택소노미 밖이다: ${domain} → ${r.category}`);
      }
      if (before !== r.category) {
        applied.push(`${domain}: ${before ?? "(미등재)"} → ${r.category} [${r.winner ?? "?"}]`);
        seed[domain] = r.category;
      }
    }
  }

  const merged = Object.fromEntries(
    Object.entries(seed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  const dist = new Map<string, number>();
  for (const c of Object.values(merged)) dist.set(c, (dist.get(c) ?? 0) + 1);

  console.log(`사전 행 ${rows.length} · 라벨오류 ${badLabel} · 호스트파싱실패 ${badHost}`);
  console.log(`registrable domain 으로 접힘: ${votes.size}`);
  console.log(`충돌(한 도메인 다중 카테고리): ${conflicts.length}`);
  for (const c of conflicts) console.log(`  · ${c}`);
  console.log(`카탈로그 owned 라 seed 불필요: ${inertOwned.length}`);
  for (const c of inertOwned) console.log(`  · ${c}`);
  console.log(`기존 seed 와 충돌(사전 우선 적용): ${seedConflicts.length}`);
  for (const c of seedConflicts) console.log(`  · ${c}`);
  console.log(`현행 오탐을 Other 로 명시: ${correctedToOther.length}`);
  for (const c of correctedToOther) console.log(`  · ${c}`);
  console.log(`"기타"라 seed 생략: ${skippedOther.length}`);
  console.log(`신규 추가: ${added.length}`);
  console.log(`판정 원장 적용(값 변경/신규): ${applied.length}`);
  for (const a of applied) console.log(`  · ${a}`);
  console.log(`판정 원장으로 seed 에서 제거(Other 판정): ${removed.length}`);
  for (const r of removed) console.log(`  · ${r}`);
  console.log(`seed 총 엔트리: ${Object.keys(merged).length}`);
  console.log(
    `분포: ${CITATION_CATEGORIES.map((c) => `${c}=${dist.get(c) ?? 0}`).join(" · ")}`,
  );

  if (write) {
    writeFileSync(SEED_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    console.log(`wrote ${SEED_PATH}`);
  } else {
    console.log("(dry-run — --write 를 주면 seed.json 을 갱신한다)");
  }
}

main();
