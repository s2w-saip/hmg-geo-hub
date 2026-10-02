#!/usr/bin/env python3
"""기능 중심 분류 체계(대분류 → 도메인 → 최소 기능 모듈)의 단일 정본 생성.
- 입력: modules/전체-통합.json api_catalog(180: BG-45 GET /v1/qa/sessions/current 추가), 단위 JSON(screens)
  (레포 사본 docs/design/taxonomy/ 에서 돌리면 docs/design/api/units/ 를 읽는다)
- 출력: taxonomy.json (카테고리·도메인·기능·엔드포인트·화면), 각 엔드포인트는 정확히 한 기능에 배정(단언)
"""
import json
import os
import re
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
# 단위 JSON 위치: 설계 작업 폴더(../modules) 또는 레포 사본(docs/design/taxonomy → ../api/units). 두 곳 내용은 같다(레포 통합 때 복사).
MOD = next(p for p in (os.path.join(HERE, "..", "modules"), os.path.join(HERE, "..", "api", "units"))
           if os.path.isfile(os.path.join(p, "전체-통합.json")))
cat = json.load(open(os.path.join(MOD, "전체-통합.json"), encoding="utf-8"))["api_catalog"]
# 한 줄로 축약된 항목 펼치기(통합 단계 "배정만, 단위 설계 필요")
EXPAND = {
 "AD-6": [("GET", "/v1/admin/ga4/properties", "GA4 속성 목록"), ("PUT", "/v1/admin/ga4/properties/{property_id}", "GA4 속성 등록·수정(브랜드·국가 매핑) + judgment_change(ga4_property)"),
          ("DELETE", "/v1/admin/ga4/properties/{property_id}", "GA4 속성 삭제"), ("GET", "/v1/admin/ga4/properties/{property_id}/events", "추적 이벤트 목록"),
          ("PUT", "/v1/admin/ga4/properties/{property_id}/events", "추적 이벤트 교체 + judgment_change(ga4_tracked_event)")],
 "AD-7": [("POST", "/v1/admin/keyword-tools/volume", "키워드 검색량 조회(dfs_fetch 큐)"), ("POST", "/v1/admin/keyword-tools/to-prompt", "키워드 → 프롬프트 변환"),
          ("POST", "/v1/admin/keyword-tools/prompt-to-volume", "프롬프트 → 키워드 검색량")],
}
_cat = []
for a in cat:
    if a["id"] in EXPAND:
        for m, pth, sm in EXPAND.pop(a["id"]):
            _cat.append({**a, "method": m, "path": pth, "summary": f"(단위 설계 필요) {sm}"})
    elif a["id"] not in ("AD-6", "AD-7"):
        _cat.append(a)
cat = _cat

