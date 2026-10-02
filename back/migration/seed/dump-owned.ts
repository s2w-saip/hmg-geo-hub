// dump-owned.ts: ts-dump.json 의 코드 유래 키 4개(owned·root_home·shared_hosts·hidden_regions)를 hmg-geo 트리에서 다시 뽑는다(리포 파일 쓰기 없음).
// 실행(hmg-geo 체크아웃 루트, node_modules 필요): node_modules/.bin/tsx -e "$(cat <this file>)" > owned.json
// 병합(나머지 키는 그대로): python3 -c "import json,sys;d=json.load(open('ts-dump.json'));d.update(json.load(sys.stdin));
//   open('ts-dump.json','w').write(json.dumps(d,ensure_ascii=False,separators=(',',':'))+'\n')" < owned.json
// 검증(2026-09-30): 7639b9e 에서 돌리면 종전 ts-dump.json 의 owned·root_home·shared_hosts 와 같다(JSON 동일).
//   owned = GEO_OWNED_BASES(lib/geo-catalog/owned.ts, OWNED_BASE_URL_FIXES 적용 뒤) + host(prefix 첫 조각)·iso(geoCountryCode).
//   root_home = 공유 글로벌 호스트가 아닌 호스트마다 ownedBaseEntryForUrl('https://'+host)(같은 호스트의 가장 짧은 base), 호스트 정렬.
//   hidden_regions = HIDDEN_STANDARD_REGIONS(lib/scope/hidden-regions.ts).
import { GEO_OWNED_BASES, SHARED_GLOBAL_HOSTS, ownedBaseEntryForUrl } from "./lib/geo-catalog/owned";
import { geoCountryCode } from "./lib/geo-catalog";
import { HIDDEN_STANDARD_REGIONS } from "./lib/scope/hidden-regions";

const owned = GEO_OWNED_BASES.map((e) => ({
  brand: e.brand, region: e.region, country: e.country, language: e.language, url: e.url, prefix: e.prefix,
  host: e.prefix.split("/")[0], iso: geoCountryCode(e.country),
}));
const hosts = [...new Set(owned.map((e) => e.host))].filter((h) => !SHARED_GLOBAL_HOSTS.has(h)).sort();
const root_home = hosts.map((h) => {
  const e = ownedBaseEntryForUrl("https://" + h);
  return { host: h, brand: e?.brand ?? null, iso: e ? geoCountryCode(e.country) : null, language: e?.language ?? null, via_prefix: e?.prefix ?? null };
});
process.stdout.write(JSON.stringify({ owned, root_home, shared_hosts: [...SHARED_GLOBAL_HOSTS], hidden_regions: [...HIDDEN_STANDARD_REGIONS] }));
