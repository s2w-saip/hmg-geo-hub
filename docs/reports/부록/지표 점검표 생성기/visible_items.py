"""User-visible checklist inventory, separate from the original measurement units.

Explicit, reviewed expansions only: punctuation is not a reliable UI boundary.
Apply after endpoint overrides so every child retains its source evidence.
Tables/charts remain one visual object; separate cards, controls, tabs, messages,
and actions get individual rows. Technical notes stay in the evidence tooltip.
"""
from copy import deepcopy
import json
from pathlib import Path

UI_MESSAGES = json.loads((Path(__file__).resolve().parents[4] / 'front/messages/ko.json').read_text(encoding='utf-8'))


def ui(path):
    """Use the same full Korean label as the UI; fail on renamed/missing keys."""
    value = UI_MESSAGES
    for key in path.split('.'):
        value = value[key]
    if not isinstance(value, str) or not value:
        raise ValueError(f'Expected a nonempty UI label: {path}')
    return value


def ui_names(namespace, keys):
    return [ui(f'{namespace}.{key}') for key in keys]


KPI = ui_names('dashboard.kpi.name', ['visibility', 'shareOfVoice', 'sentiment', 'position', 'citationShare'])
TARGET_CITATION = ui('dashboard.kpi.name.citationAccuracy')
MENTION = ui_names('answerAnalysis.mentions.summary', ['total', 'uniqueBrands', 'totalPrompts', 'missingPrompts', 'multiMention', 'top3Rate'])
CITATION = ui_names('answerAnalysis.citations.summary', ['total', 'uniqueDomains', 'categories', 'officialOwnShare', 'dealerShare'])
ACR = [f'{name} 카드' for name in ui_names('aiFunnelView.acr.kpi', ['top1', 'top5', 'answers', 'rank1'])]
QUADRANTS = [f'{name} 카드' for name in ui_names('aiFunnelView.visibility.quadrant', ['star', 'aiGap', 'seoGap', 'deadZone'])]
CONVERSION = [f'{name} 카드' for name in ui_names('aiFunnelView.conversion.kpi', ['ai', 'human', 'lift'])]
VISITS = [f'{ui("aiFunnelView.visits.title")} · {name} 카드' for name in ui_names('aiFunnelView.visits.kpi', ['visits', 'visitors', 'frequency'])] + [f'{ui("aiFunnelView.visits.table.title")} 표']
CONTEXT = ['구매 맥락 수', '구매 조건 수', '관계 수', '출처 도메인 수']
CONTEXT_TABLES = ['구매 맥락 표', '구매 조건 표', '조합 패턴 표']


def per_metric(metrics, *parts):
    return [f'{metric} · {part}' for metric in metrics for part in parts]


