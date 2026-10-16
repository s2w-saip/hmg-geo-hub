"""점검표 화면 항목 → 메달리온(브론즈 · 실버 · 골드 · 화면) 진행 현황 md. 회의 기록 레포 progress/README.md 로 공유한다.

행: 화면 × 항목. 항목은 둘이다.
  지표 = 조사 데이터/visible_applicability.json 의 profile 'metric'(계산된 지표·건수·비교 값). 같은 화면의 카드·증감·기간 비교 칩·
         대표 지표는 한 지표로 묶는다(NORM_SUFFIX).
  기능 = 점검표 화면 영역 중 지표 행이 없고 파이프라인 데이터를 보여 주는 영역(추이·순위·분포·드릴다운·모달 등, PIPE_API).
         집계 없이 실버를 그대로 읽는 목록·모달은 골드 대상이 아니다(—).
  나머지 영역(앱 데이터·정적 표본·쓰기·필터·화면 밖 경로)과 화면 없는 API 는 '메달리온 밖'에 적어 빠진 기능이 없음을 보인다.
레이어: 회의 기록 레포 20261015 설계 회의와 용어집 '메달리온' 기준. 브론즈 = 원천 복제(수집팀), 실버 1 = 결정적 정제,
  실버 2 = LLM 분석, 골드 = 화면 항목 KPI 계산. 항목마다 필요한 브론즈·실버 데이터셋은 데이터 계열(FAMILIES)로 정했다
  (2026-10-16, 그 화면 API 가 읽는 rd·ext 열 기준. 감정·멘션 유형 = 언급 감정 분류, 답변 브랜드 스탠스는 어느 행도 쓰지 않는다).
사람이 바꾸는 칸: 데이터셋 표의 파이프라인 표·flag·확인, 화면별 항목 표의 골드·화면·확인. 항목 행의 브론즈·실버와 집계는 계산한다.
  다시 만들 때 바꾼 칸은 데이터셋 이름, (화면, 항목) 으로 옮긴다. 허용하지 않은 flag 나 옮길 자리가 없는 값이 있으면 실패한다.
점검표에 새 지표·영역이 생기거나 이름이 바뀌면 분류가 비어 실패한다: FAMILY_OF·OUTSIDE·FEATURE_* 를 고치고 다시 실행한다.
사용: python -I kpi_pipeline_flags.py "<회의 기록 레포>/progress/README.md"
"""
import html
import json
import os
import re
import sys
from collections import Counter, OrderedDict

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
SURVEY_ORDER = ["existing3", "global", "website", "project", "project_ops_interest", "admin", "qa_nonscreen"]
MENU_NOTE = r"\s*\((?:메뉴 숨김[^)]*|beta|하위 페이지|SNB 숨김[^)]*|EcatNav[^)]*|api 전용|GNB 밖)\)"  # build_checklist.py 와 같은 정리
TOP_ORDER = ["Global", "Website", "Project", "Admin"]
NORM_SUFFIX = (" · KPI 카드", " · 증감 표시", " · 기간 비교 칩", " · 요약 카드", " · 대표 지표", " · 건수", " · 순위 표시",
               " 증감", " 카드", " 타일", " 탭 카운트", " 배지", " 주석")
TODO, WIP, DONE, NA = "⬜", "🟡", "🟢", "—"
FLAGS = (TODO, WIP, DONE)
SEC_ROWS, SEC_DS = "화면별 항목", "데이터셋"
A_LINK = "../20261015/01_architecture.md"

