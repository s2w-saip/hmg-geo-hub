#!/usr/bin/env python3
"""seed-10-app.sql 생성기.

입력
  - TS 상수 덤프(ts-dump.json): 현행 코드를 tsx 로 import 해 뽑은 값(owned base·비경쟁·별칭·접두 등).
    코드 유래 키 owned·root_home·shared_hosts·hidden_regions 는 dump-owned.ts 로 다시 뽑아 병합한다(동기화 S1 = hmg-geo 2670a16).
  - 현행 코드 파일 직접 파싱: competitor-brand.ts TOKEN_TO_BRAND, rhq-map.json, hidden-regions.ts(덤프와 같은지 단언).
  - 파일 지문: public-suffix data.ts, official-social.ts, seed.json·rules.ts·taxonomy.ts, (rhq-map.json 은 참고용).
출력
  - seed-10-app.sql (재실행 가능, 트랜잭션 1개, ON_ERROR_STOP 전제)
사용: HMG_GEO_REPO=<hmg-geo 2670a16 체크아웃> python3 gen_seed10.py ts-dump.json > seed-10-app.sql
  HMG_GEO_REPO 가 없으면 이 리포 front/(동기화 S1 벤더 병합 뒤 = hmg-geo 2670a16 트리, 위 입력 파일은 hub 가 고치지 않았다)를 읽는다.
"""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

REPO = os.environ.get("HMG_GEO_REPO") or str(Path(__file__).resolve().parents[3] / "front")
SYS_USER = "5eed0000-0000-4000-8000-000000000001"


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

# ── TOKEN_TO_BRAND (competitor-brand.ts:8-24) 파싱 ─────────────────────────────
src = open(f"{REPO}/lib/citation-categorizer/competitor-brand.ts", encoding="utf8").read()
block = src[src.index("const TOKEN_TO_BRAND"):src.index("};", src.index("const TOKEN_TO_BRAND"))]
tokens = re.findall(r'(?:"([^"]+)"|([a-z0-9]+))\s*:\s*"([^"]+)"', block)
tokens = [((a or b), c) for a, b, c in tokens]
assert len(tokens) == len({t for t, _ in tokens}) and len(tokens) > 60, len(tokens)
amb = re.search(r"AMBIGUOUS_PREFIX = new Set\(\[([^\]]+)\]\)", src).group(1)
amb = re.findall(r'"([^"]+)"', amb)

# ── RHQ (lib/rhq/_data/rhq-map.json) ──────────────────────────────────────────
rhq = json.load(open(f"{REPO}/lib/rhq/_data/rhq-map.json", encoding="utf8"))

# ── 택소노미 (lib/citation-categorizer/taxonomy.ts:10·59) ──────────────────────
CATS = [
    ("Official (HMG)", "officialHmg"), ("Official (Competitor)", "officialCompetitor"),
    ("Dealer & Marketplace", "dealerMarketplace"), ("Automotive Media", "automotiveMedia"),
    ("News & Media", "newsMedia"), ("Community & Forums", "communityForums"),
    ("Social & Video", "socialVideo"), ("Blogs & Reviews", "blogsReviews"),
    ("Wiki & Reference", "wikiReference"), ("Government & Public", "governmentPublic"),
    ("Award & Certification", "awardCertification"), ("Academic & Research", "academicResearch"),
    ("Other", "other"),
]
tax_src = open(f"{REPO}/lib/citation-categorizer/taxonomy.ts", encoding="utf8").read()
for name, slug in CATS:  # 코드와 드리프트 방지
    assert f'"{name}"' in tax_src and f"{slug}" in tax_src, name

BRANDS_OWNED = {e["brand"] for e in d["owned"]} | {e["brand"] for e in d["root_home"]}
assert BRANDS_OWNED <= {"Hyundai", "Kia", "Genesis"}, BRANDS_OWNED

fp_files = {
    "psl": sha("lib/public-suffix/data.ts"),
    "social": sha("lib/citation-categorizer/official-social.ts"),
    "category_seed": hashlib.sha256(
        (sha("lib/citation-categorizer/seed.json") + sha("lib/citation-categorizer/rules.ts")
         + sha("lib/citation-categorizer/taxonomy.ts")).encode()).hexdigest(),
}

