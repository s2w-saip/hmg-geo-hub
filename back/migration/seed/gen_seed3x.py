#!/usr/bin/env python3
"""seed-3x-rules.sql 생성기 (빌더 B: seed-30·seed-40 공용 판정 입력 데이터).

입력
  - ts-dump-b.json : dump-b.ts 를 현행 리포(hmg-geo 2670a16) 루트에서 tsx -e 로 평가한 결과(7639b9e 와 JSON 동일, 2026-09-30 확인)
                     (GEO_OWNED_DOMAINS·ownedBrandOf, OFFICIAL_SOCIAL_ACCOUNTS, seed.json(택소노미 필터 후),
                      geoLocateByCode, WEBSITE_BRAND_GEO_CODES, SHARED_GLOBAL_HOSTS)
  - 현행 코드 파일 직접 파싱: lib/citation-categorizer/rules.ts (Set·정규식 리터럴, 평가 순서 단언)
출력
  - seed-3x-rules.sql : 세션 임시 표(pg_temp)만 만든다. 영구 객체·쓰기 없음. seed-30·40 이 \\ir 로 읽는다.
사용: HMG_GEO_REPO=<hmg-geo 2670a16 체크아웃> python3 gen_seed3x.py ts-dump-b.json > seed-3x-rules.sql
  HMG_GEO_REPO 가 없으면 이 리포 front/(동기화 S1 벤더 병합 뒤 = hmg-geo 2670a16 트리)를 읽는다.
"""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

REPO = os.environ.get("HMG_GEO_REPO") or str(Path(__file__).resolve().parents[3] / "front")
RULES = "lib/citation-categorizer/rules.ts"


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def sha(path):
    return hashlib.sha256(open(f"{REPO}/{path}", "rb").read()).hexdigest()


d = json.load(open(sys.argv[1]))
src = open(f"{REPO}/{RULES}", encoding="utf8").read()

# ── rules.ts: Set 리터럴 ────────────────────────────────────────────────────
sets = {}
for m in re.finditer(r"const (\w+) = new Set\(\[(.*?)\]\);", src, re.S):
    sets[m.group(1)] = re.findall(r'"([^"]+)"', m.group(2))
NEED_SETS = ["HMG_BRAND_LABEL", "COMPETITOR_OFFICIAL", "COMPETITOR_BRAND_LABEL", "COMMUNITY", "SOCIAL_VIDEO",
             "BLOG_PLATFORMS", "PUBLIC_ORGS", "WIKI_REFERENCE", "CONTAINED_BRAND_DENY", "AWARD_CERT", "ACADEMIC_ORGS"]
for s in NEED_SETS:
    assert s in sets and sets[s], s

# ── rules.ts: 정규식 리터럴(상수) ────────────────────────────────────────────
rx = {}
for m in re.finditer(r"const (\w+) =\s*/(.+?)/;\s*$", src, re.M | re.S):
    body = m.group(2)
    assert "\n" not in body, m.group(1)
    rx[m.group(1)] = body
NEED_RX = ["WIKI_PATTERN", "DEALER_BRAND_PREFIX", "GOV_TLD", "CONTAINED_BRAND", "ACADEMIC_TLD"]
for r in NEED_RX:
    assert r in rx, r
# ruleCategory 안의 인라인 정규식 2개
inline = re.findall(r"if \(/(.+?)/\.test\(domain\)\) return", src)
assert inline == [r"forum|ownersclub|owners\.", "dealer"], inline
rx["INLINE_COMMUNITY"] = inline[0]
rx["INLINE_DEALER"] = inline[1]
for k, v in rx.items():  # JS 전용 문법이 없는지(ARE 로 그대로 쓸 수 있는지) 확인
    assert not re.search(r"\(\?[=!<]|\\[dDwWsSbB]|\\p\{", v), (k, v)

# ── ruleCategory 평가 순서 단언(rules.ts 본문이 바뀌면 생성 실패) ──────────────
body = src[src.index("export function ruleCategory"):]
ORDER = [
    "if (isHmgBrandDomain(domain)) return \"Official (HMG)\"",
    "if (COMPETITOR_OFFICIAL.has(domain)) return \"Official (Competitor)\"",
    "if (COMPETITOR_BRAND_LABEL.has(domainLabel(domain))) return \"Official (Competitor)\"",
    "if (WIKI_REFERENCE.has(domain) || WIKI_PATTERN.test(domain)) return \"Wiki & Reference\"",
    "if (COMMUNITY.has(domain)) return \"Community & Forums\"",
    "if (SOCIAL_VIDEO.has(domain)) return \"Social & Video\"",
    "if (BLOG_PLATFORMS.has(domain)) return \"Blogs & Reviews\"",
    "if (PUBLIC_ORGS.has(domain) || GOV_TLD.test(domain)) return \"Government & Public\"",
    "if (AWARD_CERT.has(domain)) return \"Award & Certification\"",
    "if (ACADEMIC_ORGS.has(domain) || ACADEMIC_TLD.test(domain)) return \"Academic & Research\"",
    "if (/forum|ownersclub|owners\\./.test(domain)) return \"Community & Forums\"",
    "if (/dealer/.test(domain)) return \"Dealer & Marketplace\"",
    "if (DEALER_BRAND_PREFIX.test(domain)) return \"Dealer & Marketplace\"",
    "if (CONTAINED_BRAND.test(domain) && !CONTAINED_BRAND_DENY.has(domain)) {",
]
pos = -1
for line in ORDER:
    i = body.find(line)
    assert i > pos, line
    pos = i
assert 'return label === "genesis" && domain.split(".").length >= 3;' in src