# 데이터 이름 → (레이어, 내용). 이름에 ' · ' 를 쓰지 않는다(목록 구분자).
DATASETS = OrderedDict([
    ("답변 원문", ("브론즈", "측정 프롬프트 × 엔진 × 국가 × 회차의 답변 본문 · 인용 소스 목록 · 프롬프트 문안")),
    ("ACR 답변 원문", ("브론즈", "ACR 2턴 반복 측정 답변 본문")),
    ("프롬프트 원천", ("브론즈", "원천 프롬프트 목록 동기화")),
    ("GA4 리포트", ("브론즈", "GA4 속성별 세션 · 전환 · 입구 페이지 리포트. 속성이 연결되지 않은 시장은 지금 화면이 가상 표본을 보여 준다")),
    ("키워드 원천", ("브론즈", "검색량 · 연관 검색어 · SERP 수집(DataForSEO)")),
    ("소셜 원문", ("브론즈", "커뮤니티 수집 원문")),
    ("답변 정제", ("실버 1", "답변 품질 판정(빈 답변 · 거절 · 오류 제외), 유효 답변 · 측정 셀 · 회차 확정")),
    ("프롬프트 매핑", ("실버 1", "원천 프롬프트 ↔ GEO HUB 프롬프트 연결, 글로벌 · 사이트 · 프로젝트 단위 배정")),
    ("인용 정규화", ("실버 1", "인용 URL · 도메인 정규화, 출처 카테고리 판정")),
    ("자사/타겟 URL 매칭", ("실버 1", "자사 도메인 · Owned base · 타겟 URL 매칭")),
    ("GA4 AI 유입 분류", ("실버 1", "유입 소스 → AI 엔진 매핑, 시장 · 권역 매핑")),
    ("키워드 정규화", ("실버 1", "검색어 정규화, 월별 검색량 정리")),
    ("브랜드 언급 추출", ("실버 2", "언급 추출 · 해소 · 브랜드 롤업. 답변별 브랜드 언급 수, 경쟁 순위, 텍스트상 첫 등장 순서"
                                  "(국가별 GEO 현황의 우선 노출도가 쓴다)")),
    ("언급 감정 분류", ("실버 2", "언급별 긍정 · 부정 · 중립, 멘션 유형")),
    ("ACR 최종 선택 판정", ("실버 2", "2턴 최종 선택 판정, 브랜드 · 모델별 1순위 · Top5 · 후보군 집계")),
    ("구매 맥락 추출", ("실버 2", "소셜 원문 → 구매 맥락 · 구매 조건 · 관계 · 조합")),
])
LAYERS = ["브론즈", "실버 1", "실버 2"]

# 데이터 계열 → (브론즈, 실버)
_ANS_B, _ANS_S = ("답변 원문", "프롬프트 원천"), ("답변 정제", "프롬프트 매핑")
FAMILIES = OrderedDict([
    ("답변", (_ANS_B, _ANS_S)),
    ("언급", (_ANS_B, _ANS_S + ("브랜드 언급 추출",))),
    ("언급+감정", (_ANS_B, _ANS_S + ("브랜드 언급 추출", "언급 감정 분류"))),
    ("인용", (_ANS_B, _ANS_S + ("인용 정규화",))),
    ("인용+자사", (_ANS_B, _ANS_S + ("인용 정규화", "자사/타겟 URL 매칭"))),
    ("인용+감정", (_ANS_B, _ANS_S + ("인용 정규화", "브랜드 언급 추출", "언급 감정 분류"))),
    ("언급+인용", (_ANS_B, _ANS_S + ("브랜드 언급 추출", "인용 정규화"))),
    ("KPI 전체", (_ANS_B, _ANS_S + ("브랜드 언급 추출", "언급 감정 분류", "인용 정규화", "자사/타겟 URL 매칭"))),
    ("ACR", (("ACR 답변 원문", "프롬프트 원천"), _ANS_S + ("브랜드 언급 추출", "ACR 최종 선택 판정"))),
    ("GA4", (("GA4 리포트",), ("GA4 AI 유입 분류",))),
    ("키워드", (("키워드 원천",), ("키워드 정규화",))),
    ("소셜", (("소셜 원문",), ("구매 맥락 추출",))),
    ("프롬프트 연결", (("프롬프트 원천",), ("프롬프트 매핑",))),
    ("엔티티", (("답변 원문",), ("답변 정제", "브랜드 언급 추출"))),
    ("도메인", (("답변 원문",), ("답변 정제", "인용 정규화"))),
])