L = []
w = L.append
w("-- ============================================================================")
w("-- seed-10-app.sql : mig_src(현행 미러 원본 스테이지) → app.* 이관 + 판정 규칙 정본 시드")
w("-- 생성: seed/gen_seed10.py (현행 코드 hmg-geo 2670a16 상수를 tsx 로 import 해 덤프, 손으로 옮겨 적지 않음. 동기화 S1: 7639b9e 덤프의")
w("--   코드 유래 키 owned·root_home·shared_hosts·hidden_regions 를 dump-owned.ts 로 2670a16 에서 다시 뽑았고, 나머지 키의 원천 파일은 두 커밋에서 같다)")
w("-- 재실행 가능: 트랜잭션 1개. 데이터 표는 TRUNCATE 후 INSERT…SELECT, rd 가 FK 로 참조하는 규칙 표")
w("--   (app.brand·app.citation_category·app.owned_base)와 app.user_account 는 UPSERT(키 보존).")
w("-- 트리거 결정: app.prompt 의 prompt_catalog_change(AFTER INSERT) 는 이관 동안 끈다.")
w("--   이유: 시드는 사용자 편집이 아니다. 켜 두면 행마다 prompt_audit_log 'created' 합성 이력(이관한 실제 이력과 중복)과")
w("--   judgment_change('catalog') 요청이 수천 건 생겨 적재기가 이미 시드한 카탈로그를 전부 재판정하게 된다.")
w("--   그 밖의 트리거(app.project AFTER UPDATE, 감사 append-only)는 INSERT·TRUNCATE 에 반응하지 않으므로 그대로 둔다.")
w("--   행위자 GUC(app.actor_id = 시스템 사용자, app.actor_type = system)는 안전망으로 함께 건다.")
w("-- ============================================================================")
w("\\set ON_ERROR_STOP on")
w("SET client_min_messages = warning;")
w("SET TIME ZONE 'UTC';")
w("\\set VERBOSITY terse")
w("\\timing on")
w("\\ir seed-00-fn.sql")
w("BEGIN;")
w("SET LOCAL lock_timeout = '60s';")
w("SET LOCAL statement_timeout = 0;")
w(f"SET LOCAL app.actor_id = '{SYS_USER}';")
w("SET LOCAL app.actor_type = 'system';")
w("")
w("-- ── 0. 시스템 사용자(합성 1행) ────────────────────────────────────────────")
w("-- profiles 는 이관 대상이 아니다. FK 가 요구하는 자리(app.project.created_by 등)만 이 사용자로 채운다.")
w("-- FK 없는 uuid 열(prompt.created_by·updated_by, 감사 로그 actor_id 등)은 원본 값을 그대로 보존한다(추후 profiles 이관 시 연결).")
w("-- status 'suspended': 로그인 계정이 아니라 귀속 전용임을 표시. .invalid 도메인(RFC 2606)이라 실제 메일 소유자가 없다.")
w("INSERT INTO app.user_account (user_id, email, display_name, role, operator, scope_all, status)")
w(f"VALUES ('{SYS_USER}', 'system+mirror-seed@hmg-geo.invalid', '시스템(이관 시드)', 'admin', 'none', true, 'suspended')")
w("ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, role = EXCLUDED.role,")
w("  operator = EXCLUDED.operator, scope_all = EXCLUDED.scope_all, status = EXCLUDED.status;")
w("")
w("-- ── 1. rd 가 FK 로 참조하는 규칙 표: UPSERT(키 보존) ─────────────────────────")
w("-- 1-1. app.brand : HMG_BRANDS lib/scope/hmg-brands.ts:22, 합성 고정 UUID hmg-brands.ts:25-29,")
w("--      비트 = DB-v2.1.sql:12 (1 H, 2 K, 4 G, 8 HMG, 16 Hyundai N), 엄브렐러 HMG = lib/scope/brand-presence.ts:17,")
w("--      Hyundai N 사이트 = lib/scope/website-virtual-geo.ts:4·24(website_sites.brand='Hyundai N'), 부모 = Hyundai(DB-앱-도메인 설계).")
w("--      is_hmg_own = 당사 3사 + N (DB-앱-도메인.json app.brand 절). HMG 는 엄브렐러라 false.")
ci = d["canon_ids"]
brands = [
    ("Hyundai", 1, False, True, None, ci["Hyundai"], 1),
    ("Kia", 2, False, True, None, ci["Kia"], 2),
    ("Genesis", 4, False, True, None, ci["Genesis"], 3),
    ("HMG", 8, True, False, None, None, 4),
    ("Hyundai N", 16, False, True, "Hyundai", None, 5),
]
w("INSERT INTO app.brand (brand_code, brand_bit, is_umbrella, is_hmg_own, parent_brand_code, canonical_entity_id, sort_order) VALUES")
w(",\n".join(f"  ({q(b)}, {bit}, {q(u)}, {q(o)}, {q(p)}, {q(c)}{'::uuid' if c else ''}, {s})" for b, bit, u, o, p, c, s in brands))
w("ON CONFLICT (brand_code) DO UPDATE SET brand_bit = EXCLUDED.brand_bit, is_umbrella = EXCLUDED.is_umbrella, is_hmg_own = EXCLUDED.is_hmg_own,")
w("  parent_brand_code = EXCLUDED.parent_brand_code, canonical_entity_id = EXCLUDED.canonical_entity_id, sort_order = EXCLUDED.sort_order;")
w("DELETE FROM app.brand WHERE brand_code NOT IN (" + ", ".join(q(b[0]) for b in brands) + ");")
w("")
w("-- 1-2. app.citation_category : CITATION_CATEGORIES lib/citation-categorizer/taxonomy.ts:10, 슬러그 :59. 키 = 코드 배열 순번(1..13).")
w("INSERT INTO app.citation_category (category_key, name, slug, ord) VALUES")
w(",\n".join(f"  ({i}, {q(n)}, {q(s)}, {i})" for i, (n, s) in enumerate(CATS, 1)))
w("ON CONFLICT (category_key) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, ord = EXCLUDED.ord;")
w(f"DELETE FROM app.citation_category WHERE category_key > {len(CATS)};")
w("")
w("-- 1-3. app.owned_base : GEO_OWNED_BASES lib/geo-catalog/owned.ts:227 (EXCLUDED_OWNED_DOMAINS :42, OWNED_BASE_URL_FIXES :83,")
w("--      ownedBasePrefixFromUrl :157 적용 후 값), 170행 = kind 'base'. OWNED_BASE_URL_FIXES 7건 중 5건(kia.com/au·it·tr·my, hyundai.com/cz)은")
w("--      2670a16(#313)에서 국가 경로로 줄었다(동기화 S1 BE-3). 옛 접두 행이 있는 DB 에서 이 시드를 다시 돌리면 새 키 + 옛 행 DELETE 가 되어")
w("--      rd.dim_url.owner_key FK 에 막힌다 → 이미 적재된 DB 는 back/migration/fix-sync-s1-rules.sql(제자리 UPDATE, 키 보존)을 먼저 돌린다.")
w("--      kind 'root_home' = 사이트 루트 홈 규칙(isSiteRootHome :181, SHARED_GLOBAL_HOSTS :173 제외): 공유 글로벌 호스트가 아닌")
w("--      호스트마다 1행, prefix = 호스트, 귀속 브랜드·국가·언어 = ownedBaseEntryForUrl('https://'+host) 결과(같은 호스트의 가장 짧은 base, :244-247).")
w("--      geo_code = geoCountryCode(e.country)(lib/geo-catalog/index.ts), 카탈로그에 ISO 가 없으면 NULL.")
w("--      owner_key: 기존 (kind, prefix) 행은 키 보존, 새 행만 max+1 부터(rd.dim_url.owner_key FK 보호). 0 은 '없음' 예약이라 쓰지 않는다.")
rows_ob = []
for i, e in enumerate(d["owned"]):
    rows_ob.append(("base", e["prefix"], e["host"], e["brand"], e["iso"], e["language"], i))
