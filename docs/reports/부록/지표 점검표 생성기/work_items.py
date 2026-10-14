"""Documented refactoring work items (docs 01·03·13·14·16–24) linked to checklist screens and factors.

Each item: (id, title, docs, targets, status, factors)
- targets: screen routes (exact, as in the checklist) or a layer tag starting with "@" (not a screen).
- factors: checklist factors that judge it. "밖:<reason>" = outside the checklist (tracked here only).
Source: doc-vs-checklist gap review 2026-10-14 (71 items).
"""

D = "/ko/dashboard"
MEN = "/ko/standard/answer-analysis/mention"
CIT = "/ko/standard/answer-analysis/citation"
QA_D = "/ko/raw-data-qa/answers/[jobId]"
QA_L = "/ko/raw-data-qa/answers"
CONV = ["/ko/standard/ai-funnel/conversion", "/ko/website/ai-funnel/conversion", "/ko/projects/[id]/ai-funnel/conversion"]
ACR = ["/ko/standard/ai-funnel/acr", "/ko/website/ai-funnel/acr", "/ko/projects/[id]/ai-funnel/acr"]

WORK = [
    ("W01", "QA 저장 실패(401·422·500·네트워크) 표시 · 입력 유지", "16 · 03 SW04 · 17", [QA_D], "완료", ["F7"]),
    ("W02", "QA 잠금 확인 전·실패·상실, heartbeat 실패 시 읽기 전용", "16 · SW09 · 17", [QA_D], "완료", ["F7"]),
    ("W03", "QA 중복 저장 차단 · 늦은 응답 무시 · 15초 timeout · 쓰기 자동 재시도 없음", "16", [QA_D], "완료", ["F7"]),
    ("W04", "실서비스 저장·잠금·화면 이동 검증, 노트 생성·수정 오류 처리", "16", [QA_D, "/ko/raw-data-qa/notes"], "미완", ["F7"]),
    ("W05", "SW01 표준 프롬프트: 50행 표시인데 전체 조회·전송 → 서버 페이지 50행, 내보내기 500행 묶음", "03 · 16 · 17", ["/ko/standard/prompts"], "완료", ["F9", "F1"]),
    ("W06", "SW02/03 관리 프롬프트: 전체 DOM 렌더 · 1만 건 상한 → 서버 조회 + 가상 렌더", "03 · 17", ["/ko/admin/standards/prompts"], "완료", ["F9"]),
    ("W07", "SW02/03/05 프로젝트 프롬프트: 2만 건 상한 · 일괄 태그 부분 저장 → 페이지 조회, ID 전체 선택, 1,000건 부분 성공 구분", "03 · 17", ["/ko/projects/[id]/prompt"], "완료", ["F9", "F7"]),
    ("W08", "SW06/07/15 GA4 설정 실패 → 기본 keyEvents, 부분 실패 합계 캐시, 호출당 30초", "03 · 16 · 17", CONV, "완료(legacy, mock 검증)", ["F6"]),
    ("W09", "대시보드 GA4 ⑦: 조회하지만 대시보드는 KPI 5종만 그림", "17 · 24", [D], "legacy 수정", ["F8"]),
    ("W10", "프로젝트 홈 GA4 ⑦ 카드(SummaryTiles)", "17", ["/ko/projects/[id]"], "완료", ["F6"]),
    ("W11", "SW08 관리 조회 실패를 빈 목록으로 표시 → 오류 표시", "03 · 17", ["/ko/admin/standards/citation-sources", "/ko/admin/standards/entities"], "완료", ["F6"]),
    ("W12", "SW14 키워드 캐시: DB 오류 1회로 재시작 전까지 비활성 → 30초 후 복구", "03 · 17", ["/ko/projects/[id]/intent/google-keyword", "/ko/customer-interest/google-keywords", "/ko/admin/keyword-tools"], "완료", ["F6"]),
    ("W13", "SW10–13 공통 워커(DFS 고착 · Scope ID 없는 완료 · daily 재시도 · pull 지연)", "03 · 17", ["@ingest"], "사본 반영", ["밖:back/ingest 범위 밖"]),
    ("W14", "프런트 전체 검사 기존 실패 88개", "17 · 23 · 24", ["@test"], "미완", ["밖:테스트 기반"]),
    ("W15", "next dev → next start: JS 15–27MB → 0.7–1.5MB", "17", ["@build"], "완료(로컬)", ["F1"]),
    ("W16", "GA4·키워드 캐시 수정의 API 경로 운영 검증 없음", "17", CONV + ["/ko/customer-interest/google-keywords"], "미검증", ["F5", "F6"]),
    ("W17", "Scope 보류 행 전용 경보 없음 · 결과 불명 운영 복구", "17", ["@ingest"], "미완", ["밖:back/ingest 범위 밖"]),
    ("W18", "읽기 API 4개(POST …/screen) + 스키마 10개 추가 · 백엔드 먼저 배포", "18", ["@api", "/ko/standard/prompts", "/ko/admin/standards/prompts", "/ko/projects/[id]/prompt"], "코드 완료 · 배포 미완", ["F10"]),
    ("W19", "실 Supabase env 재빌드 · HGH_API_BASE_URL · HGH_SOURCE_SESSION/G1~G7 설정", "18", ["@deploy"], "미완", ["완료"]),
    ("W20", "HGH_JWKS_URL·issuer·audience, JWT 사용자 ↔ DB 활성 계정·권한 연결", "18", ["@auth"], "미완", ["F10"]),
    ("W21", "대상 DB 스키마·권한·데이터, en-x-icu/ko-x-icu 확인", "17 · 18", ["@db"], "미완", ["밖:DB 환경"]),
    ("W22", "의도적 오류 처리 변경(QA 저장·잠금, 대량 태그 부분 저장, Scope 재전송·재시도) — 허용 차이로 기록", "18", [QA_D, "/ko/projects/[id]/prompt"], "완료", ["F5", "F7"]),
    ("W23", "운영 서버 버전·env·DB·실제 인증·외부 응답 미검증", "18 · 23 · 24", ["@deploy"], "미완", ["F1", "F5", "완료"]),
    ("W24", "19[1] 표준·관리 프롬프트 목록: 매 조회 총건수·DISTINCT 옵션·관리자 통계 → 24[3]", "19 · 24", ["/ko/standard/prompts", "/ko/admin/standards/prompts"], "해소", ["F8"]),
    ("W25", "19[2] 프로젝트 프롬프트: 총건수·열 표시·초안 수 매번 집계, 태그 후보 무제한 DISTINCT, 깊은 OFFSET·사용자 정의 필드 정렬", "19 · 24[4]", ["/ko/projects/[id]/prompt"], "태그 완료 · 나머지 미완", ["F8", "F9"]),
    ("W26", "19[3] 대시보드 KPI fetch_counts·prompt_counts 새로고침마다 재계산", "19 · 24", [D], "미완", ["F3", "F1"]),
    ("W27", "19[4] HGH_RESULT_CACHE 기본 0, /screen 4개는 허용 목록 밖, 적중률 미확인", "19 · 20 · 24", ["@cache"], "미완", ["F1"]),
    ("W28", "결과 캐시 무효화(적재·검수·설정 변경)·권한 키 검증 후 활성화 판단", "19 · 24", ["@cache"], "미완", ["F10", "밖:캐시 무효화"]),
    ("W29", "19[5] 소셜 스크래핑 500건×20페이지, truncated 버림 → 23[1]", "19 · 23", ["/ko/projects/[id]/intent/social-scraping", "/ko/customer-interest/social-scraping"], "완료", ["F9", "F6"]),
    ("W30", "19[6] Google 키워드 4페이지·2천 건 잘린 목록 → 23[2]", "19 · 23", ["/ko/customer-interest/google-keywords", "/ko/projects/[id]/intent/google-keyword"], "완료", ["F9", "F6"]),
    ("W31", "19[7] 사실 행 합산 SQL의 스캔량·정렬·인덱스를 운영 규모로 검증", "19 · 20", ["@db"], "미완", ["F2", "F1"]),
    ("W32", "19 완료 판정: 첫·반복·필터 변경·깊은 페이지·동시 요청, 실행계획, 지연 분포, 응답 크기, 캐시, 동등성", "19", ["@all"], "미완", ["F1", "F5", "F9"]),
    ("W33", "J01 요약 KPI·엔진별 (대시보드·웹사이트·프로젝트)", "20 · 22", [D, MEN, "/ko/website", "/ko/projects/[id]"], "미완", ["F2", "F3"]),
    ("W34", "J02 언급 brands/types — API는 적재 열 합산", "20 · 22", [MEN, D], "API 반영", ["F2", "F3"]),
    ("W35", "J03 인용 도메인: 한 페이지여도 전체 모집단을 접고 순위", "20 · 22 · 24", [CIT, D], "미완", ["F2", "F3", "F9"]),
    ("W36", "J04 톤별 인용 / J06 인용·미인용 프롬프트", "20 · 22", [CIT, "/ko/standard/answer-analysis/citation/tone-urls", "/ko/standard/answer-analysis/citation/prompts"], "미완", ["F2", "F3"]),
    ("W37", "J05 카테고리·유형 JOIN 폴백, 같은 요청 최대 3번 집계", "20 · 22", [CIT], "미완", ["F3", "F8"]),
    ("W38", "J07 ACR: 한 요청에서 여러 지표 SQL", "20 · 22 · 24", ACR, "미완", ["F8", "F2"]),
    ("W39", "J08 GA4 전환: 카드 요청도 페이지별 집계, 결과 캐시 허용 목록 밖 → 24[2]", "20 · 24", [D, "/ko/projects/[id]"] + CONV, "카드 완료 · 페이지 집계 미완", ["F8", "F3"]),
    ("W40", "J09 GEO / J10 추이·이전 기간 비교", "20 · 22", [D, MEN, CIT, "/ko/website"], "미완", ["F2", "F3"]),
    ("W41", "J11 자사·타겟 URL 인용률 / J12 프로젝트 퍼널 분포", "20 · 22", ["/ko/website", "/ko/projects/[id]"], "미완", ["F2", "F3"]),
    ("W42", "J13 QA 진행률 scoped·total 두 호출 → 24[1]", "20 · 24", [QA_L], "일부 완료", ["F8"]),
    ("W43", "J14 소셜 context map (대조군: 핵심 값 사전 계산)", "20 · 22", ["/ko/customer-interest/social-scraping"], "해당 없음", ["F3"]),
    ("W44", "실행계획 검증(실제 행·반복·버퍼·디스크, 경로·프로필·캐시 기록)", "20", ["@db"], "미완", ["F1", "F2"]),
    ("W45", "22 반복 실행: S05 3회 재시도 · S08 세션/전환/페이지별 · S13 두 호출", "22", [CIT, QA_L] + CONV, "일부 완료", ["F8"]),
    ("W46", "S16 도메인 상세 7 JOIN·9 CTE / 언급 프롬프트", "22", [CIT, MEN], "미완", ["F2", "F3"]),
    ("W47", "S17 적용·측정·미측정 / 필터 모수", "21 · 22", [D, MEN, CIT], "미완", ["F3"]),
    ("W48", "21 stat.* 사전 집계 S01–S17 (읽기 쪽)", "21 · 24", ["@all"], "설계안", ["F2", "F3", "F5"]),
    ("W49", "21 stat.build/release 원자 공개·멱등 재시도·late data·세대 혼합 방지", "21", ["@worker"], "설계안", ["밖:적재 파이프라인"]),
    ("W50", "21 갱신 트리거·적재 경계(동료와 확정 필요)", "21 · 24", ["@ingest"], "설계안", ["밖:back/ingest 범위 밖"]),
    ("W51", "21 QA 카운터를 검수 쓰기와 같은 트랜잭션에", "21", [QA_D, QA_L], "설계안", ["F7", "F8"]),
    ("W52", "21 권한으로 못 나누는 상위 합계 미노출 · 권한 철회 즉시 · 캐시 키에 권한 범위 버전", "21", ["@api", "@cache"], "설계안", ["F10"]),
    ("W53", "21 필수 동등성 사례(모수·관점·발행·ACR·GA4·쓰기·권한·성능)", "21", ["@all"], "설계안", ["F5", "F7", "F10"]),
    ("W54", "21 실측 확정: 활성 프로필·live 지연·데이터량·p95·재빌드 시간", "21", ["@ops"], "미완", ["F1"]),
    ("W55", "23[1] in_candidate_pool 응답 필드, 후보 조회 최대 20회 → 0회", "23", ["/ko/projects/[id]/intent/social-scraping"], "완료(로컬)", ["F8", "F10"]),
    ("W56", "23[2] Google 키워드 끝까지 읽기, 100페이지 상한 초과 시 실패", "23", ["/ko/customer-interest/google-keywords", "/ko/projects/[id]/intent/google-keyword"], "완료", ["F9", "F6"]),
    ("W57", "경합 시에만 남는 차이(legacy·API 타이밍, 진입 시점 메타) — 허용", "23 · 24", ["@all"], "수용", ["F5"]),
    ("W58", "24[1] QA 진행률 2문장 → 1문장", "24", [QA_L], "완료", ["F8"]),
    ("W59", "24[2] include_pages=false (카드 호출)", "24", [D, "/ko/projects/[id]"], "완료", ["F8", "F10"]),
    ("W60", "24[3] include_meta=false · reuseCatalogMeta (12,000행 내보내기 약 75문장 절감)", "24", ["/ko/standard/prompts", "/ko/admin/standards/prompts"], "완료", ["F8"]),
    ("W61", "24[4] include_values=false · reuseProjectValues", "24", ["/ko/projects/[id]/prompt"], "완료", ["F8", "F9"]),
    ("W62", "204e5e7 /screen operation id 복구 · 계약 시험 기대값", "24", ["@api"], "완료", ["F10"]),
    ("W63", "인수 시점 back 실패 5개 (ingest 4, views_index 1)", "24", ["@test"], "유지", ["밖:테스트 기반"]),
    ("W64", "24 남은 작업: 대시보드 KPI·인용 도메인·ACR 조회 시 집계", "24", [D, CIT] + ACR, "미완", ["F3"]),
    ("W65", "접근 감사 로그 유실 가능(누락 없는 보존 요구 시 별도 과제)", "03 · 13", ["@ops"], "조건부", ["밖:감사·관측"]),
    ("W66", "Next.js legacy + FastAPI 두 구현 동시 유지 → 안정화 후 legacy 읽기 경로 제거", "13 · 21", ["@all"], "미완", ["완료"]),
    ("W67", "app 단방향 동기화 Q15 · GA4 신규 공급 공백 · Scope outbox 매핑", "13", ["@ingest"], "미완", ["밖:back/ingest 범위 밖"]),
    ("W68", "저장됨·반영 대기·반영 실패 작업 상태 표시", "13", ["@write"], "설계안", ["밖:화면 변경(내부 리팩토링 규칙과 충돌)"]),
    ("W69", "/healthz {ok:true}만 · CI 미가동 · middleware가 /api 제외", "13 · 01", ["@ops"], "미완", ["밖:관측·CI·보안(D 보류)"]),
    ("W70", "문서 14 기준선: 모든 읽기 API cold p95 ≤ 1초 · 데이터 10배 · 발행 후 반영 ≤ 20분", "14", ["@all"], "참고", ["F1"]),
    ("W71", "문서 01 §6 1단계: 보안 4건 · CI 이식 · 배포 경로 · 환경 변수 · 감시 최소선", "01", ["@ops"], "미완", ["밖:보안·CI·배포(D 보류)"]),
]