# ── 지표 → 계열 ──
_F = {
    "답변": ["측정 프롬프트 수", "영향받는 답변 수", "필터 기준 답변 수"],
    "언급": ["AI 노출률", "AI 점유율", "AI 우선 노출도", "Top 3 노출 비율", "경쟁사 SOV 비교",
            "헤드투헤드 비교(당사 합산 vs 자동 SOV 1위·수동 선택)", "전체 언급 수", "언급 브랜드 수", "미언급 프롬프트 수",
            "복수 언급 답변 수", "영향받는 언급 수"],
    "언급+감정": ["AI 우호도", "AI 우호도 · 긍정 신호 비율", "AI 우호도 · 부정 신호 비율", "긍정 신호 수", "부정 신호 수",
               "긍정 키워드 언급 수", "부정 키워드 언급 수"],
    "인용": ["공식(HMG) 인용 비중", "딜러·마켓 인용 비중", "전체 인용 수", "인용 도메인 수", "출처 분류 수", "인용 프롬프트",
            "미인용 프롬프트", "영향받는 인용 수"],
    "인용+자사": ["AI 인용 점유율", "공식 (당사) 인용 비중", "자사 URL 인용률", "타겟 URL 인용률", "AI 타겟 출처 인용률",
               "공식(당사) URL 인용 프롬프트", "공식(당사) URL 미인용 프롬프트", "Owned base 인용 프롬프트", "Owned base 미인용 프롬프트"],
    "인용+감정": ["긍정 답변에 인용된 URL", "부정 답변에 인용된 URL", "긍정 답변 인용 URL", "부정 답변 인용 URL"],
    "ACR": ["Top1 ACR", "Top5 ACR", "답변 수", "1순위 횟수", "측정 셀 수", "측정 반복 수"],
    "GA4": ["AI 유입 전환율", "일반 유입 전환율", "전환 격차", "ChatGPT 전환", "Gemini 전환", "AI 유입 사이트 방문 수 · 방문 수",
            "AI 유입 사이트 방문 수 · 순 방문자", "AI 유입 사이트 방문 수 · 방문 빈도", "권역·본사 · AI 유입 전환율",
            "권역·본사 · 일반 유입 전환율", "권역·본사 · 전환 격차"],
    "키워드": ["평균 관심도", "발견 검색어 수", "키워드 수", "평균 검색량", "총 검색량", "고볼륨", "중볼륨", "저볼륨"],
    "소셜": ["구매 맥락 수", "구매 조건 수", "관계 수", "출처 도메인 수", "상세 언급 수"],
    "프롬프트 연결": ["연결되지 않은 프롬프트 수"],
    "엔티티": ["전체 엔티티 수", "자사 엔티티 수"],
    "도메인": ["도메인 수"],
}
FAMILY_OF = {m: fam for fam, ms in _F.items() for m in ms}
# 화면 경로가 지표 이름보다 우선한다: ACR 화면의 측정 프롬프트 수는 ACR 측정 규모다.
ROUTE_FAMILY = (("/ai-funnel/acr", "ACR"),)
SCREEN_NOTE = {"/ko/website/ai-funnel/acr": "화면은 정적 표본(데이터 조회 없음)"}

_APP = ["사용자 수", "프로젝트 수", "총 프로젝트", "활성 멤버", "최근 7일 신규", "실행 대기/중인 프롬프트", "프롬프트", "후보 풀",
        "실행 대기 수", "전체 프롬프트 수", "표시 프롬프트 수", "총 프롬프트 수", "사용 중 프롬프트 수", "미추적 프롬프트 수",
        "ACR 프롬프트 수", "변경 건수", "불변 건수", "미매칭 건수", "숨김 변경 수", "교정 도메인 수", "필터 기준 검수 완료 수",
        "검수 완료율", "이상 답변 수", "노트 수", "전체 검수 완료 수", "답변 노트 수", "프롬프트 노트 수", "멘션 노트 수",
        "인용 노트 수", "ACR 노트 수", "메타 노트 수", "전체 노트 수"]
OUTSIDE = {m: "앱 데이터: GEO HUB 백엔드가 app 스키마에서 관리" for m in _APP}
OUTSIDE.update({m: "표시 방식: 같은 KPI 의 이전 기간 값이라 그 KPI 골드에 포함" for m in ("기간 비교 표시", "전월 대비 표시")})

# ── 기능(영역) ──
# 영역 분류: 지표 행 있음 → 지표 / 쓰기 → 쓰기 / 정적 표본 → 정적 / 필터·메타 → 필터 / PIPE_API 호출 → 기능 / 나머지 → 앱
PIPE_API = ("/v1/kpi", "/v1/trend", "/v1/mentions", "/v1/citations", "/v1/answers", "/v1/geo", "/v1/funnel/acr", "/v1/funnel/conversion",
            "/v1/intent/insight", "/v1/intent/related", "/v1/intent/social/context-map", "fetchContextMapPage", "/v1/qa/answers",
            "/entities/{entity_id}/mentions", "/v1/prompts?surface=website", "/v1/admin/keyword-tools/volume")
WRITE_PROFILES = {"mutation", "export", "local_export", "write_feedback"}
META_PROFILES = {"options", "control", "metadata", "fixed_options"}
STATIC_API = re.compile(r"API 없음|^없음|픽스처|정적 표본")
# 규칙으로 못 가르는 영역: (경로, 영역) → 계열
FEATURE_FAMILY_FIX = {("/ko/dashboard", "경쟁사 미니 행 (카드 ①~④)"): "언급+감정"}  # 카드 ③ 우호도 포함
# 집계가 있어도 목록·검수 화면이라 골드 대상이 아닌 영역
FEATURE_NO_GOLD = {("/ko/raw-data-qa/answers/[jobId]", "낱알 패널(프롬프트·멘션·인용·ACR·메타 블록, 블록별 판정 토글·미해결 노트 수)"),
                   ("/ko/projects/[id]/analysis/mention", "신호 프롬프트 다이얼로그"),
                   ("/ko/admin/keyword-tools", "생성 프롬프트 표(원 입력·질문·검색 의도·검색량)")}