for j, e in enumerate(d["root_home"]):
    rows_ob.append(("root_home", e["host"], e["host"], e["brand"], e["iso"], e["language"], len(d["owned"]) + j))
w("CREATE TEMP TABLE _ob (kind text, prefix text, host text, brand_code text, geo_code text, language text, ord int) ON COMMIT DROP;")
w("INSERT INTO _ob VALUES")
w(",\n".join(f"  ({q(k)}, {q(p)}, {q(h)}, {q(b)}, {q(g)}, {q(l)}, {o})" for k, p, h, b, g, l, o in rows_ob) + ";")
w("WITH mx AS (SELECT coalesce(max(owner_key), 0) AS m FROM app.owned_base),")
w("     src AS (SELECT s.*, o.owner_key AS old_key FROM _ob s LEFT JOIN app.owned_base o ON o.kind = s.kind AND o.prefix = s.prefix),")
w("     keyed AS (SELECT src.*, coalesce(old_key, (SELECT m FROM mx) + row_number() OVER (PARTITION BY old_key IS NULL ORDER BY ord)) AS k FROM src)")
w("INSERT INTO app.owned_base (owner_key, kind, prefix, host, brand_code, geo_code, language)")
w("SELECT k::int2, kind, prefix, host, brand_code, geo_code, language FROM keyed")
w("ON CONFLICT (owner_key) DO UPDATE SET host = EXCLUDED.host, brand_code = EXCLUDED.brand_code, geo_code = EXCLUDED.geo_code, language = EXCLUDED.language;")
w("DELETE FROM app.owned_base o WHERE NOT EXISTS (SELECT 1 FROM _ob s WHERE s.kind = o.kind AND s.prefix = o.prefix);")
w("")
w("-- ── 2. 데이터·규칙 표 비우기(재실행) ───────────────────────────────────────")
w("-- app.qa_*·app.judgment_change·app.scope_outbox·app.access_audit_log·app.permission_audit_log·app.kw_prompt_draft 는")
w("-- 이 시드의 대상이 아니므로 건드리지 않는다. app.project_member·app.ctx_generated_prompt 는 app.project 를 FK 로 참조해")
w("-- TRUNCATE 목록에 함께 넣지만 채우지 않는다(원천 없음·user_account 부재).")
trunc = ["app.prompt_custom_field_value", "app.prompt_audit_log", "app.member_audit_log",
         "app.project_tracked_brand", "app.project_tracked_competitor", "app.project_tracked_vehicle",
         "app.project_tracked_keyword", "app.project_owned_base", "app.project_tracked_url",
         "app.project_engine_history", "app.project_custom_field", "app.prompt", "app.prompt_candidate",
         "app.project_member", "app.project", "app.website_prompt", "app.website_site", "app.standard_keyword",
         "app.standard_source", "app.ga4_tracked_event", "app.ga4_market_pending", "app.ga4_property", "app.report_site_engine_fact",
         "app.report_site_fact", "app.report_publication", "app.citation_domain_override", "app.entity_registry",
         "app.entity_alias", "app.hidden_market",
         "app.brand_name_prefix", "app.brand_display_alias", "app.non_competitor_name",
         "app.competitor_domain_token", "app.rule_param", "app.ctx_generated_prompt"]
