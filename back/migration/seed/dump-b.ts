// dump-b.ts : 빌더 B(seed-30·40) 가 쓰는 현행 코드 상수를 JSON 으로 덤프한다(손으로 옮겨 적지 않음).
// 실행: cd <hmg-geo 체크아웃(동기화 S1 = 2670a16)> && node_modules/.bin/tsx -e "$(cat <this file>)" > ts-dump-b.json
// 2026-09-30: 7639b9e·2670a16 두 트리의 출력이 바이트 동일(seed-3x-rules.sql 은 원천 파일 sha 주석만 바뀐다).
// 리포 파일은 쓰지 않는다(-e 평가, cwd = 리포 루트라 "./lib/..." 가 풀린다).
import { GEO_OWNED_DOMAINS, ownedBrandOf, SHARED_GLOBAL_HOSTS } from "./lib/geo-catalog/owned";
import { geoLocateByCode } from "./lib/geo-catalog";
import { OFFICIAL_SOCIAL_ACCOUNTS } from "./lib/citation-categorizer/official-social";
import { CITATION_CATEGORIES } from "./lib/citation-categorizer/taxonomy";
import rawSeed from "./lib/citation-categorizer/seed.json";
import { WEBSITE_BRAND_GEO_CODES } from "./lib/scope/website-virtual-geo";
import { UMBRELLA_BRAND } from "./lib/scope/brand-presence";

const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const isoRegion: Array<[string, string]> = [];
for (const a of A) for (const b of A) {
  const loc = geoLocateByCode(a + b);
  if (loc) isoRegion.push([a + b, loc.region]);
}
const cats = new Set<string>(CITATION_CATEGORIES as readonly string[]);
const seed = Object.entries(rawSeed as Record<string, string>)
  .filter(([, c]) => cats.has(c))
  .map(([d, c]) => [d.toLowerCase(), c]);
process.stdout.write(JSON.stringify({
  owned_domains: GEO_OWNED_DOMAINS.map((d) => [d, ownedBrandOf(d)]),
  shared_hosts: [...SHARED_GLOBAL_HOSTS],
  iso_region: isoRegion,
  social: OFFICIAL_SOCIAL_ACCOUNTS.map((a) => ({ key: a.key, domain: a.domain, matchers: a.matchers })),
  categories: [...cats],
  seed,
  virtual_geo: Object.entries(WEBSITE_BRAND_GEO_CODES),
  umbrella: UMBRELLA_BRAND,
}));