# 화면에서 호출하지 않는 API(front 에는 타입 정의만 있다, 2026-10-16 확인)
API_ONLY = [
    ("회차 관제", "GET /v1/admin/cycles · /{cyc_key}, POST close · hide · unhide, PUT view-date", "회차 진행률(rd.cycle · rd.job) 조회 · 마감 · 숨김 · 노출일"),
    ("job 운영", "GET /v1/admin/jobs/{job_id}/registry, POST anchor-pin · drop", "답변 job 앵커 고정 · 드롭"),
    ("답변 목록", "GET /v1/answers", "답변 목록 조회"),
    ("인용 출처 유형", "GET /v1/citations/sources/types", "멘션 유형별 출처 카테고리"),
]


def feature_family(label: str, api: str) -> str:
    if "/v1/funnel/acr" in api:
        return "ACR"
    if "/v1/funnel/conversion" in api:
        return "GA4"
    if "context-map" in api or "fetchContextMapPage" in api:
        return "소셜"
    if "/v1/intent/" in api or "/v1/admin/keyword-tools" in api:
        return "키워드"
    if "/v1/qa/answers" in api:
        return "언급+인용"
    if "/v1/admin/entities" in api and "/mentions" in api:
        return "엔티티"
    if "/v1/prompts?surface=website" in api:
        return "답변"
    if "/v1/geo" in api:
        return "언급+감정"
    if "/v1/citations" in api and ("/v1/mentions" in api or "mention_brand" in api or "/v1/answers/" in api):
        return "언급+인용"
    if "/v1/answers/" in api:
        return "언급+인용"
    if "/v1/citations" in api or re.search(r"dimension=(source|category)", api):
        if "tone" in api:
            return "인용+감정"
        if "owned" in api or "competitor_sources" in api:
            return "인용+자사"
        if "멘션 유형" in label:
            return "인용+감정"
        if "by_funnel" in api:
            return "언급+인용"
        return "인용"
    if "/v1/trend" in api and ("card=true" in api or "METRICS" in api) and "dimension" not in api:
        return "KPI 전체"
    if re.search(r"types|유형|감정|신호|signal|engines|일관성", api + label):
        return "언급+감정"
    return "언급"


def norm(label: str) -> str:
    for suf in NORM_SUFFIX:
        if label.endswith(suf):
            return label[: -len(suf)].strip()
    return label.strip()


def cell(text: str) -> str:
    return text.replace("|", "/")


def fail(msg: str) -> None:
    raise SystemExit(f"progress 생성 실패: {msg}")


def roll(flags: list) -> str:
    return DONE if all(f == DONE for f in flags) else TODO if all(f == TODO for f in flags) else WIP


# ── 화면(메뉴 경로) · 영역 ──
_ns: dict = {}
exec(open(os.path.join(HERE, "screens_def.py"), encoding="utf-8").read(), _ns)
screens = [{"menu": s["menu"], "route": s["route"], "areas": [(a[1], a[4]) for a in s["areas"]]} for s in _ns["SCREENS"]]
for key in SURVEY_ORDER:
    p = os.path.join(HERE, "조사 데이터", key + ".json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            screens += [{"menu": s["menu"], "route": s["route"], "areas": [(a["label"], a["api_call"]) for a in s["areas"]]}
                        for s in json.load(f).get("screens", [])]
menu_of: "OrderedDict[str, str]" = OrderedDict()
areas_of: "OrderedDict[str, list]" = OrderedDict()   # 경로 → [(영역, API)]
offscreen: list = []                                 # 화면 밖 경로(크론·미들웨어·BFF)
for s in screens:
    if s.get("route") in ("—", "", None):
        offscreen += [label for label, _ in s["areas"]]
    elif s["route"] not in menu_of:
        menu_of[s["route"]] = re.sub(MENU_NOTE, "", s["menu"].replace(" › ", " > "))
        areas_of[s["route"]] = s["areas"]

with open(os.path.join(HERE, "조사 데이터", "visible_applicability.json"), encoding="utf-8") as f:
    all_items = json.load(f)["items"]
items = [i for i in all_items if i["profile"] == "metric"]
area_profiles: dict = {}
for i in all_items:
    area_profiles.setdefault((i["route"], i["source_label"]), set()).add(i["profile"])

