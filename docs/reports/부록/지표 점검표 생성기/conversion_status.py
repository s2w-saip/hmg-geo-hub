"""리뉴얼 전환 현황 (완료 열 + 리뉴얼 화면 구현). 기준: main 07de7f8 + 작업 트리(2026-10-28).

ROUTE_PATH: 점검표 화면 경로 -> (경로 종류, 근거). 완료 열의 항목 판정은 화면의 데이터 경로를 따른다.
  bff      = 원래 화면을 그대로 그리고 데이터는 /v1/screens 로만 읽음. legacy 분기 제거(fb88fe0).
  replaced = /v1/screens 로 읽지만 원래 화면 대신 Gold 직결 간이 화면(원래 표시 항목 미이식).
  legacy   = HGH_SOURCE_* 분기와 lib/db legacy 경로가 남음.
완료(☑)에는 필수 계산·표시 규칙 동일성 검증과 F10 통과가 더 필요하다. 아직 어느 항목도 둘 다 끝내지 못했다.

RENEWAL: 리뉴얼 껍데기(/renewal) 메뉴 항목별 리뉴얼 화면 구현 상태. 화면 코드가 바뀌면 같이 고친다.
"""

AS_OF = "2026-10-28"
BASIS = "main 07de7f8 + 작업 트리"
BFF_COMMITS = "668238d · fb88fe0 · 41022a5"

KIND_LABEL = {"bff": "데이터 경로 전환", "replaced": "대체 화면", "legacy": "legacy 잔존"}

_G7_ADMIN = "HGH_SOURCE_G7 분기 · lib/hgh/adapters/admin.ts + lib/db/repositories"
_G7_QA = "HGH_SOURCE_G7 분기 · lib/hgh/adapters/qa.ts + lib/db/repositories/qa-review"
_SESSION = "HGH_SOURCE_SESSION 분기 · lib/auth/session.ts"