# (카테고리, 카테고리명) → [(도메인, 도메인명, [(기능, 기능명, 단위ID들, 경로 정규식)])]
T = [
 ("analytics", "분석 조회", [
   ("filters", "필터", [("options", "필터 옵션", ["F-1"], r"^/v1/filters/options"), ("dates", "선택 가능 날짜·기준일", ["F-2"], r"^/v1/filters/dates")]),
   ("kpi", "KPI", [("summary", "요약 카드", ["K-1"], r"^/v1/kpi/summary"), ("compare", "기간 비교 Δ", ["K-2"], r"^/v1/kpi/compare"), ("engines", "엔진별 서브 지표", ["K-3"], r"^/v1/kpi/engines")]),
   ("trend", "추이", [("series", "지표 추이", ["T-1"], r"^/v1/trend")]),
   ("mentions", "언급", [("brands", "브랜드·경쟁사 비교", ["M-1"], r"^/v1/mentions/brands"), ("types", "언급 유형·태도", ["M-2"], r"^/v1/mentions/types"), ("prompts", "프롬프트별 언급", ["M-3"], r"^/v1/mentions/prompts")]),
   ("citations", "인용", [("domains", "인용 도메인 순위", ["C-1"], r"^/v1/citations/domains$"), ("domain_detail", "도메인 드릴다운", ["C-1"], r"^/v1/citations/domains/\{"),
                          ("sources", "출처 카테고리", ["C-2"], r"^/v1/citations/sources(/types)?$"), ("tone", "답변 톤별 인용", ["C-2"], r"^/v1/citations/sources/tone"),
                          ("prompts", "프롬프트별 인용", ["C-3"], r"^/v1/citations/prompts"), ("targets", "타겟·자사 URL 인용률", ["C-4"], r"^/v1/citations/targets")]),
   ("geo", "국가별", [("markets", "국가별 현황", ["GEO-1"], r"^/v1/geo")]),
   ("answers", "답변 드릴다운", [("list", "답변 목록", ["AN-1"], r"^/v1/answers$"), ("detail", "답변 상세", ["AN-2"], r"^/v1/answers/\{")]),
   ("funnel", "AI 퍼널", [("acr", "AI 선택률(ACR)", ["FU-1"], r"^/v1/funnel/acr"), ("conversion", "AI 유입·전환(GA4)", ["FU-2"], r"^/v1/funnel/conversion")]),
 ]),
 ("catalog", "프롬프트 카탈로그", [
   ("prompts", "프롬프트", [("catalog", "카탈로그·측정 메타", ["P-1"], r"^/v1/prompts\?"), ("history", "변경 이력", ["P-2"], r"^/v1/prompts/history")]),
 ]),
 ("projects", "프로젝트", [
   ("project", "프로젝트", [("core", "프로젝트 CRUD", ["PJ-1"], r"^/v1/projects(/\{project_id\})?$")]),
   ("members", "멤버", [("roster", "멤버 목록·역할", ["PJ-2"], r"^/v1/projects/\{project_id\}/members(/\{user_id\})?$"),
                        ("invites", "초대 수락·거절", ["PJ-2"], r"^/v1/(projects/\{project_id\}/members/me/|me/project-invites)"),
                        ("audit", "멤버 감사", ["PJ-2"], r"^/v1/projects/\{project_id\}/member-audit")]),
   ("prompts", "프로젝트 프롬프트", [("candidates", "후보 풀", ["PJ-3"], r"/prompt-candidates"),
                                   ("crud", "프롬프트 CRUD", ["PJ-3"], r"^/v1/projects/\{project_id\}/prompts(/\{prompt_id\})?$"),
                                   ("lifecycle", "일시정지·재개·삭제 영향", ["PJ-3"], r"/prompts/\{prompt_id\}/(lifecycle-impact|pause|resume|hard-delete)"),
                                   ("execute", "측정 실행", ["PJ-3"], r"/prompts/execute"),
                                   ("io", "가져오기·내보내기", ["PJ-3"], r"/prompts/(import|export)"),
                                   ("fields", "커스텀 필드", ["PJ-3"], r"(/prompt-fields|/prompts/\{prompt_id\}/fields/)")]),
   ("settings", "프로젝트 설정", [("overview", "설정 묶음", ["PJ-4"], r"/settings$"), ("engines", "AI 엔진", ["PJ-4"], r"/settings/engines"),
                                  ("owned_bases", "소유 베이스 URL", ["PJ-4"], r"/settings/owned-bases"), ("tracked_urls", "추적 URL", ["PJ-4"], r"/settings/tracked-urls"),
                                  ("tracked_targets", "추적 대상(별칭·경쟁사·차종)", ["PJ-4"], r"/settings/(brand-aliases|competitors|vehicles)"),
                                  ("scope_link", "Scope 연결 진단", ["PJ-4"], r"/settings/scope-link")]),
 ]),
 ("intent", "고객 관심", [
   ("keywords", "키워드", [("tracked", "추적 키워드", ["IN-1"], r"^/v1/intent/keywords"), ("research", "인사이트·연관어·조회", ["IN-1"], r"^/v1/intent/(insight|related|lookup)"),
                           ("fetches", "수집 요청(비동기)", ["IN-1"], r"^/v1/intent/fetches"), ("serp_drafts", "SERP 프롬프트 초안", ["IN-1"], r"^/v1/intent/serp-drafts")]),
   ("candidates", "후보 풀", [("submit", "후보 등록(공용)", ["IN-1·IN-2"], r"^/v1/intent/candidates")]),
   ("social", "소셜·컨텍스트 맵", [("context_map", "컨텍스트 맵 조회·내보내기", ["IN-2", "CM-1"], r"(^/v1/intent/social/context-map|context-map/\*)"),
                                   ("prompts", "생성 프롬프트", ["IN-2"], r"^/v1/intent/social/prompts")]),
 ]),
 ("admin", "운영 관리", [
   ("catalog", "표준 카탈로그", [("prompts", "표준 프롬프트 CRUD", ["AD-1"], r"^/v1/admin/catalog/prompts(/\{prompt_id\}(/(text|labels|regions|kind|restore))?)?$"),
                                 ("bulk", "일괄 편집·가져오기·내보내기", ["AD-1"], r"^/v1/admin/catalog/prompts/(bulk|import|export)"),
                                 ("reference", "택소노미·시장", ["AD-1"], r"^/v1/admin/catalog/(taxonomy|markets)")]),
   ("interest", "고객 관심 원천", [("keywords", "표준 키워드", ["AD-1b"], r"^/v1/admin/interest/keywords"), ("sources", "표준 출처", ["AD-1b"], r"^/v1/admin/interest/sources")]),
   ("entities", "엔티티", [("registry", "엔티티 레지스트리", ["AD-2"], r"^/v1/admin/entities")]),
   ("citation_sources", "인용 출처", [("overrides", "도메인 카테고리 오버라이드", ["AD-3"], r"^/v1/admin/citation-overrides")]),
   ("cycles", "회차 운영", [("cycles", "회차 숨김·마감·노출일", ["AD-4"], r"^/v1/admin/cycles"), ("jobs", "측정 앵커 고정·드롭", ["AD-4"], r"^/v1/admin/jobs/")]),
   ("accounts", "계정·권한", [("users", "계정 CRUD·감사", ["AD-5"], r"^/v1/admin/users(?!/\{user_id\}/reset-password)")]),
   ("integrations", "외부 연동", [("ga4", "GA4 속성", ["AD-6"], r"^/v1/admin/ga4"), ("keyword_tools", "키워드 도구", ["AD-7"], r"^/v1/admin/keyword-tools")]),
   ("changes", "변경 요청 큐", [("queue", "재판정·운영 요청 조회", ["SHARED"], r"^/v1/admin/changes")]),
 ]),
 ("qa", "검수 콘솔", [
   ("answers", "검수 대상", [("list", "목록·진행률·이웃·필터", ["QA-1"], r"^/v1/qa/(answers(/progress|/\{job_id\}/neighbors)?|filters)$"), ("detail", "검수 상세", ["QA-3"], r"^/v1/qa/answers/\{job_id\}$")]),
   ("review", "판정", [("verdict", "판정 저장", ["QA-2"], r"/review$"), ("lock", "답변 락", ["QA-2"], r"/lock$"), ("sessions", "검수 세션", ["QA-2"], r"^/v1/qa/sessions"), ("deltas", "변경 알림", ["QA-2"], r"^/v1/qa/deltas")]),
   ("notes", "노트", [("notes", "노트 작성·조회·내보내기", ["QA-2"], r"(/notes)")]),
 ]),
 ("platform", "플랫폼", [
   ("auth", "인증", [("session", "세션·스코프", ["AU-1"], r"^/v1/auth/me")]),
 ]),
 ("ingest", "적재 파이프라인(워커)", [
   ("pull", "Scope pull·쓰기 스키마", [("sync", "20분 pull·CLI", ["IG-1"], r"^(WORKER|CLI) .*(pull|sync)"), ("ops", "적재 운영 조회", ["IG-1"], r"^/v1/admin/ingest/")]),
   ("project", "판정·읽기 투영", [("apply", "판정·투영·재판정", ["IG-2"], r"^FUNC ingest\.project")]),
   ("cycles", "회차·큐·아웃박스", [("ledger", "회차 귀속·재평가", ["IG-3"], r"^FUNC ingest\.cycles"), ("workers", "cycles_tick·queue·outbox·dfs_fetch", ["IG-3"], r"^WORKER .*cycles_tick"), ("watch", "감시 태스크", ["IG-3"], r"^TASK ")]),
 ]),
]
EXCLUDED = {("AD-5", r"reset-password"): "Q16: 비밀번호 재발급 미도입", ("WG-1", r".*"): "Q14: 소비자 0, S3 보관 후 제외",
            ("CM-1", r"^\(흡수\)"): "intent.social.context_map 으로 흡수"}