# Each key is a source route; each prefix must match exactly one original row.
# A list is a replacement inventory, not a claim of new independent measurements.
RULES = {
    '/ko/dashboard': {
        '기준일 표시': ['측정 기준일 표시', '필터 바'],
        'KPI 카드 5개': per_metric(KPI, 'KPI 카드'),
        '카드 증감': per_metric(KPI, '증감 표시', '스파크라인'),
        '카드 기간 비교': per_metric(KPI[:4], '기간 비교 칩'),
        '경쟁사 미니 행': per_metric(KPI[:4], '경쟁사 비교 행'),
        '카드 ⑤ 경쟁사 행': [f'{KPI[4]} · 경쟁사 비교 행'],
    },
    '/ko/standard/answer-analysis/mention': {
        '기준일 ·': ['측정 기준일 표시', '필터 바', '기간 비교 표시'],
        '히어로 · 추이': per_metric(KPI[:2], '대표 지표', '추이 차트'),
        '경쟁사 분석 표': [f'{ui("answerAnalysis.mentions.kpi.competitor.title").format(metric=name)} 표' for name in KPI[:2]],
        'AI 엔진별': [f'{name} · {ui("answerAnalysis.mentions.kpi.engine.title." + key)} 차트' for name, key in zip(KPI[:2], ['exposure', 'sov'])],
        '멘션 유형별': [f'{name} · {ui("answerAnalysis.mentions.kpi.type.title." + key)} 차트' for name, key in zip(KPI[:2], ['exposure', 'sov'])],
        '멘션 유형별 감정 분포': [f'{KPI[2]} · {ui("answerAnalysis.mentions.kpi.favorability.matrix.title")}'],
        '긍정·부정': [f'{KPI[2]} · {name}' for name in ui_names('answerAnalysis.mentions.kpi.favorability', ['positiveTitle', 'negativeTitle'])],
        '감정 분포 ·': [f'{KPI[2]} · {ui("answerAnalysis.mentions.kpi.favorability.dist.title")} 차트', f'{KPI[2]} · 신호 프롬프트 다이얼로그'],
        '히어로 · 순위': [f'{KPI[3]} · 대표 지표', f'{KPI[3]} · 순위 표시'],
    },
    '/ko/standard/answer-analysis/citation': {
        '기준일 ·': ['측정 기준일 표시', '필터 바', '전월 대비 표시'],
        '인용 현황 · 공식(HMG)': [f'{ui("answerAnalysis.citations.v2.status." + key)} {part}' for part in ['카드', '증감'] for key in ['officialOwn', 'dealer']],
        '인용 현황 · 공식 URL': [f'{name} · 건수' for name in ui_names('answerAnalysis.citations.v2.status', ['ownedPrompts', 'uncitedPrompts'])],
        '출처 카테고리별 현황': ['출처 카테고리별 인용 현황', '출처 카테고리 구성 추이 차트'],
        '답변 우호도별': [f'{name} · 건수' for name in ui_names('answerAnalysis.citations.v2.tone', ['positive', 'negative'])],
        '행 드릴다운': ['인용 URL 목록', '인용 프롬프트 목록', '답변 모달'],
    },
    '/ko/standard/ai-funnel/visibility': {
        '4분면 카드': QUADRANTS,
    },
    '/ko/standard/ai-funnel/acr': {
        '필터 바 ·': ['필터 바', '기간 달력'],
        'KPI 카드': ACR,
        '모델별 선택 구도': ['모델별 선택 구도 표', '모델별 선택 구도 더 보기 버튼'],
        '측정 규모 주석': ['측정 프롬프트 수 주석', '측정 셀 수 주석', '측정 반복 수 주석'],
    },
    '/ko/standard/ai-funnel/conversion': {
        '필터 바 ·': ['필터 바', '기간 선택'],
        '미연동 시장': ['미연동 시장 안내', '측정 대기 안내'],
        'AI 전환율 ·': CONVERSION,
        '전환율 ·': ['전환율 추이', '방문 수 추이'],
        'AI 모델(엔진)': ['ChatGPT 전환 카드', 'Gemini 전환 카드', f'{ui("aiFunnelView.conversion.engineBreakdown.lowSample")} 배지'],
        '측정 커버리지': ['측정 커버리지 표시', '국가별 전환 표'],
        'AI 유입 사이트': VISITS,
    },
    '/ko/standard/answer-analysis/citation/prompts': {
        '인용 프롬프트(N)': ['인용 프롬프트 탭 카운트', '미인용 프롬프트 탭 카운트'],
        '프롬프트 목록': ['프롬프트 검색창', '프롬프트 목록', '목록 페이지 이동'],
        '답변 모달': ['답변 모달 본문', '답변 모달 이전 답변 버튼', '답변 모달 다음 답변 버튼'],
    },
    '/ko/standard/answer-analysis/citation/tone-urls': {
        '긍정 답변': ['긍정 답변 인용 URL 탭 카운트', '부정 답변 인용 URL 탭 카운트'],
        '인용 URL/도메인': ['인용 URL 검색창', '도메인별 보기 스위치', '인용 URL 목록', '인용 도메인 목록', '목록 페이지 이동'],
    },
    '/ko/standard/prompts': {
        '수집 기간': ['수집 기간 표시', '마지막 수집일 표시'],
        '카탈로그 메타': ['전체 프롬프트 수', '열람 범위 칩', '카탈로그 필터 바', '표시 프롬프트 수'],
        '프롬프트 목록 ·': ['프롬프트 목록', '페이지당 행 수 선택', '목록 페이지 이동'],
        '변경 이력 표': ['변경 이력 표', '변경 이력 기간 선택', '변경 이력 이벤트 필터', '변경 이력 일괄 접기 버튼'],
    },
    '/ko/website': {
        '필터 바 ·': ['필터 바', '기간 달력'],
        'KPI 카드 ①': per_metric(KPI, 'KPI 카드') + ['경쟁사 SOV 비교'],
        '자사 URL': [f'{name} 카드' for name in ui_names('dashboard.kpi.name', ['ownedUrlRate', 'targetUrlRate'])],
        '⑥ AI': [f'{TARGET_CITATION} 카드'],
        '카드 증감': per_metric(KPI, '증감 표시', f'{ui("dashboard.kpi.sub.engineConsistency")} 배지'),
        '카드 기간 비교': per_metric(KPI[:4], '기간 비교 칩'),
        '시장별 경쟁': ['시장별 경쟁 위치 지도', '시장별 스냅샷'],
    },
    '/ko/website/prompts': {
        '필터 바 ·': ['필터 바', '기간 달력'],
        '프롬프트 표': ['프롬프트 표', '프롬프트 검색창', '프롬프트 정렬', '목록 페이지 이동'],
    },
    '/ko/website/answer-analysis/mention': {
        '필터 바 ·': ['필터 바', '측정 기준일 표시'],
        '전체 언급 수': per_metric(MENTION[:3], '요약 카드', '증감 표시'),
        'Sub KPI 카드': per_metric(MENTION[3:], '요약 카드', '증감 표시') + ['증감 비교 기준일'],
        '감정 분포 +': ['감정 분포 차트', '긍정 키워드 언급 수', '부정 키워드 언급 수'],
        '멘션 유형(': ['멘션 유형별 합계', '멘션 유형별 브랜드 점유 차트'],
        '브랜드 언급 순위(': ['브랜드 언급 순위표', '브랜드 검색창', '브랜드 순위 정렬'],
        '브랜드별 언급 프롬프트': ['브랜드별 언급 프롬프트 목록', '프롬프트별 답변 참조'],
        '답변 모달(': ['답변 모달 원문', '답변 모달 인용 표시', '답변 모달 언급 배지'],
    },
    '/ko/website/answer-analysis/citation': {
        '필터 바 ·': ['필터 바', '측정 기준일 표시'],
        '전체 인용 수': per_metric(CITATION, '요약 카드'),
        '자사 URL': [f'{name} 카드' for name in ui_names('answerAnalysis.citations.summary', ['ownedHitRate', 'targetHitRate'])],
        '자사 base': per_metric(ui_names('answerAnalysis.citations.baseSplit', ['ownedTitle', 'uncitedTitle']), '건수', '상위 목록'),
        '도메인 인용 순위(': ['도메인 인용 순위표', '도메인 검색창', '도메인 순위 정렬'],
        '인용 URL ·': ['인용 URL 목록', '인용 프롬프트 목록', '답변 모달'],
    },
    '/ko/website/ai-funnel/conversion': {
        '필터 바 ·': ['필터 바', '측정 기간 선택'],
        '시장·GA4': ['미연동 시장 안내', '측정 대기 안내'],
        '전환 KPI 3종': CONVERSION + ['전환율 추이', 'AI 엔진별 전환', '입구 페이지별 전환 표'],
        '가중 전환 KPI': [f'권역·본사 · {x}' for x in CONVERSION] + ['측정 커버리지 표시', '국가별 전환 표'],
        'AI 유입 방문 수': VISITS + ['일별 방문 추이'],
        'GA4 이벤트 목록': ['GA4 이벤트 목록', '전환 이벤트 추적 여부 선택'],
    },
    '/ko/website/ai-funnel/acr': {
        'ACR 본문': ['브랜드별 ACR 표'] + ACR + ['선택률 추이 차트', '모델별 선택 구도 표', '차종별 선택 전환율 표', '모델별 점유 맵'],
    },
    '/ko/projects': {
        '프로젝트 수 ·': ['프로젝트 수', '프로젝트 만들기 버튼'],
        '쓰기: 초대 수락': ['초대 수락 버튼', '초대 거절 버튼'],
        '타일 4개': [f'{ui("projects.overview.tiles." + key).format(days=7)} 카드' for key in ['total', 'members', 'recent', 'queued']],
        '브랜드별 ·': ui_names('projects.overview.distribution', ['brand.title', 'country.title']),
        '프로젝트 카드 목록': ['프로젝트 카드 목록', '프로젝트 검색창', '프로젝트 역할 필터', '프로젝트 정렬'],
    },
    '/ko/projects/new': {
        '생성 폼 옵션': ['브랜드 선택', '권역 선택', '국가 선택', 'AI 엔진 선택', '브랜드 잠금 표시'],
    },
    '/ko/projects/[id]': {
        '필터 바 ·': ['필터 바', '측정 기준일 칩', '기간 달력'],
        '요약 타일': [f'{name} 타일' for name in ui_names('projectDetail.dashboard.tiles', ['prompts', 'candidates', 'members', 'lastAi'])],
        'KPI 카드 ①': per_metric(KPI, 'KPI 카드'),
        '카드 Δ': per_metric(KPI + [TARGET_CITATION], '증감 표시'),
        '엔진 간': per_metric(KPI, f'{ui("dashboard.kpi.sub.engineConsistency")} 배지'),
        '#16 경쟁사': ['경쟁사 SOV 비교'],
        '⑥ AI': [f'{TARGET_CITATION} 카드'],
        '안내 배너': ['자사 기준 URL 여러 개 안내', '기존 도메인 기준 사용 안내'],
        '⑦ AI': ['AI 유입 전환율 카드'],
        '구성 (#21': [f'{name} 도넛' for name in ui_names('dashboard.composition', ['topicTitle', 'sourceTitle'])],
    },
    '/ko/projects/[id]/analysis/mention': {
        '제목 ·': ['화면 제목', '국가 잠금 칩'],
        '필터 바 ·': ['필터 바', '측정 기준일 표시', '기간 달력', '커스텀 태그 필터'],
        '요약 카드 6개': per_metric(MENTION, '요약 카드', '증감 표시') + ['증감 비교 기준일'],
        '감정 분포 ·': ['감정 분포 차트', '긍정 신호 수', '부정 신호 수', '멘션 유형별 브랜드 점유 차트'],
    },
    '/ko/projects/[id]/analysis/citation': {
        '기준일 ·': ['측정 기준일 표시', '필터 바'],
        '요약 카드 5종': per_metric(CITATION, '요약 카드'),
        'Owned base': [f'{name} 카드' for name in ui_names('answerAnalysis.citations.baseSplit', ['ownedTitle', 'uncitedTitle'])],
        '행 드릴다운 ·': ['인용 URL 목록', '인용 프롬프트 목록'],
    },
    '/ko/projects/[id]/ai-funnel/visibility': {
        '제목 ·': ['화면 제목', '국가 잠금 칩'],
        '사분면 카드': QUADRANTS,
    },
    '/ko/projects/[id]/ai-funnel/acr': {
        '제목 ·': ['화면 제목', '국가 잠금 칩'],
        'KPI 카드 4개': ACR,
    },
    '/ko/projects/[id]/ai-funnel/conversion': {
        '제목 ·': ['화면 제목', '국가 잠금 칩'],
        '전환 이벤트 목록': ['전환 이벤트 목록', '전환 이벤트 추적 여부 선택'],
        '필터바 (엔진': ['AI 엔진 필터', '기기 필터', '방문자 유형 필터', '기간 선택'],
        'KPI 3장': CONVERSION,
        '전환율 ·': ['전환율 추이', '방문 수 추이'],
        'AI 모델(엔진)': [ui('aiFunnelView.conversion.engineBreakdown.title'), f'{ui("aiFunnelView.conversion.engineBreakdown.lowSample")} 배지'],
        'AI 유입 사이트': VISITS,
        '미연동 안내': ['미연동 안내', '측정 대기 안내'],
    },
    '/ko/projects/[id]/prompt': {
        '후보 풀 목록': ['후보 풀 목록', '후보 풀 정렬'],
        '적용된 프롬프트 표': ['적용된 프롬프트 표', '프롬프트 정렬', '실행 대기 수 배지'],
        '측정 라이프사이클': ['영향받는 답변 수', '영향받는 언급 수', '영향받는 인용 수', '공유 행 경고'],
        '쓰기: 후보 삭제': ['후보 단건 삭제 버튼', '선택 후보 삭제 버튼'],
        '쓰기: 측정 중지': ['측정 중지 버튼', '측정 재개 버튼'],
        '쓰기: 태그 열 추가': ['태그 열 추가 버튼', '태그 열 삭제 버튼'],
    },
    '/ko/projects/[id]/member': {
        '쓰기: 초대 취소': ['초대 취소 버튼', '멤버 제거 버튼'],
        '쓰기: Owner 위임': ['Owner 위임 버튼', 'Viewer 강등 버튼'],
    },
    '/ko/projects/[id]/setting': {
        '일반 정보 폼': ['프로젝트 이름 입력', '프로젝트 설명 입력', '브랜드 선택', '국가 표시', 'GA4 속성 ID 입력'],
        'AI 엔진 선택': ['AI 엔진 선택', 'AI 엔진 변경 이력'],
        '추적 대상(': ['자사 별칭 목록', '자사 모델 목록', '경쟁 브랜드 목록', '경쟁 모델 목록', 'SOV 비교 기준 브랜드 표시'],
        'Scope 연결 상태': ['분석 연결 상태', '분석 연결 진단'],
        '쓰기: 일반 정보 저장': ['일반 정보 저장 버튼', '브랜드 변경 재처리 다이얼로그'],
        '쓰기: Owned base 추가': ['자사 기준 URL 추가 버튼', '자사 기준 URL 삭제 버튼'],
        '쓰기: 추적 URL 추가': ['추적 URL 추가 버튼', '추적 URL 삭제 버튼'],
        '쓰기: 추적 브랜드·모델': ['추적 브랜드 추가 버튼', '추적 브랜드 삭제 버튼', '추적 모델 추가 버튼', '추적 모델 삭제 버튼', '추적 대상 변경 재처리 다이얼로그'],
        '쓰기: KPI#16': ['SOV 비교 기준 브랜드 지정', 'SOV 비교 기준 브랜드 해제'],
    },
    '/ko/projects/[id]/intent/google-keyword': {
        '관심도 추이': ['관심도 추이 차트', '평균 관심도'],
        'SERP 표': ['검색 결과 표', '제안 프롬프트 재생성 버튼'],
        '관련 검색어 표': ['관련 검색어 표', '발견 검색어 수'],
        '쓰기: 추적 키워드': ['추적 키워드 추가 버튼', '추적 키워드 삭제 버튼', '선택 키워드 삭제 버튼'],
        '쓰기: 제안 프롬프트': ['제안 프롬프트 단건 후보 추가', '선택 프롬프트 후보 추가'],
    },
    '/ko/projects/[id]/intent/social-scraping': {
        '구매 맥락·구매 조건': CONTEXT,
        '상세(': ['상세 언급 수', '상세 관점 분포', '상세 연결 항목', '상세 근거 인용', '상세 출처 도메인'],
        '쓰기: 더 생성': ['프롬프트 더 생성 버튼', '선택 항목으로 프롬프트 생성 버튼'],
    },
    '/ko/customer-interest/google-keywords': {
        '키워드 탭': ['키워드 탭', '기간 필터', '국가 필터'],
        '관심도 추이': ['관심도 추이 차트', '평균 관심도'],
        'SERP 표': ['검색 결과 표', '제안 프롬프트', '후보 추가 버튼 비활성 표시', '제안 프롬프트 재생성 버튼'],
    },
    '/ko/customer-interest/social-scraping': {
        '구매 맥락 지도': CONTEXT + CONTEXT_TABLES + ['표 페이지 이동'],
        '상세(': ['상세 근거 인용', '상세 출처 도메인'],
        '노드 그래프': ['컨텍스트 노드 그래프', '관점 필터', '그래프 물리 설정'],
    },
    '/ko/admin': {
        '사용자 표(': ['사용자 표', '사용자 검색창', '사용자 정렬'],
        '쓰기: 계정 정지': ['계정 정지 버튼', '계정 재개 버튼'],
        '쓰기: 이메일로': ['사용자 추가 폼', '계정 생성 버튼', '임시 비밀번호 토스트'],
    },
    '/ko/admin/ga4': {
        'projects.ga4PropertyId': ['프로젝트별 GA4 별도 설정 목록'],
        'GA4 이벤트 목록': ['GA4 이벤트 목록', '현재 추적 이벤트 선택'],
    },
    '/ko/admin/keyword-tools': {
        '요약 카드 6개': [f'{name} 카드' for name in ui_names('keywordTools.summary', ['total', 'avg', 'totalVolume', 'high', 'mid', 'low'])] + ['검색량 결과 표'],
    },
    '/ko/admin/standards/prompts': {
        '총·사용중': ['총 프롬프트 수', '사용 중 프롬프트 수', '미추적 프롬프트 수', '연결되지 않은 프롬프트 수', 'ACR 프롬프트 수', '활성·삭제됨 보기 전환'],
        '필터(depth1': ['주제 필터', '퍼널 필터', '추적 상태 필터', '측정 종류 필터', '필터 초기화 버튼', '표시 프롬프트 수'],
        '본문·브랜드·프레임워크': [f'{ui("adminStandardPrompts.list.title")} 표'],
        '쓰기: xlsx 업로드': ['엑셀 가져오기 버튼', '변경 대조 미리보기', '변경 건수', '불변 건수', '미매칭 건수', '가져오기 경고'],
        '쓰기: 청크(25)': ['변경 적용 버튼', '적용 진행률', '적용 실패 목록', '실패 재시도 버튼'],
    },
    '/ko/admin/standards/customer-interest': {
        '입력→탐색': ['리서치 입력 폼', '리서치 탐색 화면'] + CONTEXT + CONTEXT_TABLES + ['컨텍스트 노드 그래프'],
        '키워드 표(': ['키워드 표', '키워드 정렬'],
        '쓰기: 키워드 활성': ['키워드 활성 버튼', '키워드 비활성 버튼'],
        '소스 표(': ['소스 URL 표', '소스 URL 정렬'],
        '쓰기: 소스 활성': ['소스 활성 버튼', '소스 비활성 버튼'],
    },
    '/ko/admin/standards/citation-sources': {
        '도메인 표(': ['도메인 분류 표', '도메인 검색창', '카테고리 필터', 'Other만 보기', '도메인 수', '교정 도메인 수', '자사 도메인 분류 경고'],
    },
    '/ko/admin/standards/entities': {
        '브랜드 엔티티 표': ['브랜드 엔티티 표', '브랜드 엔티티 검색창', '전체 엔티티 수', '자사 엔티티 수'],
        '활성 버전·초안': ['활성 버전 표시', '초안 상태 표시', '초안 만들기 버튼'],
        '언급 샘플 +': ['언급 샘플', '초안 엔티티 편집 버튼', '초안 엔티티 삭제 버튼', '표면 추가 버튼', '표면 삭제 버튼'],
    },
    '/ko/admin/standards/entities/draft': {
        '초안 대 기준': ['초안 변경 목록', '전역 차단 표면 목록'],
        '쓰기: 초안 제목': ['초안 제목 입력', '초안 사유 입력', '초안 수정 저장', '초안 폐기 버튼'],
        '쓰기: 허브 엔티티': ['허브 엔티티 추가 폼', '전역 차단 표면 추가 폼'],
        '린트 결과 +': ['린트 결과', '린트 실행 버튼', '린트 확인 저장 버튼'],
    },
    '/ko/admin/standards/entities/review': {
        '검토 항목 목록': ['검토 항목 목록', '검토 상태 필터', '검토 종류 필터', '검토 항목 검색'],
        '쓰기: 등록/기각': ['등록 결정 버튼', '기각 결정 버튼'],
    },
    '/ko/admin/standards/entities/versions': {
        '버전 목록 +': ['버전 목록', '반영 요청 목록'],
        '쓰기: 활성 버전': ['활성 버전 반영 요청 버튼', '버전 되돌리기 버튼'],
    },
    '/ko/admin/standards/entities/audit': {
        '감사 이력 표': ['감사 이력 표', '감사 이력 더 보기 버튼'],
    },
    '/ko/admin/standards/entities/applies/[applyId]': {
        '상태·미리보기': ['반영 상태', '반영 미리보기', '반영 진행률', '숨김 변경 수', '상태 갱신 중단 안내'],
        '쓰기: 미리보기·': ['미리보기 버튼', '승인 버튼', '거절 버튼', '재개 버튼', '포기 버튼', '되돌리기 버튼'],
    },
    '/ko/raw-data-qa': {
        '게이트 진입 판정': ['검수 게이트 안내'],
        '쓰기: 입장': ['검수자 이름 입력', '공유 비밀번호 입력', '검수 입장 버튼', '입장 오류 안내'],
    },
    '/ko/raw-data-qa/answers': {
        '검수자 표시': ['검수자 이름 표시', '검수 목록 탭', '노트 모아보기 탭'],
        '진행률 헤더': ['필터 기준 답변 수', '필터 기준 검수 완료 수', '검수 완료율', '이상 답변 수', '노트 수', '전체 검수 완료 수'],
        '필터(표면': ['표면 필터', '검수 상태 필터', '브랜드 필터', '국가 필터', '엔진 필터', '언어 필터', '검수자 필터', '프롬프트 검색창', '기간 필터', '노트 있음 토글', '멘션 0 토글', '필터 링크 복사 버튼', '필터 초기화 버튼'],
        '답변 목록(': ['검수 답변 목록', '검수 상태 배지', '검수자·잠금 배지', '답변 더 보기 버튼'],
    },
    '/ko/raw-data-qa/answers/[jobId]': {
        '답변 원문(': ['프롬프트 본문', 'AI 답변 원문', '답변 언급 하이라이트', '앵커 접힘 안내', '미러 제외 안내'],
        '낱알 패널': per_metric(ui_names('qaReview.sections', ['prompt', 'mentions', 'citations', 'acr', 'meta']), '상세 블록', '판정 토글', '미해결 노트 수'),
        '기존 검수 기록': ['기존 검수자 표시', '기존 검수 시각'],
        '이전/다음': ['이전 답변 버튼', '다음 답변 버튼'],
        '쓰기: 검수 락': ['다른 검수자 열람 중 안내', '검수 잠금 만료 안내', '읽기 전용 표시'],
    },
    '/ko/raw-data-qa/notes': {
        '대상별 노트 수': [f'{x} 노트 수' for x in ['답변', '프롬프트', '멘션', '인용', 'ACR', '메타', '전체']],
        '노트 목록 +': ['노트 목록', '노트 대상 종류 필터', '노트 심각도 필터', '해결된 노트 보기 토글', '노트 더 보기 버튼'],
        '쓰기: 해결 표시/': ['노트 해결 표시 버튼', '노트 해결 취소 버튼'],
    },
}