w("TRUNCATE " + ", ".join(trunc) + " RESTART IDENTITY;")
w("ALTER TABLE app.prompt DISABLE TRIGGER prompt_catalog_change;")
w("")
w("-- ── 3. 판정 규칙 표(현행 코드 상수) ─────────────────────────────────────────")
w("-- 3-1. app.brand_name_prefix : HMG_BRAND_NAME_PREFIXES lib/scope/hmg-brands.ts:63. eval_order = 전역 평가 순서")
w("--      (객체 키 순서 Genesis → Hyundai → Kia, 브랜드 안에서는 배열 순서. hmgBrandPrefixEntries :72).")
pre = []
n = 0
for brand, _eid, prefs in d["prefix"]:
    for p in prefs:
        n += 1
        pre.append((brand, p, n))
w("INSERT INTO app.brand_name_prefix (brand_code, prefix, eval_order) VALUES")
w(",\n".join(f"  ({q(b)}, {q(p)}, {o})" for b, p, o in pre) + ";")
w("")
w("-- 3-2. app.brand_display_alias : BRAND_DISPLAY_ALIAS_ENTRIES lib/scope/brand-display-aliases.ts:77")
w("--      = HMG_BRAND_NAME_ALIASES(hmg-brands.ts:117) + COMPETITOR_DISPLAY_ALIASES(brand-display-aliases.ts:14).")
aliases = d["alias"]
assert len(aliases) == len({a for a, _ in aliases})
w("INSERT INTO app.brand_display_alias (alias, canonical_name) VALUES")
w(",\n".join(f"  ({q(a)}, {q(c)})" for a, c in aliases) + ";")
w("")
w("-- 3-3. app.non_competitor_name : NON_COMPETITOR_BRANDS lib/scope/non-competitor-brands.ts:213 (소문자, Set 중복 제거 후 158개).")
w("--      bare_only_pattern = BARE_ONLY_NON_COMPETITOR_PATTERNS :275 의 POSIX 패턴(선행 트림 클래스 POSIX_LEADING_TRIM 포함).")
bare = {n_: p for n_, p in d["bare_only"]}
nc = sorted(set(d["non_competitor"]))
assert all(x == x.lower() for x in nc)
assert set(bare) <= set(nc)
w("INSERT INTO app.non_competitor_name (name, bare_only_pattern) VALUES")
w(",\n".join(f"  ({q(x)}, {q(bare.get(x))})" for x in nc) + ";")
w("")
w("-- 3-4. app.competitor_domain_token : TOKEN_TO_BRAND lib/citation-categorizer/competitor-brand.ts:8-24.")
w("--      접두 매칭 제외 규칙(2자 이하·AMBIGUOUS_PREFIX :26 은 정확 일치만)은 표에 열이 없어 rule_param 'competitor_token_exact_only' 로 둔다.")
w("INSERT INTO app.competitor_domain_token (token, brand_name) VALUES")
w(",\n".join(f"  ({q(t)}, {q(b)})" for t, b in tokens) + ";")
w("")
w("-- 3-5. app.entity_alias : HMG_BRAND_ALIAS_ENTITY_IDS lib/scope/hmg-brands.ts:35 (표기 변형 id → 정본 id :25)")
ea = []
for brand, ids in d["alias_ids"].items():
    for a in ids:
        ea.append((a, ci[brand]))