def key(a):  # 경로 판정 대상 문자열: HTTP 는 경로, 워커·함수는 "METHOD path"
    return a["path"] if a["method"] in ("GET", "POST", "PUT", "PATCH", "DELETE", "GET/PUT/DELETE") else f"{a['method']} {a['path']}"

features, assigned, excluded = [], defaultdict(list), []
for ck, cn, domains in T:
    for dk, dn, feats in domains:
        for fk, fn, uids, rx in feats:
            features.append({"id": f"{ck}.{dk}.{fk}", "category": ck, "category_ko": cn, "domain": dk, "domain_ko": dn,
                             "feature": fk, "feature_ko": fn, "units": uids, "rx": rx, "endpoints": []})
for i, a in enumerate(cat):
    ex = next((why for (u, rx), why in EXCLUDED.items() if a["id"] == u and (re.search(rx, a["path"]) or re.search(rx, a["method"]))), None)
    if ex:
        excluded.append({**a, "why": ex}); continue
    ms = [f for f in features if a["id"] in f["units"] and re.search(f["rx"], key(a))]
    assert len(ms) == 1, f"배정 {len(ms)}건: {a['id']} {a['method']} {a['path']} → {[m['id'] for m in ms]}"
    ms[0]["endpoints"].append({"method": a["method"], "path": a["path"], "summary": a["summary"], "risk": a.get("risk")})
