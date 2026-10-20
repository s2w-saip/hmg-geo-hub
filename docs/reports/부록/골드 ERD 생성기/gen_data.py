"""골드 ERD v8 대응 데이터 생성: FEATURES(화면 항목 789) · COLMAP(현행 열 → 골드 열) · BEMODS(BE 모듈 → 현행 객체).
입력: inventory.json, item_routes.json, be_scan.json, db_cols.tsv, manual_map.py. 출력: coverage_data.js"""
import collections, json, os, re, sys
S = os.path.dirname(os.path.abspath(__file__))
BE_APP = sys.argv[1]  # back/app
sys.path.insert(0, S)
from manual_map import MANUAL, TECH  # noqa: E402

inv = json.load(open(os.path.join(S, 'inventory.json'), encoding='utf-8'))
ir = json.load(open(os.path.join(S, 'item_routes.json'), encoding='utf-8'))
be = json.load(open(os.path.join(S, 'be_scan.json'), encoding='utf-8'))
db = collections.defaultdict(list)
for line in open(os.path.join(S, 'db_cols.tsv'), encoding='utf-8'):
    sch, rel, kind, col, typ = line.rstrip('\n').split('\t')
    db[f'{sch}.{rel}'].append((col, typ, kind))

# ── 현행 객체 → 골드 ─────────────────────────────────────────────
SAME = lambda t: (t, {})  # noqa: E731
OBJ = {
    'rd.answer': ('answer_fact', {'load_id': 'build_id'}),
    'rd.answer_brand': SAME('answer_brand_fact'), 'rd.answer_stance': SAME('answer_stance_fact'), 'rd.citation': SAME('citation_fact'),
    'rd.job': ('job_index', {'load_id': 'last_build_id'}),
    'rd.cycle': SAME('dim_cycle'), 'rd.cycle_pick_basis': SAME('cycle_pick_basis'),
    'rd.surface_generation': ('active_release', {'surface': 'scope', 'generation': 'version', 'last_load_id': 'last_build_id'}),
    'rd.catalog_entry': ('catalog_entry', {'load_id': 'build_id'}),
    'rd.dim_brand_name': SAME('dim_brand'), 'rd.dim_country': SAME('dim_country'), 'rd.dim_engine': SAME('dim_engine'),
    'rd.dim_entity': SAME('dim_entity'), 'rd.dim_lang': SAME('dim_lang'), 'rd.dim_project': SAME('dim_project'), 'rd.dim_prompt': SAME('dim_prompt'),
    'rd.dim_region': SAME('dim_region'), 'rd.dim_source': SAME('dim_source'), 'rd.dim_taxon': SAME('dim_taxon'), 'rd.dim_url': SAME('dim_url'),
    'rd.entity_mention_total': SAME('entity_mention_total'),
    'rd.ga4_dim_property': SAME('ga4_property'), 'rd.ga4_dim_value': SAME('ga4_value'), 'rd.ga4_row': SAME('ga4_row'),
    'rd.dim_keyword': SAME('dim_keyword'), 'rd.kw_serp': SAME('kw_serp'), 'rd.kw_suggestion': SAME('kw_suggestion'), 'rd.kw_volume_monthly': SAME('kw_volume_monthly'),
    'rd.acr_cell': SAME('acr_cell_fact'), 'rd.acr_choice': SAME('acr_entity_fact'), 'rd.acr_cell_job': SAME('acr_cell_job'),
    'rd.report_unit_value': ('report_value', {'load_id': 'build_id'}),
    'rd.web_report_prompt': SAME('web_report_prompt'), 'rd.web_target_url': SAME('web_target_url'), 'rd.web_unit': SAME('web_unit'),
    'rd.v_answer_body': SAME('answer_body'), 'rd.v_answer_mention_raw': SAME('answer_mention_raw'), 'rd.v_answer_occurrence': SAME('answer_occurrence'),
    'rd.v_answer_stance_raw': SAME('answer_stance_raw'), 'rd.v_answer_citation_raw': SAME('answer_citation_raw'), 'rd.v_answer_registry': SAME('answer_registry'),
    'rd.v_acr_cell_run': SAME('acr_cell_run'), 'rd.v_entity_mention_surface': SAME('entity_mention_surface'),
    'frz.generation': SAME('publication'), 'frz.prompt': SAME('pub_prompt'),
    'ext.ctx_snapshot': SAME('ctx_snapshot'), 'ext.ctx_entity': SAME('ctx_entity'), 'ext.ctx_drive': SAME('ctx_drive'),
    'ext.ctx_combination': SAME('ctx_combination'), 'ext.ctx_domain': SAME('ctx_domain'), 'ext.ctx_evidence': SAME('ctx_evidence'),
}
# 동결 읽기 뷰: 활성 발행(publication.state='active') 경로로 같은 열을 읽는다
PATH = {
    'frz.card_axis': ('pub_prompt_axis', '활성 발행의 pub_prompt_axis'),
    'frz.card_brand_name': ('pub_brand_name', '활성 발행의 pub_brand_name'),
    'frz.card_web': ('pub_cell_web', '활성 발행의 pub_cell_web'),
}
FACT_VIEW = {  # 뷰 → (사실 테이블, 설명). 현행 frz 카드 · 격자 뷰(DB-v2.23 P124 · P125, v2.24 P126 · P127, v2.32 P153 · P154)의 골드 경로
    'frz.card_answer': ('answer_fact', '카드: pub_cell ⋈ pub_prompt(in_full_cycle) ⋈ answer_fact @ publication.build_id, 글로벌 bgrp = pub_prompt.cat_mask'),
    'frz.card_answer_w': ('answer_fact', '웹 카드: pub_cell ⋈ pub_cell_web ⋈ answer_fact @ publication.build_id (프롬프트 축 조인 없음)'),
    'frz.grid_answer': ('answer_fact', '격자: pub_cell ⋈ pub_prompt ⋈ answer_fact @ publication.build_id, 글로벌 bgrp = pub_prompt.cat_mask'),
    'frz.card_answer_brand': ('answer_brand_fact', '카드: pub_cell ⋈ pub_prompt(in_full_cycle) ⋈ answer_brand_fact @ publication.build_id, 글로벌 bgrp = pub_prompt.cat_mask'),
    'frz.card_answer_brand_w': ('answer_brand_fact', '웹 카드: pub_cell ⋈ pub_cell_web ⋈ answer_brand_fact @ publication.build_id (프롬프트 축 조인 없음)'),
    'frz.grid_answer_brand': ('answer_brand_fact', '격자: pub_cell ⋈ pub_prompt ⋈ answer_brand_fact @ publication.build_id, 글로벌 bgrp = pub_prompt.cat_mask'),
    'frz.card_citation': ('citation_fact', '카드: pub_cell ⋈ pub_prompt(in_full_cycle) ⋈ citation_fact @ publication.build_id, 글로벌 bgrp = pub_prompt.cat_mask'),
    'frz.card_citation_w': ('citation_fact', '웹 카드: pub_cell ⋈ pub_cell_web ⋈ citation_fact @ publication.build_id (프롬프트 축 조인 없음)'),
    'frz.grid_citation': ('citation_fact', '격자: pub_cell ⋈ pub_prompt ⋈ citation_fact @ publication.build_id, 글로벌 bgrp = pub_prompt.cat_mask'),
}
WEBCOLS = {'unit_owned', 'unit_target', 'url_registered', 'url_owned_hit', 'url_target_hit'}
FUNCS = {'rd.today_kst': 'BE 가 KST 오늘 날짜를 직접 계산 (데이터 아님)'}