# ── 지표 행 ──
rows: "OrderedDict[tuple, dict]" = OrderedDict()   # (경로, 항목) → {kind, fam, gold}
outside: "OrderedDict[str, list]" = OrderedDict()  # 지표 → 화면들
area_metrics: dict = {}                            # (경로, 영역) → [지표]
unmapped, unclassified, seen = set(), [], set()
for i in items:
    if i["route"] not in menu_of:
        unmapped.add(i["route"])
        continue
    m = norm(i["label"])
    seen.add(m)
    area_metrics.setdefault((i["route"], i["source_label"]), []).append(m)
    if m in OUTSIDE:
        if menu_of[i["route"]] not in outside.setdefault(m, []):
            outside[m].append(menu_of[i["route"]])
        continue
    fam = next((fm for key, fm in ROUTE_FAMILY if key in i["route"]), None) or FAMILY_OF.get(m)
    if fam is None:
        unclassified.append(m)
        continue
    rows.setdefault((i["route"], m), {"kind": "지표", "fam": fam, "gold": True})
stale = sorted(m for m in list(FAMILY_OF) + list(OUTSIDE) if m not in seen)
both = sorted(set(FAMILY_OF) & set(OUTSIDE))
if unmapped or unclassified or stale or both:
    fail(f"화면 없음={sorted(unmapped)} 미분류={unclassified} 점검표에 없음={stale} 중복 분류={both}")

# ── 영역 분류 · 기능 행 ──
area_kind: "OrderedDict[tuple, str]" = OrderedDict()
for r, areas in areas_of.items():
    for label, api in areas:
        profs = area_profiles.get((r, label), set())
        ms = area_metrics.get((r, label), [])
        if any(m not in OUTSIDE for m in ms):
            kind = "지표"
        elif any(OUTSIDE[m].startswith("앱") for m in ms):
            kind = "앱"
        elif ms:  # 표시 방식 지표만 있는 기준일 · 필터 바
            kind = "필터"
        elif label.startswith("쓰기") or (profs and profs <= WRITE_PROFILES):
            kind = "쓰기"
        elif "local_data" in profs or STATIC_API.search(api):
            kind = "정적"
        elif "/events" in api:  # GA4 Data API 실시간 조회
            kind = "앱"
        elif not profs or profs <= META_PROFILES:
            kind = "필터"
        elif any(k in api for k in PIPE_API):
            kind = "기능"
        else:
            kind = "앱"
        area_kind[(r, label)] = kind
        if kind == "기능":
            name = cell(label)
            if (r, name) in rows:
                fail(f"항목 이름 충돌: {menu_of[r]} / {name}")
            rows[(r, name)] = {"kind": "기능", "fam": FEATURE_FAMILY_FIX.get((r, label)) or feature_family(label, api),
                               "gold": bool({"collection", "derived"} & profs) and (r, label) not in FEATURE_NO_GOLD}
fix_stale = [k for k in list(FEATURE_FAMILY_FIX) + list(FEATURE_NO_GOLD) if area_kind.get(k) != "기능"]
if fix_stale:
    fail(f"FEATURE_* 의 영역이 기능 영역이 아님(점검표 이름이 바뀌었는지 확인): {fix_stale}")
unknown_ds = sorted({d for b, s in FAMILIES.values() for d in b + s if d not in DATASETS})
unused_ds = sorted(set(DATASETS) - {d for v in rows.values() for d in sum(FAMILIES[v["fam"]], ())})
unknown_fam = sorted({v["fam"] for v in rows.values()} - set(FAMILIES))
if unknown_ds or unused_ds or unknown_fam:
    fail(f"모르는 데이터셋={unknown_ds} 쓰이지 않는 데이터셋={unused_ds} 모르는 계열={unknown_fam}")


def order_key(route: str) -> tuple:
    """최상위 메뉴 순(TOP_ORDER) → 점검표 순. 하위 페이지는 부모 화면 바로 뒤."""
    menu, idx = menu_of[route], list(menu_of).index(route)
    top = menu.split(" > ")[0]
    parents = [list(menu_of).index(a) for a in menu_of if a != route and menu.startswith(menu_of[a] + " > ")]
    return (TOP_ORDER.index(top) if top in TOP_ORDER else len(TOP_ORDER), min(parents + [idx]), idx)


route_order = sorted(dict.fromkeys(r for r, _ in rows), key=order_key)