empty = [f["id"] for f in features if not f["endpoints"]]
assert not empty, f"엔드포인트 없는 기능: {empty}"

# ════════════════════════════════════════════════════════════════════════════
# 화면(뷰) 색인
# ════════════════════════════════════════════════════════════════════════════
# 정본 = VIEWS_CANON(프론트 어댑터 설계 front-adapter-plan.md 3.1 점검 결과 + 3.3·3.4 매핑표 + 부록 A~F 화면별 대조, 2026-09-28).
# 단위 JSON screens 는 "단위가 어느 화면을 섬기나"의 거친 서술이라(추이 T-1 은 경로 없이 화면 이름만, 인증 AU-1 은 전 화면 공통)
# 그것만으로는 화면별 기능을 복원할 수 없다. 그래서 screens 파서(parse_screen_routes)는 교차 확인용으로만 쓰고,
# 정본에 없는 (화면, 기능) 쌍을 진단으로 출력한다(파서가 새 화면을 찾으면 사람이 정본에 반영 여부를 판단).
#
# 예전 결함(3.1): 첫 경로 토큰만 정규식 \s*(/[\w\-\[\]/\.]*) 로 뽑아 screens 를 ( · , { 에서 잘랐다.
#   "/(standard)/answer-analysis/*" → "/", "/standard·website/answer-analysis/citation" → "/standard",
#   "/projects/{id}/*" → "/projects", "/standard/answer-analysis/citation, /mention" → 첫 경로만,
#   "/standard/answer-analysis/{mention,citation}" → "/standard/answer-analysis". 그 결과 기능 누락·오배정이 생기고
#   analytics.trend.series 는 T-1 screens 에 경로가 없어 어느 화면에도 배정되지 않았다.
#
# 규칙(정본 표)
# - 키 = 프론트 page 경로(front/app/[locale]/(dash) 기준, 동적 세그먼트는 [id] 표기). 데이터 접근이 없는 화면(리다이렉트 전용·로그인·
#   정적 샘플)은 넣지 않는다: /standard/answer-analysis, /projects/[id]/analysis, /website/answer-analysis, /standard/ai-funnel,
#   /website/ai-funnel, /projects/[id]/ai-funnel, /projects/[id]/intent, /customer-interest, /admin/standards, /login, /no-access,
#   /customer-interest/social-scraping(픽스처). /projects/by-scope/[scopeId] 는 BG-36 GET /v1/projects/by-scope 로 데이터 화면(2026-09-29).
# - "/" 는 역할별 랜딩 리다이렉트(front/app/[locale]/page.tsx)로, 로그인 착지 판정에 platform.auth.session 을 쓴다(3.4).
# - 공용 레이아웃 게이트도 그 화면의 기능으로 적는다: 프로젝트 하위 화면 = projects.project.core(GET /v1/projects/{id}),
#   검수 콘솔 전 화면 = qa.review.sessions(레이아웃 게이트·로그아웃, BG-45 GET /v1/qa/sessions/current).
# - 답변 원문 모달(answer-modal.tsx)을 여는 화면은 analytics.answers.detail 을 갖는다(언급 3화면·인용 화면·인용 프롬프트 하위 페이지).
#   analytics.answers.list 는 현행 화면 소비자가 없다(드릴다운 답변 참조는 mentions/prompts·citations/prompts·domains/{skey} 의 AnswerRef).
_FILTERS = ["analytics.filters.options", "analytics.filters.dates"]
_PJ_GATE = ["projects.project.core"]
_QA_GATE = ["qa.review.sessions"]
_MODAL = ["analytics.answers.detail"]
VIEWS_CANON: dict[str, list[str]] = {
    "/": ["platform.auth.session"],
    # 대시보드(부록 A)
    "/dashboard": _FILTERS + ["analytics.kpi.summary", "analytics.kpi.compare", "analytics.trend.series", "analytics.mentions.brands",
                              "analytics.citations.domains", "analytics.geo.markets", "analytics.funnel.conversion"],
    "/website": _FILTERS + ["analytics.kpi.summary", "analytics.kpi.engines", "analytics.kpi.compare", "analytics.trend.series",
                            "analytics.citations.domains", "analytics.geo.markets", "analytics.mentions.brands"],
    "/projects/[id]": _PJ_GATE + _FILTERS + ["analytics.kpi.summary", "analytics.kpi.engines", "analytics.trend.series",
                                             "analytics.citations.domains", "analytics.mentions.brands", "projects.settings.overview",
                                             "projects.prompts.crud", "projects.prompts.candidates", "projects.members.roster"],
    # 언급(부록 B)
    "/standard/answer-analysis/mention": _FILTERS + _MODAL + ["analytics.kpi.summary", "analytics.kpi.compare", "analytics.kpi.engines",
                                                              "analytics.trend.series", "analytics.mentions.brands", "analytics.mentions.types",
                                                              "analytics.mentions.prompts", "analytics.citations.domains",
                                                              "analytics.citations.domain_detail"],
    "/website/answer-analysis/mention": _FILTERS + _MODAL + ["analytics.kpi.summary", "analytics.kpi.engines", "analytics.trend.series",
                                                             "analytics.mentions.brands", "analytics.mentions.types", "analytics.mentions.prompts",
                                                             "analytics.citations.domains", "analytics.citations.domain_detail"],
    "/projects/[id]/analysis/mention": _PJ_GATE + _FILTERS + _MODAL + ["projects.settings.overview", "analytics.kpi.summary",
                                                                       "analytics.kpi.engines", "analytics.trend.series",
                                                                       "analytics.mentions.brands", "analytics.mentions.types",
                                                                       "analytics.mentions.prompts", "analytics.citations.domains",
                                                                       "analytics.citations.domain_detail"],
    # 인용(부록 C)
    "/standard/answer-analysis/citation": _FILTERS + _MODAL + ["analytics.kpi.summary", "analytics.kpi.compare", "analytics.trend.series",
                                                               "analytics.citations.domains", "analytics.citations.domain_detail",
                                                               "analytics.citations.sources", "analytics.citations.prompts"],
    "/standard/answer-analysis/citation/prompts": _MODAL + ["analytics.citations.prompts"],
    "/standard/answer-analysis/citation/tone-urls": ["analytics.citations.sources", "analytics.citations.tone"],
    "/website/answer-analysis/citation": _FILTERS + _MODAL + ["analytics.trend.series", "analytics.citations.domains",
                                                              "analytics.citations.domain_detail", "analytics.citations.sources",
                                                              "analytics.citations.prompts", "analytics.citations.targets"],
    "/projects/[id]/analysis/citation": _PJ_GATE + _FILTERS + _MODAL + ["analytics.trend.series", "analytics.citations.domains",
                                                                        "analytics.citations.domain_detail", "analytics.citations.sources",
                                                                        "analytics.citations.prompts"],
    # AI 퍼널·프롬프트 카탈로그(부록 D)
    "/standard/ai-funnel/acr": _FILTERS + ["analytics.funnel.acr"],
    "/standard/ai-funnel/conversion": ["analytics.filters.options", "analytics.funnel.conversion"],
    "/standard/ai-funnel/visibility": ["analytics.filters.options"],
    "/website/ai-funnel/acr": _FILTERS + ["analytics.funnel.acr"],
    "/website/ai-funnel/conversion": ["analytics.filters.options", "analytics.funnel.conversion", "admin.integrations.ga4"],
    "/projects/[id]/ai-funnel/acr": _PJ_GATE,
    "/projects/[id]/ai-funnel/visibility": _PJ_GATE,
    "/projects/[id]/ai-funnel/conversion": _PJ_GATE + ["analytics.funnel.conversion", "admin.integrations.ga4"],
    "/standard/prompts": ["analytics.filters.dates", "catalog.prompts.catalog", "catalog.prompts.history"],
    "/website/prompts": _FILTERS + ["catalog.prompts.catalog"],
    # 프로젝트·고객 관심(부록 E)
    "/projects": ["projects.project.core", "projects.members.invites"],
    "/projects/new": ["projects.project.core"],
    "/projects/[id]/setting": _PJ_GATE + ["projects.settings.overview", "projects.settings.engines", "projects.settings.owned_bases",
                                          "projects.settings.tracked_urls", "projects.settings.tracked_targets", "projects.settings.scope_link"],
    "/projects/[id]/member": _PJ_GATE + ["projects.members.roster", "projects.members.audit"],
    "/projects/[id]/prompt": _PJ_GATE + ["projects.prompts.candidates", "projects.prompts.crud", "projects.prompts.lifecycle",
                                         "projects.prompts.execute", "projects.prompts.io", "projects.prompts.fields"],
    "/projects/[id]/intent/google-keyword": _PJ_GATE + ["intent.keywords.tracked", "intent.keywords.research", "intent.keywords.fetches",
                                                        "intent.keywords.serp_drafts", "intent.candidates.submit"],
    "/projects/[id]/intent/social-scraping": _PJ_GATE + ["intent.social.context_map", "intent.social.prompts", "intent.candidates.submit",
                                                         "projects.prompts.candidates"],
    "/customer-interest/google-keywords": ["intent.keywords.research", "intent.keywords.fetches"],
    # 운영·검수(부록 F)
    "/admin": ["admin.accounts.users"],
    "/admin/standards/prompts": ["admin.catalog.prompts", "admin.catalog.bulk", "admin.catalog.reference", "catalog.prompts.history"],
    "/admin/standards/customer-interest": ["admin.interest.keywords", "admin.interest.sources"],
    "/admin/standards/entities": ["admin.entities.registry"],
    "/admin/standards/citation-sources": ["admin.citation_sources.overrides"],
    "/admin/ga4": ["admin.integrations.ga4"],
    "/projects/by-scope/[scopeId]": _PJ_GATE,
    "/admin/keyword-tools": ["admin.integrations.keyword_tools", "admin.changes.queue"],
    "/raw-data-qa": _QA_GATE,
    "/raw-data-qa/answers": _QA_GATE + ["qa.answers.list", "qa.review.deltas"],
    "/raw-data-qa/answers/[jobId]": _QA_GATE + ["qa.answers.detail", "qa.answers.list", "qa.review.verdict", "qa.review.lock", "qa.notes.notes"],
    "/raw-data-qa/notes": _QA_GATE + ["qa.notes.notes"],
}
# 화면이 없는 경로(parse_screen_routes 진단에서 "정본 누락"으로 세지 않는다): 리다이렉트 전용·정적 샘플·대응 API 없음
NON_DATA_ROUTES = {"/standard/answer-analysis", "/projects/[id]/analysis", "/website/answer-analysis", "/standard/ai-funnel", "/website/ai-funnel",
                   "/projects/[id]/ai-funnel", "/projects/[id]/intent", "/customer-interest", "/admin/standards", "/login", "/no-access",
                   "/customer-interest/social-scraping"}