w("INSERT INTO app.entity_alias (alias_entity_id, canon_entity_id) VALUES")
w(",\n".join(f"  ({q(a)}::uuid, {q(c)}::uuid)" for a, c in ea) + ";")
w("")
w("-- 3-6. app.rhq_region·rhq_region_country : lib/rhq/_data/rhq-map.json (lib/rhq/index.ts:13). label = labels.ko.")
rr, rc = [], []
for brand, b in rhq.items():
    for r in b["regions"]:
        rr.append((r["id"], brand, r["labels"]["ko"]))
        for c in r["countries"]:
            rc.append((r["id"], c.upper()))
w("--      재적재 = UPSERT + 원천에서 사라진 행만 DELETE(TRUNCATE 금지: DB-v2.4 rhq 가드가 계정 참조 권역·국가의 삭제·TRUNCATE 를 막는다).")
w("CREATE TEMP TABLE _rr (region_id text, brand_code text, label text) ON COMMIT DROP;")
w("INSERT INTO _rr VALUES")
w(",\n".join(f"  ({q(i)}, {q(b)}, {q(l)})" for i, b, l in rr) + ";")
w("CREATE TEMP TABLE _rc (region_id text, country_code text) ON COMMIT DROP;")
w("INSERT INTO _rc VALUES")
w(",\n".join(f"  ({q(i)}, {q(c)})" for i, c in rc) + ";")
w("DELETE FROM app.rhq_region_country c WHERE NOT EXISTS (SELECT 1 FROM _rc s WHERE s.region_id = c.region_id AND s.country_code = c.country_code);")
w("DELETE FROM app.rhq_region r WHERE NOT EXISTS (SELECT 1 FROM _rr s WHERE s.region_id = r.region_id);")
w("INSERT INTO app.rhq_region (region_id, brand_code, label) SELECT region_id, brand_code, label FROM _rr")
w("ON CONFLICT (region_id) DO UPDATE SET brand_code = EXCLUDED.brand_code, label = EXCLUDED.label")
w(" WHERE (app.rhq_region.brand_code, app.rhq_region.label) IS DISTINCT FROM (EXCLUDED.brand_code, EXCLUDED.label);")
w("INSERT INTO app.rhq_region_country (region_id, country_code) SELECT region_id, country_code FROM _rc ON CONFLICT DO NOTHING;")
w("")
hidden = d["hidden_regions"]
hsrc = open(f"{REPO}/lib/scope/hidden-regions.ts", encoding="utf8").read()
hm = re.search(r"HIDDEN_STANDARD_REGIONS: readonly string\[\] = \[(.*?)\];", hsrc, re.S)
assert hm is not None and re.findall(r'"([^"]+)"', hm.group(1)) == hidden, ("덤프와 HMG_GEO_REPO 의 숨김 국가가 다르다", hidden)
w("-- 3-7. app.hidden_market : HIDDEN_STANDARD_REGIONS lib/scope/hidden-regions.ts:31 (표준=글로벌 표면만). hmg-geo 2670a16(#302)이 ID 숨김을")
w("--      해제해 빈 배열이다(동기화 S1 BE-2). 배열이 비면 행이 없다(위 TRUNCATE 로 비운 채 둔다).")
if hidden:
    w("INSERT INTO app.hidden_market (surface, country_code, reason) VALUES")
    w(",\n".join(f"  ('global', {q(c)}, 'HIDDEN_STANDARD_REGIONS lib/scope/hidden-regions.ts')" for c in hidden) + ";")