ROUTE_PATH = {
    "/ko/dashboard": ("bff", "overview/*"),
    "/ko/standard/answer-analysis/mention": ("bff", "mention/*"),
    "/ko/standard/answer-analysis/citation": ("bff", "citation/*"),
    "/ko/standard/answer-analysis/citation/prompts": ("bff", "citation/prompts"),
    "/ko/standard/answer-analysis/citation/tone-urls": ("bff", "citation/tone-urls"),
    "/ko/standard/ai-funnel/acr": ("bff", "acr/standard"),
    "/ko/standard/prompts": ("bff", "catalog/prompts-*"),
    "/ko/website": ("bff", "website/*"),
    "/ko/website/prompts": ("bff", "website/prompts-*"),
    "/ko/website/answer-analysis/mention": ("bff", "mention/*"),
    "/ko/website/answer-analysis/citation": ("bff", "citation/*"),
    "/ko/website/ai-funnel/acr": ("bff", "acr/gold"),
    "/ko/projects/[id]/analysis/mention": ("bff", "mention/*"),
    "/ko/projects/[id]/analysis/citation": ("bff", "citation/*"),
    "/ko/projects/[id]/ai-funnel/acr": ("bff", "acr/gold"),
    "/ko/standard/ai-funnel/visibility": ("replaced", "SourceAnalytics · sources/analytics"),
    "/ko/standard/ai-funnel/conversion": ("replaced", "SourceAnalytics · sources/analytics"),
    "/ko/website/ai-funnel/conversion": ("replaced", "SourceAnalytics · sources/analytics"),
    "/ko/projects": ("replaced", "GoldProjects · projects/list"),
    "/ko/projects/[id]": ("replaced", "GoldProject · projects/detail"),
    "/ko/projects/[id]/ai-funnel/visibility": ("replaced", "SourceAnalytics · sources/analytics"),
    "/ko/projects/[id]/ai-funnel/conversion": ("replaced", "SourceAnalytics · sources/analytics"),
    "/ko/projects/[id]/prompt": ("replaced", "GoldProjectMetadata · projects/detail"),
    "/ko/projects/[id]/member": ("replaced", "GoldProjectMetadata · projects/detail"),
    "/ko/projects/[id]/setting": ("replaced", "GoldProjectMetadata · projects/detail"),
    "/ko/projects/[id]/intent/google-keyword": ("replaced", "GoldKeywords · intent/keywords"),
    "/ko/projects/[id]/intent/social-scraping": ("replaced", "GoldSocial"),
    "/ko/customer-interest/google-keywords": ("replaced", "GoldKeywords · intent/keywords"),
    "/ko/customer-interest/social-scraping": ("replaced", "GoldSocial"),
    "/ko/projects/new": ("legacy", "HGH_SOURCE_G6 분기 · lib/hgh/adapters/projects.ts"),
    "/ko/admin": ("legacy", _G7_ADMIN),
    "/ko/admin/ga4": ("legacy", _G7_ADMIN),
    "/ko/admin/keyword-tools": ("legacy", "HGH_SOURCE_G7 분기 · app/api/keyword/*"),
    "/ko/admin/standards/prompts": ("legacy", _G7_ADMIN),
    "/ko/admin/standards/customer-interest": ("legacy", _G7_ADMIN),
    "/ko/admin/standards/citation-sources": ("legacy", _G7_ADMIN),
    "/ko/admin/standards/entities": ("legacy", _G7_ADMIN),
    "/ko/admin/standards/entities/draft": ("legacy", _G7_ADMIN),
    "/ko/admin/standards/entities/review": ("legacy", _G7_ADMIN),
    "/ko/admin/standards/entities/versions": ("legacy", _G7_ADMIN),
    "/ko/admin/standards/entities/audit": ("legacy", _G7_ADMIN),
    "/ko/admin/standards/entities/applies/[applyId]": ("legacy", _G7_ADMIN),
    "/ko/raw-data-qa": ("legacy", _G7_QA),
    "/ko/raw-data-qa/answers": ("legacy", _G7_QA),
    "/ko/raw-data-qa/answers/[jobId]": ("legacy", _G7_QA),
    "/ko/raw-data-qa/notes": ("legacy", _G7_QA),
    "/ko/login": ("legacy", _SESSION),
    "/ko/no-access": ("legacy", _SESSION),
}


def done_verdict(route, f10):
    """완료 열 한 칸: (기호, 사유). f10 = 같은 항목의 After F10 기호."""
    kind, evidence = ROUTE_PATH[route]
    if kind == "legacy":
        return "n", f"legacy 잔존 · {evidence}"
    if kind == "replaced":
        return "n", f"원래 항목 미이식 · Gold 직결 대체 화면({evidence})"
    moved = f"데이터 경로 전환({evidence} · legacy 분기 제거 fb88fe0)"
    if f10 == "n":
        return "n", f"{moved} · F10 미통과(이관 전 56ad6f9 측정)"
    return "u", f"{moved} · 필수 계산·표시 규칙 동일성 검증 미완료"