# Exact replacements for display names only. Source labels stay intact because
# measurement overrides and provenance use their historical wording as keys.
DISPLAY_LABELS = {
    'AI 엔진별 전환': ui('aiFunnelView.conversion.engineBreakdown.title'),
    '국가별 전환 표': f'{ui("aiFunnelView.conversion.countries.title")} 표',
    '페이지별 전환 표': f'{ui("aiFunnelView.conversion.table.title")} 표',
    '페이지별 전환 표 (상위 12, 정렬)': f'{ui("aiFunnelView.conversion.table.title")} 표 · 상위 12, 정렬',
    '인용 출처 구성 도넛(상위 7 + 기타)': f'{ui("dashboard.composition.sourceTitle")} 도넛 · 상위 7 + 기타',
    '시장별 경쟁 위치 지도': f'{ui("dashboard.geo.title")} · {ui("dashboard.geo.map.title")}',
    '출처 카테고리별 인용 현황': ui('answerAnalysis.citations.v2.categoryStatus.title'),
    '출처 카테고리 도넛': f'{ui("answerAnalysis.citations.pie.categoryTitle")} 도넛',
    '도메인 인용 순위표': f'{ui("answerAnalysis.citations.table.title")} 표',
    '관점 필터': f'{ui("socialScraping.contextMap.perspectiveFilter")} 필터',
    '상세 관점 분포': f'{ui("socialScraping.contextMap.detail.perspectiveTitle")} · 상세',
    '상세 출처 도메인': f'{ui("socialScraping.contextMap.detail.domainsTitle")} · 상세',
    '변경 대조 미리보기': ui('adminStandardPrompts.io.previewTitle'),
    '실패 재시도 버튼': f'{ui("adminStandardPrompts.io.applyRetryFailed")} 버튼',
    '노트 있음 토글': f'{ui("qaReview.list.filterHasNotes")} 토글',
    '멘션 0 토글': f'{ui("qaReview.list.filterNoMentions")} 토글',
    '해결된 노트 보기 토글': f'{ui("qaReview.notes.filterIncludeResolved")} 토글',
}