_ROOTS = r"(?:dashboard|standard|website|projects|admin|raw-data-qa|customer-interest)"
# 경로 토큰: 선택적 app/[locale]/ 접두, 선택적 선행 '/', 알려진 최상위 세그먼트(괄호 묶음 '(standard)'·'·' 대안 허용), 이후 세그먼트.
# 세그먼트 문자에 '{a,b}' 대안·'{id}' 매개변수·'[id]'·'*'·'·'·'(dash)' 를 포함한다.
# 거르는 것: 파일 경로(…/(dash)/admin/page.tsx: 앞 경계가 '/'·')'·']' 이면 시작 불가, 뒤에 '.확장자'가 붙으면 버림),
# 점 표기 식별자(dashboard.summary.label), 문장 속 단어(선행 '/' 없는 한 세그먼트는 문자열 맨 앞일 때만 경로로 본다).
_ROUTE_RE = re.compile(r"(?<![\w./\-)\]])((?:app/\[locale\]/)?/?)(\(?" + _ROOTS + r"\)?(?:·" + _ROOTS + r")*(?:/[\w\-\[\]{},*·()]+)*)")
_CONT_RE = re.compile(r"\s*/([\w\-*]+)(?=[\s,)]|$)")
_BAD_PAREN = re.compile(r"\((?!\w+\))")     # '(standard)'·'(dash)' 같은 온전한 묶음이 아닌 '(' 부터는 설명문이다