out = []
w = out.append
w("-- ============================================================================")
w("-- seed-3x-rules.sql : 빌더 B(seed-30·40) 공용 판정 입력(세션 임시 표만). 생성: seed/gen_seed3x.py (손으로 옮겨 적지 않음)")
w("-- 원천(현행 hmg-geo 2670a16): ts-dump-b.json(dump-b.ts 를 tsx -e 로 평가) + lib/citation-categorizer/rules.ts 파싱")
w(f"--   rules.ts sha256 {sha(RULES)}")
w(f"--   seed.json sha256 {sha('lib/citation-categorizer/seed.json')}")
w(f"--   official-social.ts sha256 {sha('lib/citation-categorizer/official-social.ts')}")
w(f"--   geo-catalog/owned.ts sha256 {sha('lib/geo-catalog/owned.ts')}")
w("-- ============================================================================")
w("")
w("-- 공식 도메인 → 브랜드: GEO_OWNED_DOMAINS·ownedBrandOf lib/geo-catalog/owned.ts:120·128 (등록 가능 도메인, EXCLUDED 반영 후)")
w("-- ord = GEO_OWNED_DOMAINS 배열 순서(ownedBrandOf 는 첫 일치를 돌려준다)")
w("DROP TABLE IF EXISTS _r_owned_domain; CREATE TEMP TABLE _r_owned_domain (ord int PRIMARY KEY, domain text NOT NULL UNIQUE, brand_code text NOT NULL);")
w("INSERT INTO _r_owned_domain VALUES")
w(",\n".join(f"  ({i}, {q(dm)}, {q(b)})" for i, (dm, b) in enumerate(d["owned_domains"], 1)) + ";")
w("")
w("-- 공유 글로벌 호스트: SHARED_GLOBAL_HOSTS lib/geo-catalog/owned.ts:173 (사이트 루트 홈 규칙 제외 대상)")
w("DROP TABLE IF EXISTS _r_shared_host; CREATE TEMP TABLE _r_shared_host (host text PRIMARY KEY);")
w("INSERT INTO _r_shared_host VALUES " + ", ".join(f"({q(h)})" for h in d["shared_hosts"]) + ";")
w("")
w("-- ISO → 대륙 권역: geoLocateByCode lib/geo-catalog/index.ts:121 (CODE_TO_LOCATION :113, 'Global' 권역 제외)")
w("DROP TABLE IF EXISTS _r_iso_region; CREATE TEMP TABLE _r_iso_region (iso text PRIMARY KEY, region text NOT NULL);")
w("INSERT INTO _r_iso_region VALUES")
w(",\n".join(f"  ({q(i)}, {q(r)})" for i, r in d["iso_region"]) + ";")
w("")
w("-- 웹사이트 가상 지역 코드: WEBSITE_BRAND_GEO_CODES lib/scope/website-virtual-geo.ts:23")
w("DROP TABLE IF EXISTS _r_virtual_geo; CREATE TEMP TABLE _r_virtual_geo (code text PRIMARY KEY, brand_code text NOT NULL);")
w("INSERT INTO _r_virtual_geo VALUES " + ", ".join(f"({q(c)}, {q(b)})" for c, b in d["virtual_geo"]) + ";")
w("")
w("-- 공식 HMG 소셜 계정: OFFICIAL_SOCIAL_ACCOUNTS lib/citation-categorizer/official-social.ts:72 (매처 순서 보존)")
w("DROP TABLE IF EXISTS _r_social; CREATE TEMP TABLE _r_social (acc_ord int, m_ord int, skey text, domain text, prefix text, boundary bool, PRIMARY KEY (acc_ord, m_ord));")
rows = []
for ai, a in enumerate(d["social"], 1):
    for mi, mt in enumerate(a["matchers"], 1):
        rows.append(f"  ({ai}, {mi}, {q(a['key'])}, {q(a['domain'])}, {q(mt['prefix'])}, {q(bool(mt['boundary']))})")
w("INSERT INTO _r_social VALUES\n" + ",\n".join(rows) + ";")
w("")
w("-- 큐레이션 시드: lib/citation-categorizer/seed.json (index.ts:47 과 같이 택소노미 밖 값 제외, 소문자)")
w("DROP TABLE IF EXISTS _r_cat_seed; CREATE TEMP TABLE _r_cat_seed (domain text PRIMARY KEY, category text NOT NULL);")
w("INSERT INTO _r_cat_seed VALUES")
seen = set()
srows = []
for dm, c in d["seed"]:
    if dm in seen:
        continue  # Map 은 마지막 값이 이기지만 JSON 객체 키는 유일하므로 발생하지 않는다
    seen.add(dm)
    srows.append(f"  ({q(dm)}, {q(c)})")
w(",\n".join(srows) + ";")
w("")
w(f"-- 규칙 Set: {RULES} (ruleCategory :182 가 쓰는 11개)")
w("DROP TABLE IF EXISTS _r_set; CREATE TEMP TABLE _r_set (name text, v text, PRIMARY KEY (name, v));")
srows = [f"  ({q(s)}, {q(v)})" for s in NEED_SETS for v in dict.fromkeys(sets[s])]
w("INSERT INTO _r_set VALUES\n" + ",\n".join(srows) + ";")
w("")
w(f"-- 규칙 정규식(JS 리터럴 그대로, PG ARE 호환 확인됨): {RULES}")
w("DROP TABLE IF EXISTS _r_rx; CREATE TEMP TABLE _r_rx (name text PRIMARY KEY, rx text NOT NULL);")
w("INSERT INTO _r_rx VALUES\n" + ",\n".join(f"  ({q(k)}, {q(v)})" for k, v in rx.items()) + ";")
w("")
print("\n".join(out))