def display_location(location):
    """Spell out KPI tab names in the visible location caption, too."""
    replacements = {
        'KPI 탭: 노출률·점유율': f'KPI 탭: {KPI[0]}·{KPI[1]}',
        'KPI 탭: 우호도': f'KPI 탭: {KPI[2]}',
        'KPI 탭: 우선 노출도': f'KPI 탭: {KPI[3]}',
    }
    for old, new in replacements.items():
        location = location.replace(old, new)
    return location


HIDDEN = {
    ('/ko/dashboard', '숨은 계산: AI 유입 전환(GA4)'),
    ('/ko/raw-data-qa/answers', '락·검수 상태 10초 폴링'),
}


def visible_inventory(source_screens):
    """Return visible screens, technical-only rows, and source-row provenance.

    Evidence is intentionally inherited, not reclassified or remeasured. Original
    write/read semantics are kept for the existing F7/common-path calculation.
    """
    screens, technical, provenance = [], [], {}
    matched = set()
    for source in source_screens:
        if source['route'] in ('—', '', None):
            for area in source['areas']:
                if area[1].startswith('로그인 화면'):
                    screen = {**deepcopy(source), 'name': '로그인', 'menu': '로그인', 'title': 'HMG GEO 모니터링 로그인', 'route': '/ko/login', 'f1b': ('u', '미측정')}
                    labels = ['로그인 화면', '이메일 입력', '비밀번호 입력', '로그인 버튼', '로그인 오류 안내']
                elif area[1].startswith('접근 불가 화면'):
                    screen = {**deepcopy(source), 'name': '접근 불가', 'menu': '접근 불가', 'title': '접근 가능한 메뉴가 없습니다', 'route': '/ko/no-access', 'f1b': ('u', '미측정')}
                    labels = ['접근 불가 안내', '로그아웃 버튼']
                else:
                    technical.append((source['name'], area))
                    continue
                screen['areas'] = []
                for label in labels:
                    screen['areas'].append((screen['title'], label, '', *area[3:]))
                    provenance[(screen['route'], label)] = area
                screens.append(screen)
            continue
        screen = {**deepcopy(source), 'areas': []}
        for area in source['areas']:
            if (source['route'], area[1]) in HIDDEN:
                technical.append((source['name'], area))
                continue
            candidates = [(prefix, labels) for prefix, labels in RULES.get(source['route'], {}).items() if area[1].startswith(prefix)]
            # A more specific row definition wins over a shared label prefix.
            candidates.sort(key=lambda entry: len(entry[0]), reverse=True)
            if candidates:
                prefix, labels = candidates[0]
                rule_key = (source['route'], prefix)
                if rule_key in matched:
                    raise ValueError(f'UI rule matched multiple source rows: {rule_key}')
                matched.add(rule_key)
            else:
                labels = [area[1].removeprefix('쓰기: ')]
            for label in labels:
                label = DISPLAY_LABELS.get(label, label)
                key = (screen['route'], label)
                if key in provenance:
                    raise ValueError(f'Duplicate visible item: {key}')
                provenance[key] = area
                # Keep conditions and technical explanations with the original
                # evidence; the visible subtitle is the screen location only.
                screen['areas'].append((display_location(area[0]), label, '', *area[3:]))
        screens.append(screen)
    expected = {(route, prefix) for route, rules in RULES.items() for prefix in rules}
    if expected != matched:
        raise ValueError(f'Unused UI inventory rules: {expected - matched}')
    return screens, technical, provenance
