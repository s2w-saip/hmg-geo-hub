// dump-official.ts : 동기화 S1 BE-B R7 대조 오라클. 현행 글로벌 ⑤ 분자 판정(lib/kpi/official-hmg-citations.ts isOfficialHmgGroupKey =
// resolveCitationCategory(rowCategory = null, groupKey, overrides) === "Official (HMG)")과 그 카테고리를 후보 그룹 키마다 JSON 으로 낸다.
// 손으로 옮겨 적지 않는다(dump-b.ts 와 같은 방식). 입력 = gen_official_cases.py 출력(OFFICIAL_CANDIDATES 경로).
// 실행: python3 gen_official_cases.py > /tmp/c.json
//       cd <hmg-geo 체크아웃(동기화 S1 = 2670a16)> && OFFICIAL_CANDIDATES=/tmp/c.json node_modules/.bin/tsx -e "$(cat <this file>)" > ts-dump-official.json
// 리포 파일은 쓰지 않는다(-e 평가, cwd = 리포 루트라 "./lib/..." 가 풀린다).
import { readFileSync } from "node:fs";
import { resolveCitationCategory, type CitationOverrideMap } from "./lib/citation-categorizer";
import { isCitationCategory, type CitationCategory } from "./lib/citation-categorizer/taxonomy";
import { isOfficialHmgGroupKey, OFFICIAL_HMG_CATEGORY } from "./lib/kpi/official-hmg-citations";

const input = JSON.parse(readFileSync(process.env.OFFICIAL_CANDIDATES as string, "utf8")) as {
  overrides: Record<string, string>;
  keys: string[];
};
const ov: CitationOverrideMap = new Map(
  Object.entries(input.overrides).map(([d, c]) => {
    if (!isCitationCategory(c)) throw new Error(`택소노미 밖 카테고리: ${c}`);
    return [d, c as CitationCategory];
  }),
);
const none: CitationOverrideMap = new Map();
process.stdout.write(JSON.stringify({
  source: "hmg-geo 2670a1608f5b270c5c0688d5f8051daa2f66892c lib/kpi/official-hmg-citations.ts · lib/citation-categorizer",
  official: OFFICIAL_HMG_CATEGORY,
  overrides: input.overrides,
  cases: input.keys.map((k) => ({
    key: k,
    cat: resolveCitationCategory(null, k, none),
    cat_ov: resolveCitationCategory(null, k, ov),
    off: isOfficialHmgGroupKey(k, none),
    off_ov: isOfficialHmgGroupKey(k, ov),
  })),
}, null, 0));