# ── BE 모듈 → 현행 객체 ───────────────────────────────────────────
mods = {k: [x for x in v if not x.startswith('?')] for k, v in be['mods'].items()}
imports = be['imports']
CORE_GROUPS = {  # 공통 경로 묶음 (모듈이 직접 import 하면 그 묶음의 객체를 함께 읽는다. 검증은 core 전체를 COLMAP 으로 덮는다)
    '공통 · 권한·코드': ['core/auth', 'core/codes'],
    '공통 · 필터·기간': ['core/filters', 'core/cycles'],
    '공통 · 지표 빌더·동결 읽기': ['core/measure', 'core/facts', 'core/profile', 'core/urls'],
    '공통 · 엔티티·키워드': ['core/entities', 'core/kw'],
}


def closure(mod):
    seen, stack = set(), list(imports.get(mod, []))
    while stack:
        m = stack.pop()
        if m in seen:
            continue
        seen.add(m)
        stack += imports.get(m, [])
    return seen


def nonapp(objs):
    return sorted(o for o in objs if not o.startswith('app.'))


BEMODS = {}
for m, objs in mods.items():
    direct_imp = set(imports.get(m, []))
    groups = [g for g, cms in CORE_GROUPS.items() if any(c in direct_imp for c in cms)]
    BEMODS[m] = {'direct': nonapp(objs), 'app': sorted(o[4:] for o in objs if o.startswith('app.') and o in db), 'groups': groups}