def _expand(route: str) -> list[str]:
    """세그먼트 단위 대안 전개: '{a,b}'·'a·b' → 두 경로, '{id}' → '[id]', '(standard)' → 'standard', '(dash)' 제거."""
    outs = [[]]
    for seg in route.strip("/").split("/"):
        if not seg:
            continue
        if seg == "(dash)":
            continue
        m = re.fullmatch(r"\{([\w,]+)\}", seg)
        if m and "," in m.group(1):
            alts = m.group(1).split(",")
        elif m:
            alts = [f"[{m.group(1)}]"]
        elif "·" in seg:
            alts = seg.split("·")
        else:
            alts = [re.sub(r"^\((\w+)\)$", r"\1", seg)]
        outs = [o + [a] for o in outs for a in alts if a]
    return ["/" + "/".join(o) for o in outs]


def parse_screen_routes(s: str) -> list[str]:
    """단위 screens 문자열 하나 → 프론트 경로 목록(중복 제거, 순서 유지). '(간접)' 서술은 소비처 설명이라 제외한다.
    쉼표 뒤 단일 세그먼트('…/citation, /mention')는 직전 경로의 마지막 세그먼트를 바꾼 형제 경로로 읽는다."""
    if s.strip().startswith("(간접)"):
        return []
    found: list[str] = []
    for m in _ROUTE_RE.finditer(s):
        lead, raw = m.group(1), m.group(2)
        cut = _BAD_PAREN.search(raw)
        end = m.start(2) + (cut.start() if cut else len(raw))
        raw = raw[:cut.start()] if cut else raw
        comma = raw.endswith(",")
        raw = raw.rstrip(",;:")
        while raw.endswith(")") and raw.count(")") > raw.count("("):
            raw = raw[:-1]
        if re.match(r"\.\w", s[end:]):                         # 파일(page.tsx)·점 표기 식별자
            continue
        if not lead and "/" not in raw and m.start() != len(s) - len(s.lstrip()):
            continue                                         # 문장 속 단어 'website 표면' 등
        bases = _expand(raw)
        found += bases
        rest = s[end:]
        while True:                                          # 쉼표 형제 경로: "/a/b/citation, /mention, /x"
            if not comma:
                cm = re.match(r"\s*,", rest)
                if not cm:
                    break
                rest = rest[cm.end():]
            c = _CONT_RE.match(rest)
            if not c or re.fullmatch(_ROOTS, c.group(1)):
                break
            found += [b.rsplit("/", 1)[0] + "/" + c.group(1) for b in bases]
            rest, comma = rest[c.end():], False
    return list(dict.fromkeys(r.rstrip("/") or "/" for r in found))