# 리뉴얼 화면 (메뉴 구역, 메뉴 항목, 원래 주소, 상태, 리뉴얼 BFF 화면, 확인한 것, 커밋)
# 상태: done = 구현, wip = 구현(작업 트리·미커밋), todo = 미구현('미구현' 안내 화면)
RENEWAL = [
    ("Global", "Overview", "/dashboard", "done", "overview/*",
     "합성 데이터로 원래 화면과 대조 25/25(필터 없음 · brand=Hyundai) + 시장 표 43개국. 운영·stg 대조 미실시",
     "f962655 · 130c3c8 · fb88fe0"),
    ("Global", "Global prompts", "/standard/prompts", "done", "catalog/*",
     "필터 동일성 4/4, 실 API 목록·필터·내보내기 건수 일치. 운영·stg 대조 미실시, 1만 건 대응 결정 대기",
     "f962655 · fb88fe0"),
    ("Global", "Answer analysis › Mention", "/standard/answer-analysis/mention", "done", "mention/rn-*",
     "BFF 이관 전후 화면 비교: 의도한 배치 변경(KPI 탭 이동)을 되돌리면 픽셀 동일. 엔진별 추이 격자선 3→4 확인 필요. 운영·stg 대조 미실시",
     "130c3c8 · 55d6444"),
    ("Global", "Answer analysis › Citation (하위 2: 공식 도메인 인용 프롬프트 · 긍정/부정 답변 인용 URL)",
     "/standard/answer-analysis/citation", "done", "citation/*",
     "필터 동일성 시험(원래 화면 패널과 대조). 운영·stg 대조 미실시", "130c3c8 · fb88fe0"),
    ("Global", "AI Agent Funnel › ACR", "/standard/ai-funnel/acr", "done", "acr/renewal",
     "필터 동일성 시험(원래 화면 패널과 대조). 운영·stg 대조 미실시. 차종 전환율 분모 중복 확인(P4) 대기",
     "130c3c8 · fb88fe0"),
    ("Global", "AI Agent Funnel › AI Conversion", "/standard/ai-funnel/conversion", "todo", "",
     "다음 리뉴얼 대상(인계 문서 10장)", ""),
    ("Global", "AI Agent Funnel › AI Visibility", "/standard/ai-funnel/visibility", "done", "visibility/renewal",
     "BFF 시험 16/16, 가짜 화면 API로 탭 4개 · 기간 · 1280px 확인. 연결된 사이트가 없어 실데이터 대조 불가",
     "bc2645b · 7a59bee"),
    ("Website", "Overview", "/website", "todo", "", "", ""),
    ("Website", "Prompts", "/website/prompts", "todo", "", "", ""),
    ("Website", "Answer analysis › Mention", "/website/answer-analysis/mention", "todo", "", "", ""),
    ("Website", "Answer analysis › Citation", "/website/answer-analysis/citation", "todo", "", "", ""),
    ("Website", "AI Agent Funnel › AI Conversion", "/website/ai-funnel/conversion", "todo", "", "", ""),
    ("Project", "Project list", "/projects", "todo", "", "프로젝트 하위 화면(Dashboard · Intent · Prompt · Analysis · AI Agent Funnel · Setting)도 모두 미구현", ""),
    ("Admin", "User management", "/admin", "todo", "", "", ""),
    ("Admin", "Global config › Global prompts", "/admin/standards/prompts", "wip", "catalog/* + HUB 저장소(catalog_editor)",
     "HUB 로그인 + 프롬프트 만들기 · 수정 · 보관 · 복원. Mac 로컬 PostgreSQL 에서 마이그레이션 · 검증 SQL 통과, Docker 경로 미실행", ""),
    ("Admin", "Global config › Customer interest config", "/admin/standards/customer-interest", "todo", "", "", ""),
    ("Admin", "Global config › Entity catalog", "/admin/standards/entities", "todo", "", "", ""),
    ("Admin", "Global config › 인용 출처 분류", "/admin/standards/citation-sources", "todo", "", "", ""),
    ("Admin", "Keyword tools", "/admin/keyword-tools", "todo", "", "", ""),
    ("Admin", "GA4 연동", "/admin/ga4", "todo", "", "", ""),
    ("Admin", "분석 엔진", "/admin/analysis", "todo", "", "운영 웹에만 있는 화면(이 저장소에 원래 화면도 없음)", ""),
    ("Admin", "리포트 관리", "/admin/reports", "todo", "", "운영 웹에만 있는 화면(이 저장소에 원래 화면도 없음)", ""),
    ("Admin", "측정 크레딧 › 계정 목록", "/admin/credits", "todo", "", "운영 웹에만 있는 화면(이 저장소에 원래 화면도 없음)", ""),
]