w("")
w("-- 3-8. app.rule_param")
w("--   default_engines        lib/scope/engines.ts:37 DEFAULT_AI_ENGINES (0077 hmg_anchor_default_engines 와 대조)")
w("--   analysis_publish_ratio 0.95  DB-v2.1.sql:64·337 (R08, G-05)")
w("--   view_delay_days        2     DB-v2.1.sql:64 시드 키 (현행 글로벌 VIEW_ANCHOR_DELAY lib/summary/generate/types.ts:34)")
w("--   view_delay_days_by_surface  현행 표면별 값: global 2 (types.ts:34), website 1 (types.ts:35), project 1 (0077 hmg_anchor_view_date ② :262)")
w("--   run_recheck_days       3     lib/db/repositories/scope-mirror.ts:201 RUN_RECHECK_WINDOW_DAYS")
w("--   analysis_recheck_days  7     DECISIONS.md G-05 (분석 재확인 창 7일)")
w("--   cycle_complete_quiet_hours 36 lib/db/repositories/summary-cycles.ts:1019 DEFAULT_COMPLETE_QUIET_HOURS (R01 완주 정온)")
w("--   competitor_token_exact_only  lib/citation-categorizer/competitor-brand.ts:26·41 (2자 이하 토큰도 정확 일치만)")
params = [
    ("default_engines", json.dumps(["chatgpt", "gemini"])),
    ("analysis_publish_ratio", "0.95"),
    ("view_delay_days", "2"),
    ("view_delay_days_by_surface", json.dumps({"global": 2, "website": 1, "project": 1})),
    ("run_recheck_days", "3"),
    ("analysis_recheck_days", "7"),
    ("cycle_complete_quiet_hours", "36"),
    ("competitor_token_exact_only", json.dumps({"max_len_exact": 2, "tokens": amb})),
]
w("INSERT INTO app.rule_param (key, value) VALUES")
w(",\n".join(f"  ({q(k)}, {q(v)}::jsonb)" for k, v in params) + ";")
w("")
w(open(__file__.replace("gen_seed10.py", "seed-10-app.body.sql"), encoding="utf8").read())
w("")
w("-- ── 6. 규칙 세트 지문(13개). 같은 지문이 이미 있으면 그 rule_ver 를 재사용, 없으면 새 버전 ─────────")
w("--   파일 지문(sha256): psl = lib/public-suffix/data.ts, social = lib/citation-categorizer/official-social.ts,")
w("--   category_seed = sha256(seed.json ‖ rules.ts ‖ taxonomy.ts 각 sha256). 나머지는 표 내용 md5(갱신 시각·행위자 열 제외, C 정렬).")
w("CREATE TEMP TABLE _fp ON COMMIT DROP AS SELECT jsonb_build_object(")
w(f"  'psl', {q(fp_files['psl'])}, 'social', {q(fp_files['social'])}, 'category_seed', {q(fp_files['category_seed'])},")
w("  'owned_base', (SELECT md5(coalesce(string_agg(concat_ws('|', owner_key, kind, prefix, host, brand_code, geo_code, language), E'\\n' ORDER BY owner_key), '')) FROM app.owned_base),")
w("  'brand_prefix', (SELECT md5(coalesce(string_agg(concat_ws('|', brand_code, prefix, eval_order), E'\\n' ORDER BY eval_order), '')) FROM app.brand_name_prefix),")
w("  'brand_alias', (SELECT md5(coalesce(string_agg(concat_ws('|', alias, canonical_name), E'\\n' ORDER BY alias COLLATE \"C\"), '')) FROM app.brand_display_alias),")
w("  'non_competitor', (SELECT md5(coalesce(string_agg(concat_ws('|', name, bare_only_pattern), E'\\n' ORDER BY name COLLATE \"C\"), '')) FROM app.non_competitor_name),")
w("  'competitor_token', (SELECT md5(coalesce(string_agg(concat_ws('|', token, brand_name), E'\\n' ORDER BY token COLLATE \"C\"), '')) FROM app.competitor_domain_token),")
w("  'entity_registry', (SELECT md5(coalesce(string_agg(concat_ws('|', entity_id, name, role, brand_code), E'\\n' ORDER BY entity_id), '')) FROM app.entity_registry),")
w("  'entity_alias', (SELECT md5(coalesce(string_agg(concat_ws('|', alias_entity_id, canon_entity_id), E'\\n' ORDER BY alias_entity_id), '')) FROM app.entity_alias),")
w("  'hidden_market', (SELECT md5(coalesce(string_agg(concat_ws('|', surface, country_code), E'\\n' ORDER BY surface, country_code), '')) FROM app.hidden_market),")
w("  'rule_param', (SELECT md5(coalesce(string_agg(concat_ws('|', key, value::text), E'\\n' ORDER BY key COLLATE \"C\"), '')) FROM app.rule_param),")
w("  'website_catalog', (SELECT md5(coalesce((SELECT string_agg(concat_ws('|', site_id, brand_code, country_code, scope_project_id), E'\\n' ORDER BY site_id) FROM app.website_site), '')")
w("                        || coalesce((SELECT string_agg(concat_ws('|', website_prompt_id, site_id, file_seq, domain, lang_code, seq_no, target_url, owned_base_url, scope_prompt_id), E'\\n' ORDER BY website_prompt_id) FROM app.website_prompt), '')))")
w(") AS fp;")
w("INSERT INTO app.rule_set (fingerprints, note, created_by, applied_at)")
w(f"SELECT fp, 'mirror_seed: 현행 코드 hmg-geo 2670a16 상수 + mig_src 앱 표', '{SYS_USER}', now() FROM _fp")
w(" WHERE NOT EXISTS (SELECT 1 FROM app.rule_set r WHERE r.fingerprints = (SELECT fp FROM _fp));")
w("")
w("ALTER TABLE app.prompt ENABLE TRIGGER prompt_catalog_change;")
w("")
w("-- ── 7. 단언 ────────────────────────────────────────────────────────────────")
w("DO $a$ DECLARE v int; BEGIN")
w("  SELECT count(*) INTO v FROM app.brand;               IF v <> 5   THEN RAISE EXCEPTION 'app.brand %', v; END IF;")
w("  SELECT count(*) INTO v FROM app.citation_category;   IF v <> 13  THEN RAISE EXCEPTION 'app.citation_category %', v; END IF;")
w(f"  SELECT count(*) INTO v FROM app.owned_base;          IF v <> {len(rows_ob)} THEN RAISE EXCEPTION 'app.owned_base %', v; END IF;")
w(f"  SELECT count(*) INTO v FROM app.non_competitor_name; IF v <> {len(nc)} THEN RAISE EXCEPTION 'non_competitor %', v; END IF;")
w(f"  SELECT count(*) INTO v FROM app.hidden_market;       IF v <> {len(hidden)} THEN RAISE EXCEPTION 'app.hidden_market %', v; END IF;")
w("  SELECT count(*) INTO v FROM pg_trigger WHERE tgname = 'prompt_catalog_change' AND tgenabled = 'O';")
w("  IF v <> 1 THEN RAISE EXCEPTION 'prompt_catalog_change 트리거 재활성화 실패'; END IF;")
w("  SELECT count(*) INTO v FROM app.rule_set r, _fp WHERE r.fingerprints = _fp.fp; IF v <> 1 THEN RAISE EXCEPTION 'rule_set 지문 %', v; END IF;")
w("END $a$;")
w("COMMIT;")
w("")
w("-- 결과 요약(트랜잭션 밖, 읽기)")
w("SELECT 'rule_ver' AS k, max(rule_ver)::text AS v FROM app.rule_set")
w("UNION ALL SELECT 'rule_set_rows', count(*)::text FROM app.rule_set;")
print("\n".join(L))