units = {}
for f in os.listdir(MOD):
    if re.match(r"^[A-Z]+-\d", f) and f.endswith(".json"):
        d = json.load(open(os.path.join(MOD, f), encoding="utf-8")); units[d["id"]] = d
alias = {"G-1": "GEO-1"}
fids_all = {f["id"] for f in features}
unknown = sorted({(r, x) for r, xs in VIEWS_CANON.items() for x in xs if x not in fids_all})
assert not unknown, f"정본 화면표에 없는 기능 id: {unknown}"
dup = {r: [x for x in xs if xs.count(x) > 1] for r, xs in VIEWS_CANON.items() if len(set(xs)) != len(xs)}
assert not dup, f"정본 화면표 중복 기능: {dup}"
views = {r: sorted(VIEWS_CANON[r]) for r in sorted(VIEWS_CANON)}

# 교차 확인(진단 출력만): 단위 screens 파싱 결과 중 정본에 없는 (화면, 기능) 쌍
parsed: dict[str, set[str]] = defaultdict(set)
for uid, u in units.items():
    fid = [f["id"] for f in features if alias.get(uid, uid) in f["units"] or uid in f["units"]]
    for s in u.get("screens") or []:
        for route in parse_screen_routes(s):
            if route.endswith("/*"):                         # '/standard/answer-analysis/*' = 그 아래 정본 화면 전부
                pre = route[:-1]
                for r in views:
                    if r.startswith(pre):
                        parsed[r].update(fid)
            else:
                parsed[route].update(fid)
diag_routes = sorted(r for r in parsed if r not in views and r not in NON_DATA_ROUTES)
diag_pairs = sorted((r, x) for r, xs in parsed.items() if r in views for x in xs if x not in views[r])
out = {"features": [{k: v for k, v in f.items() if k != "rx"} for f in features], "excluded": excluded, "views": views}
json.dump(out, open(os.path.join(HERE, "taxonomy.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
n_ep = sum(len(f["endpoints"]) for f in features)
print(f"(펼침 후 카탈로그 {len(cat)}) categories {len(T)} · domains {sum(len(d) for _, _, d in T)} · features {len(features)} · endpoints {n_ep} + excluded {len(excluded)} = {n_ep + len(excluded)} / catalog {len(cat)} · views {len(views)} · pairs {sum(len(v) for v in views.values())}")
print(f"[진단] screens 파싱 경로 {len(parsed)} · 정본 밖 데이터 화면 {len(diag_routes)} {diag_routes}")
print(f"[진단] 파싱은 배정했지만 정본이 뺀 (화면, 기능) {len(diag_pairs)}:")
for r, x in diag_pairs:
    print(f"  {r} {x}")
