"""Reviewed applicability of each visible item; no model calls during builds.

The saved Choice proposals are evidence, not verdicts. Explicit reviewed profiles
determine which existing measurements may be shown. Missing/new items fail closed
so a split cannot silently inherit every check from its parent again.
"""
import json
from pathlib import Path


PROFILES = {
    'control': ('입력·검색·정렬·이동 등 화면 조작', set()),
    'metadata': ('기준일·상태·안내 표시', {'F6'}),
    'metric': ('계산된 지표·건수·비교 값', {'F2', 'F3', 'F4', 'F5', 'F6', 'F8', 'F10', 'DONE'}),
    'collection': ('집계 표·차트·분포', {'F2', 'F3', 'F4', 'F5', 'F6', 'F8', 'F9', 'F10', 'DONE'}),
    'records': ('목록·이력·조회 결과', {'F2', 'F4', 'F5', 'F6', 'F8', 'F9', 'F10', 'DONE'}),
    'record': ('본문·상세 내용', {'F2', 'F4', 'F5', 'F6', 'F9', 'F10', 'DONE'}),
    'derived': ('이미 받은 자료로 계산한 표시 값', {'F3', 'F4', 'F5', 'F8'}),
    # Selecting queried options has no business constant removal target of its
    # own. Fixed option catalogs have a separate, explicitly reviewed profile.
    'options': ('조회한 필터·선택 옵션', {'F2', 'F6', 'F8', 'F9', 'F10', 'DONE'}),
    'fixed_options': ('정적 업무 목록·기준값을 사용하는 선택 옵션', {'F2', 'F4', 'F6', 'F8', 'F9', 'F10', 'DONE'}),
    'mutation': ('저장·삭제·실행 등 상태 변경', {'F7', 'F10', 'DONE'}),
    'export': ('파일·데이터 내보내기', {'F7', 'F9', 'F10', 'DONE'}),
    'local_data': ('샘플·로컬 자료 표시', {'F3', 'F4', 'F5', 'F8'}),
    'local_export': ('이미 받은 자료의 파일 내보내기', {'F7'}),
    'query_action': ('조회·미리보기 실행', {'F6', 'F10', 'DONE'}),
    'write_feedback': ('저장 결과·진행·실패 표시', {'F7'}),
}

DATA = json.loads((Path(__file__).parent / '조사 데이터/visible_applicability.json').read_text(encoding='utf-8'))
ITEMS = {(item['route'], item['label']): item for item in DATA['items']}
if len(ITEMS) != len(DATA['items']):
    raise ValueError('Duplicate visible-item applicability entries')


def applicability(route, label, source_label):
    item = ITEMS[(route, label)]
    if item['source_label'] != source_label:
        raise ValueError(f'Applicability source changed: {route}: {label}')
    description, factors = PROFILES[item['profile']]
    # Explicit item-level exclusions take precedence over a broad profile.
    # Keep the profile's shared set intact for every other visible item.
    exclusions = item.get('factor_exclusions', {})
    if not isinstance(exclusions, dict) or set(exclusions) - factors:
        raise ValueError(f'Invalid factor exclusions: {route}: {label}')
    if any(not isinstance(reason, str) or not reason.strip() for reason in exclusions.values()):
        raise ValueError(f'Missing factor exclusion reason: {route}: {label}')
    return factors - set(exclusions), description


def validate_inventory(sources):
    if set(sources) != set(ITEMS):
        missing = set(sources) - set(ITEMS)
        stale = set(ITEMS) - set(sources)
        raise ValueError(f'Review applicability for changed inventory: missing={missing}, stale={stale}')


def has_explicit_hardcoding_target(route, label):
    """Only these reviewed profiles already identify static displayed data.

    Other split items require their own topic evidence; a parent's constants
    alone do not establish an F4 removal target on every child.
    """
    return ITEMS[(route, label)]['profile'] in {'local_data', 'fixed_options'}