GROUP_OBJS = {g: sorted({o for c in cms for o in nonapp(mods.get(c, []))}) for g, cms in CORE_GROUPS.items()}

# 모든 BE 읽기 객체
READ_OBJS = sorted({o for v in BEMODS.values() for o in v['direct']} | {o for v in GROUP_OBJS.values() for o in v})

# ── COLMAP ────────────────────────────────────────────────────────
COLMAP = []
unmapped_obj = []
for o in READ_OBJS:
    if o in FUNCS:
        COLMAP.append({'o': o, 'c': '()', 't': None, 'h': 'func', 'n': FUNCS[o]})
        continue
    cols = [c for c, t, k in db.get(o, [])]
    if not cols:
        unmapped_obj.append(o)
        continue
    if o in OBJ:
        tgt, ren = OBJ[o]
        for c in cols:
            if c in ren:
                COLMAP.append({'o': o, 'c': c, 't': f'{tgt}.{ren[c]}', 'h': 'rename'})
            else:
                COLMAP.append({'o': o, 'c': c, 't': f'{tgt}.{c}', 'h': 'same'})
    elif o in PATH:
        tgt, note = PATH[o]
        for c in cols:
            t = f'publication.cyc_key' if c == 'cyc_key' and tgt == 'pub_brand_name' else f'{tgt}.{c}'
            COLMAP.append({'o': o, 'c': c, 't': t, 'h': 'path', 'n': note})
    elif o in FACT_VIEW:
        tgt, note = FACT_VIEW[o]
        for c in cols:
            if c == 'unit_in':
                COLMAP.append({'o': o, 'c': c, 't': 'pub_cell_web.report_fs', 'h': 'derived', 'n': 'report_fs IS NOT NULL ∧ report_fs ∉ app.website_report_excluded'})
            elif c in WEBCOLS:
                COLMAP.append({'o': o, 'c': c, 't': f'pub_cell_web.{c}', 'h': 'path', 'n': note})
            else:
                ren = OBJ.get('rd.' + tgt.replace('_fact', '').replace('answer_brand', 'answer_brand'), (None, {}))[1]
                cc = {'load_id': 'build_id'}.get(c, c) if tgt == 'answer_fact' else c
                COLMAP.append({'o': o, 'c': c, 't': f'{tgt}.{cc}', 'h': 'path', 'n': note})
    elif o == 'rd.rep_cit_delta':
        for c in cols:
            COLMAP.append({'o': o, 'c': c, 't': f'answer_fact.{c}', 'h': 'derived', 'n': '행 존재 = answer_fact.rep_cit_xor 참'})
    else:
        unmapped_obj.append(o)