# ── 사람이 바꾼 칸 옮기기 ──
kept_ds: dict = {}
kept_row: dict = {}
if os.path.exists(OUT):
    section = screen = None
    with open(OUT, encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            if line.startswith("## "):
                section, screen = line[3:].strip(), None
                continue
            mm = re.match(r"<summary><b>(.+?)</b>", line)
            if mm:
                screen = html.unescape(mm.group(1))
                continue
            if not line.startswith("|"):
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if cells[0] in ("데이터", "항목") or cells[0].startswith("---"):
                continue
            if section == SEC_DS and len(cells) == 6:
                if cells[4] not in FLAGS:
                    fail(f"{ln}행 데이터셋 '{cells[0]}' flag '{cells[4]}' (허용: {' '.join(FLAGS)})")
                kept_ds[cells[0]] = (cells[3], cells[4], cells[5])
            elif section == SEC_ROWS and screen and len(cells) == 8:
                bad = [c for c in (cells[4], cells[5]) if c not in FLAGS + (NA,)]
                if bad:
                    fail(f"{ln}행 '{screen} / {cells[0]}' flag {bad} (허용: {' '.join(FLAGS)}, 골드 대상이 아니면 {NA})")
                kept_row[(screen, cells[0])] = (cells[4], cells[5], cells[7])
row_keys = {(menu_of[r], m): v for (r, m), v in rows.items()}
orphans = [k for k, v in kept_ds.items() if k not in DATASETS and v != ("", TODO, "")]
orphans += [" / ".join(k) for k, v in kept_row.items()
            if k not in row_keys and not (v[0] in (TODO, NA) and v[1:] == (TODO, ""))]
if orphans:
    fail(f"옮길 자리가 없는 값(이름이 바뀌었으면 새 이름 행에 직접 옮기고 다시 실행): {orphans}")
wrong_na = [" / ".join(k) for k, v in kept_row.items() if k in row_keys and row_keys[k]["gold"] and v[0] == NA]
if wrong_na:
    fail(f"골드 대상인데 골드 칸이 {NA}: {wrong_na}")

ds_state = {d: kept_ds.get(d, ("", TODO, "")) for d in DATASETS}
ds_flag = {d: v[1] for d, v in ds_state.items()}
fam_flag = {fam: (roll([ds_flag[d] for d in b]), roll([ds_flag[d] for d in s])) for fam, (b, s) in FAMILIES.items()}

# 행 상태
state: "OrderedDict[tuple, dict]" = OrderedDict()
for r in route_order:
    for (rr, m), v in rows.items():
        if rr == r:
            gold, scr, who = kept_row.get((menu_of[r], m), (TODO, TODO, ""))
            b, s = fam_flag[v["fam"]]
            state[(r, m)] = {**v, "b": b, "s": s, "g": gold if v["gold"] else NA, "scr": scr, "who": who}


def e2e(v: dict) -> bool:
    return all(f == DONE for f in (v["b"], v["s"], v["scr"])) and v["g"] in (DONE, NA)


def done(vals) -> str:
    vals = [x for x in vals if x != NA]
    return f"{sum(x == DONE for x in vals)} / {len(vals)}" if vals else NA


def wip(vals) -> int:
    return sum(x == WIP for x in vals)


# ── md ──
n_rows = len(state)
n_metric = sum(1 for v in state.values() if v["kind"] == "지표")
n_feature = n_rows - n_metric
lines = [
    "# KPI 메달리온 진행 현황", "",
    "GEO HUB 화면의 지표와 기능마다 브론즈 · 실버 · 골드 · 화면 반영이 어디까지 됐는지 flag 로 공유합니다. "
    f"레이어 구분은 [설계 회의]({A_LINK})와 [용어집](../glossary.md)의 메달리온 기준입니다.", "",
    "| 레이어 | 하는 일 | 담당 | flag 를 바꾸는 곳 |", "|---|---|---|---|",
    "| 브론즈 | 원천 복제 | 수집팀 | [데이터셋](#데이터셋) 표 |",
    "| 실버 1 | 결정적 정제: 본문 정리 · 주소 정규화 · 필터링 | 파이프라인 팀 | [데이터셋](#데이터셋) 표 |",
    "| 실버 2 | LLM 분석: 언급 · 감정 · ACR 판정 · 구매 맥락 | 파이프라인 팀 | [데이터셋](#데이터셋) 표 |",
    f"| 골드 | 화면 항목의 KPI · 집계 계산, 회차마다 자동 생성 | 협의 중: 골드 데이터 적재 방식 ([20261015/A04]({A_LINK}#a04)) | [화면별 항목](#화면별-항목) 표 |",
    "| 화면 | GEO HUB 화면에 연결하고 값 검증 | GEO HUB 팀 | [화면별 항목](#화면별-항목) 표 |", "",
    f"flag: {TODO} 시작 전 · {WIP} 진행 중 · {DONE} 완료 · {NA} 해당 없음. 항목 행의 브론즈 · 실버 칸은 그 항목에 필요한 데이터셋 flag 로 "
    f"계산합니다(전부 {DONE} 면 {DONE}, 하나라도 시작했으면 {WIP}). 집계 없이 실버를 그대로 보여 주는 목록 · 모달은 골드가 {NA} 입니다.", "",
    "## 진행 현황", "",
    f"| 레이어 | 단위 | {DONE} 완료 | {WIP} 진행 중 |", "|---|---|---|---|",
]
for layer in LAYERS:
    vals = [ds_flag[d] for d, (ly, _) in DATASETS.items() if ly == layer]
    lines.append(f"| {layer} | 데이터셋 | {done(vals)} | {wip(vals)} |")
lines.append(f"| 골드 | 골드 대상 항목 | {done(v['g'] for v in state.values())} | {wip(v['g'] for v in state.values())} |")
lines.append(f"| 화면 | 항목 | {done(v['scr'] for v in state.values())} | {wip(v['scr'] for v in state.values())} |")
lines.append(f"| **E2E** | 항목(모든 칸 {DONE}) | **{sum(e2e(v) for v in state.values())} / {n_rows}** | |")

lines += ["", "## 화면별 진행", "", f"{DONE} 인 항목 수입니다. 항목 = 지표 {n_metric} + 기능 {n_feature}.", "",
          "| 화면 | 항목 | 브론즈 | 실버 | 골드 | 화면 | E2E |", "|---|---|---|---|---|---|---|"]
for r in route_order:
    vs = [v for (rr, _), v in state.items() if rr == r]
    nm = sum(1 for v in vs if v["kind"] == "지표")
    lines.append(f"| {menu_of[r]} | 지표 {nm} · 기능 {len(vs) - nm} | " + " | ".join(done(v[k] for v in vs) for k in ("b", "s", "g", "scr"))
                 + f" | {sum(e2e(v) for v in vs)} / {len(vs)} |")

lines += ["", f"## {SEC_ROWS}", "",
          f"골드 · 화면 칸과 확인 칸만 바꿉니다. 확인 칸에는 `이름 · YYYY-MM-DD` 를 적습니다. 데이터 계열은 [데이터 계열](#데이터-계열) 표를 봅니다. "
          "기능 이름은 점검표 영역 이름 그대로입니다.", ""]
for r in route_order:
    vs = [(m, v) for (rr, m), v in state.items() if rr == r]
    note = f" · {SCREEN_NOTE[r]}" if r in SCREEN_NOTE else ""
    nm = sum(1 for _, v in vs if v["kind"] == "지표")
    lines += ["<details>",
              f"<summary><b>{html.escape(menu_of[r], quote=False)}</b> · 지표 {nm} · 기능 {len(vs) - nm}"
              f" · 골드 {done(v['g'] for _, v in vs)} · 화면 {done(v['scr'] for _, v in vs)}{note}</summary>", "",
              "| 항목 | 구분 | 브론즈 | 실버 | 골드 | 화면 | 데이터 계열 | 확인 (이름 · 날짜) |", "|---|---|---|---|---|---|---|---|"]
    lines += [f"| {m} | {v['kind']} | {v['b']} | {v['s']} | {v['g']} | {v['scr']} | {v['fam']} | {v['who']} |" for m, v in vs]
    lines += ["", "</details>", ""]

lines += ["## 데이터 계열", "", "항목 행의 브론즈 · 실버 칸은 아래 데이터셋 flag 로 계산합니다.", "",
          "| 계열 | 브론즈 | 실버 | 항목 |", "|---|---|---|---|"]
fam_rows = Counter(v["fam"] for v in state.values())
for fam, (b, s) in FAMILIES.items():
    if fam_rows[fam]:
        lines.append(f"| {fam} | " + " · ".join(f"{ds_flag[d]} {d}" for d in b) + " | "
                     + " · ".join(f"{ds_flag[d]} {d}" for d in s) + f" | {fam_rows[fam]} |")

lines += ["", f"## {SEC_DS}", "",
          "브론즈 · 실버 flag 는 여기서만 바꿉니다. `파이프라인 표` 칸에는 그 데이터를 담는 파이프라인 테이블 이름을 적습니다"
          f"(DB 스키마 · 테이블 설계 확정 ([20261015/A02]({A_LINK}#a02))).", "",
          "| 데이터 | 레이어 | 내용 | 파이프라인 표 | flag | 확인 (이름 · 날짜) |", "|---|---|---|---|---|---|"]
for d, (layer, desc) in DATASETS.items():
    table, flag, who = ds_state[d]
    lines.append(f"| {d} | {layer} | {desc} | {table} | {flag} | {who} |")

# 메달리온 밖
kinds = Counter(area_kind.values())
n_areas = sum(kinds.values())
app_areas = [(menu_of[r], cell(l)) for (r, l), k in area_kind.items() if k == "앱"]
static_areas = [(menu_of[r], cell(l)) for (r, l), k in area_kind.items() if k == "정적"]
n_out = sum(1 for m in outside if OUTSIDE[m].startswith("앱"))


def by_screen(pairs: list) -> list:
    grouped: "OrderedDict[str, list]" = OrderedDict()
    for menu, label in pairs:
        grouped.setdefault(menu, []).append(label)
    return [f"| {menu} | {' · '.join(labels)} |" for menu, labels in grouped.items()]


lines += ["", "## 메달리온 밖", "",
          f"점검표 화면 영역 {n_areas}개를 모두 나눴습니다: 지표 {kinds['지표']} · 기능 {kinds['기능']}(위 항목 행) · "
          f"앱 데이터 {kinds['앱']} · 정적 표본 {kinds['정적']} · 쓰기 · 내보내기 {kinds['쓰기']} · 필터 · 메타 {kinds['필터']}. "
          f"그 밖에 화면 밖 경로 {len(offscreen)}개와 화면에서 호출하지 않는 API {len(API_ONLY)}종이 있습니다.", "",
          "<details>", f"<summary>flag 없는 지표 {len(outside)}개: 앱 데이터 {n_out} · 표시 방식 {len(outside) - n_out}</summary>", "",
          "| 지표 | 화면 | 이유 |", "|---|---|---|"]
lines += [f"| {m} | {' · '.join(ms)} | {OUTSIDE[m]} |" for m, ms in outside.items()]
lines += ["", "</details>", "", "<details>",
          f"<summary>앱 데이터 기능 {len(app_areas)}개: GEO HUB 백엔드가 app 스키마에서 관리</summary>", "",
          "| 화면 | 기능 |", "|---|---|"] + by_screen(app_areas)
lines += ["", "</details>", "", "<details>",
          f"<summary>정적 표본 기능 {len(static_areas)}개: 화면이 데이터를 읽지 않음, 연결할 데이터 미정</summary>", "",
          "| 화면 | 기능 |", "|---|---|"] + by_screen(static_areas)
lines += ["", "</details>", "", "<details>",
          f"<summary>화면 밖 경로 {len(offscreen)}개 · 화면에서 호출하지 않는 API {len(API_ONLY)}종</summary>", "",
          "| 구분 | 항목 | 내용 |", "|---|---|---|"]
lines += [f"| 화면 밖 경로 | {cell(l)} | "
          + ("크론 · 내부 API" if l.startswith(("/api/cron", "/api/internal")) else "BFF" if l.startswith("/api/") else "인증 · 라우팅 · 기타")
          + " |" for l in offscreen]
lines += [f"| 화면 없는 API | {name} (`{eps}`) | {desc} |" for name, eps, desc in API_ONLY]
lines += ["", "</details>", "", "---", "",
          f"출처: 점검표 화면 표시 항목 중 지표 · 건수 · 비교 값 {len(items)}개를 화면 지표 {n_metric}개로 묶고(같은 화면의 카드 · 증감 · "
          f"기간 비교 칩 · 대표 지표는 한 지표), 지표 행이 없는 화면 영역 중 파이프라인 데이터를 보여 주는 {n_feature}개를 기능으로 넣었습니다. "
          "데이터 계열은 그 화면 API 가 읽는 데이터 기준입니다.",
          "이 파일은 hmg-geo-hub 레포 `docs/reports/부록/지표 점검표 생성기/kpi_pipeline_flags.py` 로 만듭니다. "
          "flag 를 바꾼 뒤 다시 만들면 집계가 갱신되고, 바꾼 칸은 데이터셋 이름과 (화면, 항목)별로 유지됩니다."]
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(lines) + "\n")
print(f"화면 {len(route_order)} · 항목 {n_rows}(지표 {n_metric} · 기능 {n_feature}) · 데이터셋 {len(DATASETS)} · 영역 {dict(kinds)} · "
      f"옮긴 값 데이터셋 {len(kept_ds)} · 행 {len(kept_row)}")