# ── 쓰기 분석: 모듈별 app 쓰기 테이블 + judgment_change kind ───────
KINDS_BY_MOD = {
    'admin/citation_sources/overrides': ['citation_override'], 'admin/cycles/cycles': ['cycle_admin'], 'admin/cycles/jobs': ['anchor_pin', 'answer_drop'],
    'admin/entities/registry': ['entity'], 'admin/entities/versions': ['entity_version'], 'admin/integrations/ga4': ['ga4_property', 'ga4_tracked_event'],
    'admin/integrations/keyword_tools': ['dfs_fetch'], 'intent/keywords/fetches': ['dfs_fetch'], 'projects/settings/owned_bases': ['project_owned_base'],
    'projects/settings/tracked_targets': ['project_setting'], 'projects/settings/tracked_urls': ['project_target_url'],
}
TRIGGER_KINDS = {'prompt': ['catalog', 'prompt_kind'], 'project': ['project_setting']}
WRX = re.compile(r'\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+app\.([a-z0-9_]+)', re.I)
writes = collections.defaultdict(set)
for dp, dn, fn in os.walk(BE_APP):
    d = dp.replace(os.sep, '/')
    if '/tests' in d or '__pycache__' in d or '/features/' not in d + '/':
        continue
    rel = d[len(BE_APP.replace(os.sep, '/')) + 1:].split('/')
    if len(rel) < 4:
        continue
    mod = '/'.join(rel[1:4])
    for f in fn:
        if f.endswith('.py'):
            for t in WRX.findall(open(os.path.join(dp, f), encoding='utf-8').read()):
                writes[mod].add(t)
for m in BEMODS:
    w = sorted(t for t in writes.get(m, set()) if f'app.{t}' in db)
    BEMODS[m]['writes'] = w
    k = set(KINDS_BY_MOD.get(m, []))
    for t in w:
        k |= set(TRIGGER_KINDS.get(t, []))
    BEMODS[m]['kinds'] = sorted(k)

# ── FEATURES ──────────────────────────────────────────────────────
PROF = {'계산된 지표·건수·비교 값': '지표', '집계 표·차트·분포': '표·차트', '목록·이력·조회 결과': '목록', '본문·상세 내용': '상세',
        '조회한 필터·선택 옵션': '필터 옵션', '정적 업무 목록·기준값을 사용하는 선택 옵션': '고정 옵션', '기준일·상태·안내 표시': '상태 표시',
        '입력·검색·정렬·이동 등 화면 조작': '조작', '저장·삭제·실행 등 상태 변경': '쓰기', '저장 결과·진행·실패 표시': '쓰기 결과',
        '조회·미리보기 실행': '조회 실행', '파일·데이터 내보내기': '내보내기', '이미 받은 자료의 파일 내보내기': '내보내기(화면 자료)',
        '이미 받은 자료로 계산한 표시 값': '화면 계산', '샘플·로컬 자료 표시': '정적 표본', '화면 밖': '화면 밖'}
FEATURES, missing_manual = [], []
for rec in ir:
    key = (rec['route'].replace('/ko', '') if rec['route'] != '(화면 밖)' else '(화면 밖)', rec['label'])
    f = {'s': rec['menu'], 'r': rec['route'].replace('/ko', '') or '/', 'l': rec['label'], 'k': PROF.get(rec['profile'], rec['profile'])}
    if rec['hits']:
        ms = sorted({h[2] for h in rec['hits']})
        f['src'] = 'api'
        f['api'] = sorted({f'{h[0]} {h[1]}' for h in rec['hits']})
        f['m'] = ms
    man = MANUAL.get(key) or (TECH.get(rec['label']) if rec['route'] == '(화면 밖)' else None)
    if man:
        f.update(man)
        f.setdefault('src', 'manual')
    if 'src' not in f:
        missing_manual.append(key)
    FEATURES.append(f)

out = {'FEATURES': FEATURES, 'COLMAP': COLMAP, 'BEMODS': BEMODS, 'GROUP_OBJS': GROUP_OBJS, 'OBJMAP': {o: OBJ[o][0] for o in OBJ} | {o: PATH[o][0] for o in PATH} | {o: FACT_VIEW[o][0] for o in FACT_VIEW} | {'rd.rep_cit_delta': 'answer_fact'}}
js = '\n'.join(f'const {k} = {json.dumps(v, ensure_ascii=False, separators=(",", ":"))};' for k, v in out.items())
open(os.path.join(S, 'coverage_data.js'), 'w', encoding='utf-8').write(js + '\n')
print('FEATURES', len(FEATURES), 'COLMAP', len(COLMAP), 'BEMODS', len(BEMODS), 'READ_OBJS', len(READ_OBJS))
print('unmapped objects:', unmapped_obj)
print('items needing manual map:', len(missing_manual))
for k in missing_manual:
    print('  ', k)
