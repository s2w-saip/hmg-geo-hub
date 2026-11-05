# 개발 TODO (정본) — Website · Admin

이 파일은 할 일과 기록이다. 규칙의 정본은 `CLAUDE.md`(마스터 룰)다. 순서는 사용자가 2026-10-29에 정했고, 2026-10-30에 Website 화면을 앞에 두었다. 바꾸려면 먼저 사용자에게 묻는다.

**지금 할 일:** Admin › 사용자 관리 결함 F12~F19를 심각도 순서대로 하나씩 고친다. 하나 고칠 때마다 보고하고 사용자 지시를 받은 뒤 다음으로 간다(사용자 2026-11-02). 다음은 F13(범위 교차)이다. 남은 일은 바로 아래 '할 일' 절에 모았다. 1절 F1~F4(마지막 검수의 18건)와 F5~F7은 2026-11-02 고쳤다(`e41ea10` · `9c69765`, F6의 hydration 건은 재현 안 됨). 바로 할 수 있는 것은 1절 결함 F8~F11과 2절 인사이트 개선 후보다. 3절은 사용자 결정, 4절은 업스트림 · 계정, 5절은 사용자 확인을 기다린다. Admin은 5단계(⛔D) · 6단계(⛔C)에서 멈춰 있다. '할 일' 0절 서비스 기준 주는 2026-11-03 만들었다(`a3b28e7`). 0절에는 기준 주가 선 뒤 고칠 것과 적대적 검증에서 남긴 하 지적 9건이 남았다. 3절 남은 결정(D-3 ~ D-5)은 그 뒤 한 건씩 정한다. Project는 2026-11-03 메뉴 D안(프로젝트는 새 탭)으로 목록과 프로젝트 탭 틀(`a216eb3`), P2 Dashboard(`431b440`), P3 Mention · Citation(`6b33377`), P4 Prompt(`e49aa05`), P5 AI Conversion(`9a20231`, GA4 계정 대기), Setting › General · Member 읽기 부분(`54be973`)을 만들었다. 같은 날 사용자가 레거시 대조 판정을 받아 D-6 · D-7을 정했다(결정 기록 'Project 입력 정본'). Project 입력 1단계로 프롬프트 · 커스텀 태그 편집을 만들었다(`41fa283`, 결정 기록 '프로젝트 프롬프트 적재'). Intent › Google Keyword · Social Scraping은 원본 화면을 샘플로 그리고 계정 막(U3)으로 덮었다(`e2de277`, 사용자 2026-11-03). 다음은 '할 일' 7절 2단계 Setting 입력(이름 · 설명 · 브랜드 · 국가 · 엔진 · 자사/추적 URL · 경쟁사 · GA4 속성)이다. 같은 날 인용 출처 분류 입력 네 종류에 프롬프트 같은 버전 표를 더했다(`9c86b1d`, 결정 기록 '인용 출처 버전'). 후속은 '할 일' 3절 D-8 · 4절 U10. 2026-11-05 사용자 확정 서비스 팔레트를 리뉴얼 화면 전체(`f58dbed`)와 원본 (dash) 화면 전체(`e88fce8`)에 적용했다(결정 기록 '서비스 팔레트' · '서비스 팔레트 — 원본 화면'). 같은 날 그라데이션 · 글래스를 모두 없앴다(`d5c13c5`, 결정 기록 '그라데이션 · 글래스 없음'). 같은 날 Admin 목록 여섯 화면에 50행 페이지를 붙였다(`df8b105`, 결정 기록 'Admin 목록 페이지'). 같은 날 Global Mention을 브랜드 상세 먼저로 바꿨다(`ef6e672`, 결정 기록 'Global Mention 브랜드 상세 먼저'). 팔레트 점검에서 나온 빠진 곳(원본 Tailwind 기본 색 · BFF가 보내던 색 · 어두운 면 글자 · sonner 토스트 · ACR 옛 선)도 같은 날 고쳤다(`0e3dd9f`, 결정 기록 '팔레트 빠진 곳').

## 할 일

2026-11-02 정리. 남은 일은 이 절이 전부다. 끝나면 줄을 지우고 진행 기록에 해시와 함께 적는다. 근거는 '근거 — 점검 · 검수 기록' 절의 같은 이름 묶음에 있다. Admin 단계(0 → 6)의 체크는 '단계' 절에서 한다.

**0. 서비스 기준 주 — 가장 먼저** (결정 기록 '발행 시점 판정', 2026-11-02)

- [x] HUB BE cron이 Gold 회차 상태 · 발행 상태 · 공개 버전을 지켜보다 Global · Website가 모두 완료된 가장 최근 월요일 시작 주를 서비스 기준 주로 올린다. 모든 화면은 그 주까지만 읽고, 달력 · 기간 선택도 그 뒤를 막는다. Gold 갱신이 지나치게 늦으면 FE에 보인다. 2026-11-03 만들었다(`a3b28e7`, 진행 기록 '서비스 기준 주').
- [ ] 기준 주가 선 뒤 고칠 것: Website Overview 모수(Gold 보고 유닛 게이트), ⑥ · 자사 · 타겟 URL 인용률의 발행 판정과 단위, 인용 URL 수의 '페이지 주 · URL 보조', 출처 선호 매트릭스 '전체' 열(결정 기록 같은 날 4줄).
- [ ] 적대적 검증에서 남긴 하 지적 9건(사용자 2026-11-03 '상 · 중만 고치기', 결정 기록 '적대적 검증 통과 기준'): ① 레이아웃의 기준 주 읽기가 실패한 뒤 다음 읽기가 성공해도 본문을 다시 읽지 않음 ② `design-rules.html`에 기준 주 칩 · 지연 안내 · 주별 안내 · '측정 없음' · '아직 보이지 않는 기간' 상태가 없음 ③ 기준 주가 바뀔 때 서랍이 닫히는지를 호출부 6곳마다 확인하는 시험 없음 ④ 기준 주를 처음 읽는 동안 Gold 연결을 쥔 채 기다림(기준 주를 쓰지 않는 읽기도 뒤에서 기다림) ⑤ 기준 주 뒤 기간의 Website Prompts가 측정 열을 숨기고도 그 열의 정렬은 그대로 둠 ⑥ `verify-data.sql`이 `current_service_week` 뷰의 쓰기 권한을 보지 않음 ⑦ 브랜드 · 국가를 고른 Website 화면에서 사이트 안내가 늦게 끼어들어 본문이 48px 밀림 ⑧ 지연 안내가 Gold에 회차가 없는 주라도 늘 바로 다음 주를 이름으로 댐 ⑨ 조용한 회차(숨김 · 대체 · stale)만 있는 표면의 판정 시험 없음.

**1. 결함 — 사용자가 '고쳐' 하면 바로 한다** (데이터 · 화면 원칙 안이고 Gold 값은 그대로다. 버그 수정 규칙을 따른다.)

| ID | 화면 | 할 일 | 근거 |
|---|---|---|---|
| F8 | 분석 화면 | 출처 카테고리 이름 · 순서를 HUB 코드표(`catalog.source_code`)에서 읽는다(지금은 코드 상수, 13개 같음) | 화면 · 코드 |
| F9 | 작은 것 | 답변 원문 창 스탠스 '당사'의 이름 비교 · Overview 기간 모드 인용 순위의 card · live 섞임 · `published.ga4_*` 뷰의 `hmg_data_external` 권한 잔재 · `rn-sidebar.tsx`의 `max-lg` 모바일 잔재 | 대전제 검수 |
| F10 | 정리 | `front/lib/kpi/period-compare*`와 그 시험 · 문구 키 3개 · 명세 사본의 억제 규칙 · `global-renewal-catalog.html` ACR 설명 · 점검 전부터 실패하는 원본 시험 3건 · 원본 Prompts 열람 범위 pill | 화면 · 코드 |
| F11 | 확인 | 레거시 정보 의심 4건을 원본과 대조한다(Global 추이 수집 공백 음영 · 서랍 프롬프트 표 정렬 · 경쟁사 표 전체 · 미측정 회차 수 · Website 유형 구성 경쟁사 건수) | 대전제 검수 |
| F13 | 사용자 관리 (중) | 범위가 브랜드 × 국가 교차로 풀린다. 권역 · 국가 담당은 브랜드를 하나만 고르게 한다(결정 기록 '범위 교차') | 사용자 관리 검수 |
| F14 | 사용자 관리 (하) | `hmg_account_editor`가 `password_hash`를 읽고 `global_role` · `user_credential`의 모든 열을 고친다. 최소 권한으로 줄인다(마이그레이션 · 아키텍처 문서) | 사용자 관리 검수 |
| F15 | 사용자 관리 (하) | 바꾼 것 없이 저장해도 버튼이 켜져 있고 '저장했습니다'가 뜬다. 편집 서랍은 Esc · 바깥 클릭에 입력을 잃는다 | 사용자 관리 검수 |
| F16 | 사용자 관리 (하) | 오류 문구: 잠금 대기 · 편집 연결 미설정도 'DB에 연결할 수 없습니다', 작업 중 401에 로그인 링크 없음, 서버 필드 오류(`login_taken`)에 입력칸 강조 없음, 충돌 안내가 편집 취소 뒤에도 남음, 생성 이력의 빈 줄('권역: — → —') | 사용자 관리 검수 |
| F17 | 사용자 관리 (하) | 문구: 임시 비밀번호 안내 세 번 반복, '시스템 관리자' · '최상위 관리자' 혼용, 범위 안내 '바로 적용'(실제로는 다음 요청부터), 권역 'Europe(W)' 영어, 이름 · 이메일 자리표시 '선택', '비밀번호 바꾼 때'가 관리자의 재설정 시각도 보임(F12 실제 흐름에서 발견) | 사용자 관리 검수 |
| F18 | 사용자 관리 (하) | 원본에서 뺀 기능(삭제, 운영 권한, vendor · website 역할, 전용 사이트 코드, 관리자가 아닌 계정의 '전체')을 결정 기록에 적는다 | 사용자 관리 검수 |
| F19 | 사용자 관리 (하, 추정 포함) | 쓰기 풀 acquire · `lock_timeout` 없음, 시각 포맷에 timeZone 없음, scrypt N=2^14, `set-admin`의 `ON CONFLICT(subject)`와 대소문자 무시 색인 어긋남, 운영 안내의 의견 메일이 자리표시 주소(`beta-notice.tsx:15`, 모든 리뉴얼 화면) | 사용자 관리 검수 |

**2. 인사이트 개선 후보 — 원칙 안, 사용자가 고르면 한다**

| ID | 할 일 | 근거 |
|---|---|---|
| I1 | Website ⑥ · 자사 · 타겟 URL의 '증감 미제공'을 Gold `url_prompt_cell`의 회차 · 기간 값으로 채운다 | 마지막 검수 |
| I2 | Citation 엔진 발견 · 매트릭스 엔진 열에 측정 프롬프트 수 · 국가를 붙인다(DeepSeek은 CN 284개뿐) | 마지막 검수 |
| I3 | Website Overview 출처 구성비 도메인 행에 Gold 자사 인용 수를 나란히 둔다(kia.com 83,061 중 37,559) | 마지막 검수 |
| I4 | 리뉴얼이 더한 반복을 뺀다: Website Overview 요약 '인용 출처' 카드, 시장 표 경쟁사 인용 점유율 칸(39개국 중 37곳 0.0%) | 마지막 검수 |
| I5 | 4칸 고정 발견: 값이 있는 발견을 순서 그대로 더 보인다(Website Citation '가장 크게 움직인 출처', Global Mention '순위 변화') | 마지막 검수 |
| I6 | 레거시 통합(없애지 않음): Website Mention 언급 브랜드 수 · 키워드 수, Prompts 12,729 세 곳, Citation 8,815의 두 분모, Website Overview 엔진 일관성 배지 → 엔진 표 | 마지막 검수 |

**3. 사용자 결정 — 값이 바뀌거나 새 원칙이 필요하다**

| ID | 정할 것 | 근거 |
|---|---|---|
| D-3 | 판단 필요 4건(매트릭스 '전체' 열은 2026-11-02 결정): ACR 기간 모드 Δ 없음 · Mention 요약 '{rank}위'(12개로 자른 표 안) · Website Overview 첫 요약의 '나빠진 것만' · AI Conversion 'coverage' 발견 늘 warn | 대전제 검수 |
| D-4 | Global 점수표 판단 7건(머리 KPI 유형 섞임 · 우호도 5위 구성 효과 · 순위 변별 없음 · Overview · Mention 겹침 · 딜러 타일 · ACR 단절 · Prompts 미측정 503). Overview 첫 · 둘째 안은 하지 않기로 했다. | Global 점수표 · Overview 검증 |
| D-5 | Mention 서랍: BFF 2,000행 요청 대 Gold 리더 상한 1,000 | 화면 · 코드 |
| D-8 | 버전 후속(결정 기록 '인용 출처 버전'): ① 프롬프트와 버전을 묶을지 따로 둘지(둘 다 `change_seq` 한 시점으로 읽힘) ② 시점 보기 · 두 시점 비교 · 되돌리기 화면을 만들지 ③ 같은 공통 구조인 고객 관심(키워드 · 소스) · 엔티티 역할에도 버전 표를 붙일지(이력 표만 있음, 데이터는 보지 않았다) | 2026-11-03 사용자 대화 |

**4. 업스트림 · 외부 — 사용자가 보내거나 받는다**

| ID | 기다리는 것 | 풀리면 할 일 |
|---|---|---|
| U1 | 업스트림 질문 초안 미발송(A1~A5 · B1~B8 · C1~C3 · D1~D10, `upstream-questions-2026-10-30.md`, D9 · D10은 2026-11-03 서비스 기준 주에서 추가). 초안에 아직 없는 것: D6에 덧붙일 '율은 답변 수 합' 대 발행값 정의, Overview 라벨 정의(`brandPresence` · 리스트 유형) | 질문마다 '답에 따라 HUB가 할 일' |
| U2 | ⛔H Gold `acr_cell_fact`의 website 행 | Website ACR(W5) |
| U3 | ⛔D DataForSEO · OpenRouter 계정 | Admin 5 키워드 도구 |
| U4 | GA4 계정 인계 | VM 수집 시작, AI Conversion 실제 숫자 대조, 직전 기간 빠진 날 '−'의 이유 안내 |
| U5 | ⛔C 명세(운영 웹 화면 캡처 · 설명), 운영 웹 계정 | Admin 6, D-1 (a) · (b) 대조 |
| U6 | 원본 운영 DB의 `standard_keywords` · `standard_sources` 행 | Admin 3 이관, 수집 소스 채널 값 |
| U7 | ACR 후속 P2 질문 발송, cell · fact family의 metric_version 혼재 | `acr-next-session.html` 2절 |
| U8 | Scope 측정 실행 경로(엔드포인트 · 인증 · 비용 상한) | 7절 4단계 측정 실행(초안 → Scope), 지금은 열쇠 |
| U9 | 원본 운영 DB `app.project` 130행(이름 · 설명 · 브랜드 · 국가 · 담당) | 7절 2단계의 처음 값, 없으면 빈 값에서 시작 |
| U10 | Gold가 어느 출처 분류 set(버전 · `change_seq`)을 회차에 적용했는지 남기는지(질문 초안에 아직 없음). 지금 '반영됨 / 반영 대기'는 값 비교라 회차와 버전이 이어지지 않는다 | 회차별 적용 버전 표시 |

**5. 사용자 확인 대기 — 끝난 작업**

- 인용 출처 분류 입력 버전 표(`9c86b1d`).
- Project 입력 1단계 프롬프트 · 커스텀 태그 편집(`41fa283`)과 BFF 경계 시험 수정(`c0ead38`).
- Project 메뉴 D안 P0 · P1(`a216eb3`): 목록, 프로젝트 탭 틀(하위 페이지 미구현), F20(범위 계정의 `gold/projects` 거부). 목업 `docs/design/ui/project-menu-mockup.html`은 구현이 기준이 된 뒤 지운다.
- Admin 2(`a36b835`) · 3(`53126de`) · 4(`bb34ac4`), 계정 대기 화면(`3043512`)
- Website W0~W6(`f28395f`)과 그 뒤 개편: Website Prompts(`86884ed`), Website Mention(`3127b6b`)
- 리뉴얼 점검 후속 1~16단계, Global Overview 0번(`77f0ec6`)
- VM 반영(Admin 0 계정 관리 등)은 사용자가 정한다.

**6. Project 읽기 화면** (결정 기록 'Project 메뉴', 2026-11-03 D안)

- [x] P0 메뉴 · 프로젝트 탭 틀, P1 목록(`a216eb3`): 메인 사이드바 'Project list' → `/renewal/projects`(Gold 값으로 구별), 행 → 이름 있는 프로젝트 탭 하나(`hgh-project`), 탭 사이드바 = 프로젝트 카드(⇅ 바꾸기) + 원본 프로젝트 메뉴, 'Project list'는 원래 탭(`hgh-main`). 관리자만(⛔J). 하위 페이지는 모두 미구현 안내.
- [x] P2 Dashboard(`431b440`): Website Overview 부품(KPI 8종 · 엔진별 비교 · 출처별 구성비 · 추이) + 프로젝트 현황(Gold 값, 후보 · 멤버 · 프롬프트 상태는 '데이터 없음'). BFF `projects/filters` · `as-of` · `dash-*`. project 필터(기간 · 측정 국가 · AI 엔진 · 커스텀 태그 `cf_*`, 국가 하나면 잠금)와 저장 키 `project-*`를 같이 만들었다.
- [x] P3 Analysis › Mention · Citation(`6b33377`): Mention은 Global 리뉴얼 본문(`mention/rn-*`, 프로젝트 프롬프트는 시장 질문이라 Website 본문이 아님), Citation은 `citation/project` renewal 변형 + 하위 화면 prompts · tone-urls. 모두 `ctx.surface=project`, Citation은 출처 축을 더하고 경쟁사 축은 없음(원본 그대로). 서랍 · 표는 원본 project 경로.
- [x] P4 Prompt(`e49aa05`): 프로젝트 프롬프트 목록 + 커스텀 태그 열(Gold `prompt_custom_value`, 열람 전용) · 측정 렌즈(국가 · 엔진 · 기간) · 검색 · 정렬 · 엑셀 · 상세. Website Prompts 본문은 사이트 열(브랜드 · 타겟 URL · 시장)에 묶여 있어 P1 목록과 같은 공용 목록 부품으로 만들었다. 원본의 쓰기와 상태는 7절 1단계(`41fa283`)에서 더했다.
- [x] P5 AI Conversion(`9a20231`): 리뉴얼 Conversion 본문 + `conversion/renewal`의 `ctx.project_id`(HUB 분석 리더의 기존 프로젝트 매핑: `ref.dim_project` 사이트 브랜드 · 국가 = 속성). Gold 프로젝트 행에는 브랜드 · 국가가 없고 GA4 속성도 아직 없어(U4) 샘플 막 · 사이드바 열쇠. 프로젝트 ↔ 속성을 명시로 잇는 입력은 D-7(원본 `app.project.ga4PropertyId`).
- [x] Intent › Google Keyword · Social Scraping 원형(`e2de277`, 사용자 2026-11-03 '원형은 만들되 백드랍으로 막아두자'): 원본 프로젝트 화면을 샘플 행으로 그리고 'DataForSEO · OpenRouter 계정 필요' 막(U3)으로 덮었다. 사이드바는 열쇠. 아무것도 읽지 않고 유료 API를 부르지 않는다. 실제 읽기 · 입력은 D-6대로 7절 3단계(결정 기록 'Intent 원형 막').
- [x] Setting › General · Member 읽기 부분(`54be973`): BFF `projects/settings`(Gold 식별자 · Scope 시장 설정(130개 모두 비어 있음) · 측정 국가 · 언어 · 엔진 · 회차 · 커스텀 태그 정의 · 타겟 URL 수), 원본 절 순서(일반 · Scope 연결 · AI 엔진 · 추적 대상 · 커스텀 태그), 운영 DB 값은 '데이터 없음'. Member는 Gold · HUB 어디에도 데이터가 없다.
- [x] 입력은 7절로 옮겼다(D-7 결정).

**7. Project 입력** (결정 기록 'Project 입력 정본' · '프로젝트 프롬프트 적재', 2026-11-03)

- [x] 1단계 프롬프트 · 커스텀 태그 편집(`41fa283`): HUB 카탈로그(`catalog.prompt` · `prompt_version`, 태그 열은 프로젝트 정의)가 정본, `data-012`(`project_version.recorded_by`, 계정 `hmg_project_editor`, 트리거 `project_editor_guard`), Gold 가져오기의 HUB 키 유지, BFF `/v1/hub/projects/{id}/prompts` · `prompt-tags` · `prompt-fields`, 화면 projects/prompts가 HUB 행 + Gold 측정 + 상태(반영됨 · 반영 대기 · Gold에만). 화면: 상태 탭 · 추가(줄마다 초안, 추가 뒤 초안 탭) · 태그 칸 · 선택 일괄 · 태그 열 추가/보관/복원 · 원문 · 언어(초안만) · 유형 · 중지/재개 · 삭제/복원 · 이력, 측정 실행은 열쇠(U8). 업스트림 C4(투영 원본을 외부 API로).
- [ ] 2단계 Setting 입력: 이름 · 설명 · 브랜드 · 국가 · 엔진 · 자사/추적 URL · 경쟁사 · 차종 · 별칭(Gold에 받는 표가 없으면 결정 E처럼 화면에 적음), GA4 속성 지정(원본 `app.project.ga4PropertyId`, '1 범위'의 제외 이유가 사라짐). 처음 값은 U9. 브랜드 입력이 생기면 당사를 그 브랜드의 Gold 관점으로 고를지 정한다(Gold가 가진 축 고르기).
- [ ] 3단계 Intent: Gold `kw_*` · `ctx_*` 읽기(전체 수집 안내) + 추적 키워드 입력. 지금 화면은 샘플 + 계정 막(`e2de277`)이라 읽기가 생기면 Gold 값 부분은 막을 걷고, 수집 · 생성만 U3까지 열쇠로 둔다. 원본의 관심도 지수(기간 최대 = 100) · 평균 관심도, 추천 프롬프트의 우선순위 · 유사도는 HUB가 계산하던 값이라 이때 데이터 원칙과 대조한다.
- [ ] 4단계 측정 실행(초안 → Scope, 아웃박스 쓰기만) · DataForSEO 수집(결과는 HUB 수집 저장소) · LLM 초안(후보 풀): U8 · U3 대기, 그 전까지 열쇠 + 샘플 막.
- [ ] 원본에서 아직 옮기지 않은 것: 프롬프트 엑셀 가져오기, 후보 풀(생성기가 4단계 뒤), 원본 분류 메타(브랜드 · 카테고리 · 유형, 4단계와 함께). 태그 완전 삭제는 옮기지 않는다(HUB는 지우지 않음).
- Member: 관리자 전용(⛔J) 유지, 만들지 않는다. 화면은 '데이터 없음' 그대로. 하위 페이지를 만들면 `renewal-pages.ts` `RENEWAL_PROJECT_PAGES`에 그 경로를 더한다.

**보류:** AI 가시성(메뉴 숨김, HUB 기준선 · 문턱이 많다). 메뉴를 다시 열 때 다룬다.

## 규칙 번호

절대 규칙은 2026-11-02 `CLAUDE.md`(마스터 룰)로 옮겼다. 이 파일과 `renewal-audit.md`의 '규칙 N'은 아래 절을 뜻한다.

| 옛 번호 | 내용 | `CLAUDE.md` |
|---|---|---|
| 규칙 1 | 순서 | 5절 |
| 규칙 2 | 결정 | 4절 |
| 규칙 3 | 작업을 마칠 때 이 파일 고치기 | 8절 |
| 규칙 4 | 범위 확인부터 시작 | 5절 |
| 규칙 5 | 데이터 원칙 | 1절 |
| 규칙 6 | 커밋 · 푸시 | 7절 |
| 규칙 7 | 화면 원칙 | 2절 |

## 공통 완료 기준 (페이지마다)

- [ ] 범위를 정해 사용자에게 보였다 (규칙 4).
- [ ] 저장이 필요하면 마이그레이션을 만든다. 그 표만 쓰는 전용 DB 역할을 최소 권한으로 둔다(`hmg_account_editor` 방식). Mac 네이티브 저장소에 적용하고 `verify` 를 통과한다.
- [ ] BFF에 `hub_stores` 모듈과 `/v1/hub/*` 라우트를 둔다. 관리자 전용이고, 쓰기는 advisory lock 안에서 한다. 변경 이력을 남긴다.
- [ ] BFF 시험(`back/bff/tests`) 전체를 통과한다. 기존 시험도 포함한다.
- [ ] `/renewal/admin/…` 화면을 만든다. 촘촘 레이아웃, 1920×915 기준, 한국어 문구, render 시험을 갖춘다.
- [ ] `RENEWAL_PAGES`(`renewal-pages.ts`), `route-policy.ts` 의 `/renewal/…` 항목, 사이드바 시험을 갱신한다.
- [ ] 프런트에서 `npm run test`, `npm run typecheck`, `npm run lint` 를 돌려 기준선보다 새 실패가 없다(`CLAUDE.md` 6절).
- [ ] 같은 커밋에서 `docs/architecture/hmg-geo-hub-architecture.html` 을 고친다. 대상은 그림, DB 연결 표, 쓰기 경로, 계정 표, '마지막 갱신' 줄이고, ERD는 `render_erd.py` 를 실행해 다시 그린다.
- [ ] Playwright e2e로 새 화면의 핵심 흐름(만들기, 고치기, 중지 등)을 실제 화면에서 한 번 확인한다. 문구 · 표시 · 필터처럼 단위 · render 시험으로 확인되는 작은 변경에는 e2e를 돌리지 않는다(2026-10-30 사용자).
- [ ] 시험을 통과하면 커밋 · 푸시한다 (규칙 6). 그 뒤 사용자가 확인한다.

## Website 화면 (병렬 세션)

2026-10-30 사용자 결정: Website 하위 화면을 Admin 3단계 이후보다 먼저 만든다. 화면마다 세션 하나씩 병렬로 한다. Admin 2단계 남은 일은 다른 세션에서 따로 진행 중이다. 그 세션의 파일(`citation-sources/` 화면, `source_lists.py`, `data-008.sql` 등)은 Website 세션이 고치지 않는다.

**데이터.** Gold website(surface 2) 발행 1,087건이 2026-10-29에 활성화됐다. 회차는 2026-07-03 ~ 10-09이고, website 프롬프트는 13,232개다. KPI · 언급 · 인용 셀과 website 전용 URL 인용 셀(`url_prompt_cell`)이 있다. ACR 셀(`acr_cell_fact`)에는 website 행이 없다(⛔H).

**지금 코드.** BFF에는 원본 website 화면이 쓰던 읽기가 있다. 리뉴얼 화면은 `ctx.surface=global`로 고정이다. 공용 필터(`renewal/_components/overview-filter-model.ts`)에는 website 축 구성이 없다. 원본 website 필터는 `components/dash/website-filters.tsx`다. 축은 사이트 국가 → 언어 → 엔진이고, 브랜드 통합은 관리자만 보며, 카탈로그 축은 없다.

| 세션 | 화면 (리뉴얼 경로) | 원본 | 읽는 BFF 화면 | 선행 | 상태 |
|---|---|---|---|---|---|
| W0 | 공통 토대 | `components/dash/website-filters.tsx` | `overview/filters` · `shared/panel-options` · `citation/filter-bar` (website) | 없음 | 끝, 커밋 · 푸시(`f28395f`), 사용자 확인 대기. 쓰는 법은 아래 W0 둘째 줄 |
| W1 | Overview (`/renewal/website`) | `(dash)/website/page.tsx` | `website/summary` · `summary-deferred` · `trend` · `composition` · `geo` | W0 필터 | 구현 · 시험 완료, 커밋 · 푸시(`f28395f`), 사용자 확인 대기 |
| W2 | Answer analysis › Mention (`/renewal/website/answer-analysis/mention`) | `(dash)/website/answer-analysis/mention` | `mention/view` · `mention/as-of` (ctx.surface=website) | W0 필터 | 구현 · 시험 완료, 커밋 · 푸시(`f28395f`), 사용자 확인 대기. 읽는 화면은 `mention/rn-*` · `view-cards` · `view-weekly` · `drill-missing-prompts`(세션 메모 W2) |
| W3 | Answer analysis › Citation (`/renewal/website/answer-analysis/citation`) | `(dash)/website/answer-analysis/citation` | `citation/filter-bar` · `citation/as-of` · `citation/website` | W0 필터 | 구현 · 시험 · e2e 끝, 커밋 · 푸시(`f28395f`), 사용자 확인 대기 |
| W4 | Prompts (`/renewal/website/prompts`) | `(dash)/website/prompts` | `website/prompts-options` · `website/prompts-list` | W0 필터 키 | 구현 · 시험 · e2e 끝, 커밋 · 푸시(`f28395f`), 사용자 확인 대기. 쪽 · 엑셀은 `website/prompts-page` · `-rows`(세션 메모 W4) |
| W5 | AI Agent Funnel › AI Conversion · ACR (`/renewal/website/ai-funnel/…`) | `(dash)/website/ai-funnel/*` | `conversion/renewal-header` · `conversion/renewal`(원본도 표준과 같은 화면) · `acr/gold` | ACR은 ⛔H | Conversion 구현 · BI 개편 · 시험 끝, 커밋 · 푸시(`f28395f`), 사용자 확인 대기 · ACR은 ⛔H까지 보류 |
| W6 | 디자인 다듬기 (W1~W5 화면 전부, 2026-10-30 사용자 요청) | — | 읽기 변경 없음 | W1~W5 구현 | 디자인 · 품질 검수 수정 · 시험 끝, 커밋 · 푸시(`f28395f`), 사용자 확인 대기. 세션 메모 W6 |

W1 · W2 · W3은 W0 필터가 끝나기 전에도 범위 확인, BFF 점검, 본문 작업을 먼저 한다. 필터는 W0 것을 붙인다. 화면마다 필터를 따로 만들지 않는다.

**W0 공통 토대**

- [x] 저장된 필터 화면 키를 한 번에 더한다: `website-overview` · `website-mention` · `website-citation` · `website-prompts` · `website-conversion` · `website-acr`. 고칠 곳은 BFF `hub_stores/saved_filters.py`의 `PAGES`와 `saved-filters.tsx`의 `SavedFilterPage`다. DB에는 형식 CHECK만 있어 마이그레이션은 없다. 2026-10-30에 넣었다(미커밋). 시험 `test_website_pages_keep_their_own_lists`는 고치기 전에 실패하고 고친 뒤 통과했다. 로컬 API를 다시 띄워 지금 쓸 수 있다. 화면은 `loadSavedFilters("website-…")`와 `savedFilters={{ page: "website-…" }}`로 쓴다.
- [x] 공용 필터 모델에 website 구성을 더한다. Overview · Mention · Citation 세 stage를 website 축으로 연다. 원본 `WebsiteFilters`와 같은지 parity 시험으로 묶는다. 2026-10-30에 했다(미커밋).
  - **W1~W3이 쓰는 법:** `RnOverviewFilters`의 `props`에 `surface: "website"`를 더한다. `stage`는 W1이 `"overview"`(생략 가능), W2가 `"mention"`, W3이 `"citation"`이다. 옵션은 원본과 같은 BFF 화면에서 받는다(W1 `overview/filters`, W2 `shared/panel-options` · `shared/filter-dates`, W3 `citation/filter-bar`, 모두 website). 저장된 필터는 `website-<화면>` 키를 쓴다.
  - 축은 국가(사이트 국가) · 언어 · AI 엔진 · 기간이다. 관리자는 브랜드가 더 보이고, Citation은 출처 카테고리가 더 붙는다. 카탈로그 · 경쟁사 축은 없다. 원본과 같다(`overview-filter-model.ts` `WEBSITE_ONLY_GROUPS`).
  - 원본과 하나 다르다. 원본 website Mention · Citation 패널은 계정 범위를 Global 기준으로 봤고, 리뉴얼은 세 화면 모두 원본 Overview처럼 Website 기준으로 본다. 차이는 전용 사이트 계정(Hyundai N 등)의 국가 잠금뿐이다.
  - 시험 `website-filter-model.parity.test.tsx` 32개: 원본 패널과 같은 구조로 통과한다. website 구성을 끄면 32개가 모두 실패한다. 기존 필터 · 화면 시험 12개 파일(117개), typecheck, lint, BFF 시험 33개 모듈(490개)도 통과했다.
- [x] 새 Gold 데이터로 위 표의 BFF 화면을 한 번씩 불러 본다. 5xx나 빈 값이 나오면 아래 '점검 결과'에 적고 그 화면 세션에 넘긴다.

**병렬 규칙**

1. 세션은 첫 지시로 받은 W 번호 하나만 맡는다. 사용자가 'W1 시작'처럼 번호만 말해도 그 행을 맡으라는 뜻이다. 되묻지 않고 범위 확인부터 시작한다(규칙 4). 첫 답변은 '지금 할 일' 줄, 맡은 행(W 번호와 화면), 원본 화면 기능 목록 순서로 쓴다.
2. 고칠 수 있는 파일은 셋이다.
   - 자기 화면 폴더 `renewal/website/<화면>/`.
   - 재사용하는 표준 화면의 `_components`. W1은 `renewal/dashboard/_components`, W2는 `renewal/standard/answer-analysis/mention/_components`, W3은 `…/citation/_components`, W5는 `renewal/standard/ai-funnel/conversion` · `acr`의 `_components`. 표준 화면 동작은 그대로 두고 시험으로 확인한다.
   - 그 화면의 BFF website 분기. W1은 `screens/overview.py`의 website_*, W2는 `mention_*.py`의 website 분기, W3은 `citation.py`의 website 부분, W4는 `website_prompts.py`, W5는 `acr.py`의 `acr/gold`.
3. 공통 코드는 W0만 고친다: `renewal/_components/*`, `components/dash/*`, `components/renewal-ui*`, BFF `_filters.py` · `_query.py` · `shared.py` · `hub_stores/saved_filters.py`. 다른 세션은 필요해도 고치지 않고 사용자에게 말한다.
4. 공유 목록에는 자기 줄만 더하고, 고치기 직전에 다시 읽는다: `renewal-pages.ts`, `route-policy.ts`의 `/renewal/website…` 항목, `rn-sidebar.render.test.tsx`, `messages/ko.json` · `en.json`, `[...slug]/page.tsx`의 `FIRST_CHILD`. 새 문구는 `renewal.website.<화면>` 아래에 둔다.
5. 로컬 실행(front 3333, API 5555)은 하나를 같이 쓴다. BFF를 고친 세션은 API를 다시 띄운다. 그동안 다른 세션 화면이 잠깐 끊긴다.
6. 시험은 자기 화면 시험, `npm run typecheck`, `npm run lint`를 돌린다. 다른 세션 파일에서 난 실패는 고치지 않고 진행 기록에 적는다. BFF를 고쳤으면 커밋 전에 BFF 시험 전체를 돌린다.
7. 원본 website 화면과 같은 BFF 화면을 읽으므로 숫자가 같아야 한다. 같은 필터로 원본(`/ko/website/…`)과 한 번 대조한다.
8. 커밋 · 푸시는 규칙 6대로 시험을 통과하면 한다. 자기 파일과 공유 파일의 자기 줄만 올린다(`git add -p`). `git fetch`를 먼저 한다.
9. 이 파일에서는 자기 행의 상태 칸, '세션 메모'의 자기 줄, 진행 기록 한 줄만 고친다. '지금 할 일' 줄은 Website 전체가 끝날 때 고친다.
10. 완료 기준은 '공통 완료 기준' 중 읽기 화면에 맞는 것이다: 범위 확인, render 시험, 메뉴 · 경로 · 사이드바 시험, test · typecheck · lint, BFF를 고쳤으면 BFF 시험 전체, 핵심 흐름 e2e 한 번(필터 바꾸기, 드릴다운), 사용자 확인. 저장소 · `hub_stores` · 아키텍처 문서는 구조나 BFF 라우트를 바꿀 때만 해당한다.

**세션 메모** (세션마다 자기 줄만)

- W2 · W3: `mention-body.tsx` · `citation-body.tsx`의 다른 작업 변경('순위 변화' 제목 '최근 N회차')은 2026-10-31 따로 커밋했다(`911a7d3`).
- W0: 2026-10-30 레거시 필터 대조 뒤 사용자 지시('추천대로 진행')로 세 가지를 맞췄다. 다른 W 세션의 파일도 고쳤으니 커밋 때 함께 본다.
  - Mention 비교 브랜드 '자동' = 레거시 규칙(스냅샷 점유율 1위 외부 브랜드, `mention_surfaces.comparison_of`). Gold 리더 추이에 `pin_top_rival`(상위 10 밖이면 그 브랜드를 `pinned`로 더함)을 더했고, 리뉴얼 Mention의 KPI 브랜드 추이 읽기가 모두 이것을 쓴다(`mention_renewal.py`, `mention_data.py`의 `pin_top`, `_trend.py`). 경쟁사 평균선과 순위 변화 차트는 상위 10 그대로다. website 필터 없음 Toyota → Tata, 독일 Volkswagen(레거시와 같음). Global은 Toyota 그대로. golden `mention/rn-fix-*` · `rn-live-*` 18개는 요청 키만 바꿨다(출력 같음, golden README).
  - AI Conversion 국가 선택지 = 계정이 읽을 수 있는 GA4 속성의 국가(중지 제외, 브랜드로 좁힘). 새 읽기 `analytics/properties`(`analytics_reader.properties`, `api.py`), `conversion.py property_options`. Gold Global 옵션 읽기는 뺐다. 선택지가 없으면 공용 패널이 국가 축을 숨긴다(URL에 국가가 남아 있으면 지울 수 있게 둔다). Global · Website 둘 다다.
  - 인용 하위 화면 2개(website)에 적용 필터 칩. `website/answer-analysis/citation/_shared/website-citation-filters.tsx`(메인 화면의 옵션 함수도 이리 옮김). 칩을 빼면 목록이 처음부터 다시 읽힌다: 공용 `RnFilterRuntime reset`이 쪽 · 커서를 지우고, 긍정/부정 URL은 검색어도 지운다(검색 중 탭 개수 재사용 규칙). Global 하위 화면은 그대로다.
- W5: 2026-10-30 사용자 결정(추천안). Conversion은 표준 리뉴얼 화면을 그대로 쓴다. 같은 BFF 화면 · 본문 · 필터(기간 + GA4 축, 국가는 측정 로케일 목록)이고 BFF는 고치지 않았다. ACR은 ⛔H가 풀릴 때까지 만들지 않는다(원본도 메뉴에서 숨김, website 행 0개, ACR website 필터에는 W0 구성이 더 필요). 경로 정책 행은 두지 않았다. 새 행은 W0 전용 `components/dash/sidebar.tsx`의 아이콘 표가 필요하고, '/renewal/x = x' 규칙이 원본 권한을 그대로 준다(`route-policy.test.ts`에 대응 한 줄). 커밋은 W0의 `website-conversion` 키(미커밋)에 기대고, `rn-sidebar.render.test.tsx`의 미구현 표시 개수 줄(12 → 11)은 다른 W 세션도 고치는 줄이다. 같은 날 BI 개편(사용자 요청, 추천안): 같은 GA4 데이터라 공용 본문(`standard/ai-funnel/conversion/_components`)을 고쳐 Global · Website 리뉴얼 AI Conversion에 함께 적용했다. 다른 W 세션이 쓰지 않는 BFF `screens/conversion.py` · `hub_stores/analytics_reader.py`도 고쳤다(리더는 응답 항목만 늘림, 기존 값 그대로).
- W1: 2026-10-30 사용자 결정(추천안, 완료까지 추천안으로 진행). 원본 구성(카드 내용 · 출처 · 전환, KPI 추이, 출처별 구성비, 시장별 현황)을 리뉴얼 부품으로 다시 그렸고 같은 BFF 화면을 읽는다(화면 코드는 그대로, 공용 리더만 아래처럼 고쳤다). 카드는 website 분석 화면(Mention · Citation · AI Conversion)을 새 탭으로 연다. 시장별 현황은 리뉴얼 Overview 표(`GeoOverview`)를 쓰되 원본처럼 점유율로 시작하고, 권역 없는 묶음(콜롬비아 · CPO · 유럽 연합 · MIDDLEEAST · worldwide)은 그 표의 '권역 미분류'로 보인다. 브랜드를 하나 고르기 전에는 관리자에게만 고르라는 안내가 보인다. 경쟁사 대비 SOV(41067.2% vs Tata)는 정의대로 계산된 값이라 그대로 보인다. 타겟 출처 인용률은 카드 값(답변 단위, `url_prompt_cell`)과 Δ · 추이(인용 단위, `kpi_cell`)가 서로 다른 측정이었다. 사용자 지시('남기지 말고 다 해')로 공용 리더 `gold_reader/metrics.py`를 고쳤다. website · project 추이의 URL 지표 3개(타겟 출처 · 자사 URL · 타겟 URL 인용률)도 카드와 같은 `url_prompt_cell` 값을 읽는다. 기간 비교에는 이 지표가 없다. 영향은 `website/trend`와 `website/summary-deferred`의 Δ뿐이고, 원본 `/website`도 같이 바뀐다. 2026-10-09 회차 전체 기준 추이 마지막 점은 22.8% → 65.3%(= 카드), Δ는 +4.6pp → +1.4pp다. 경로 정책 행은 두지 않았다(W5와 같음, `route-policy.test.ts`에 대응 한 줄). 2026-10-30 사용자 요청 'SSS급 BI 개편(정보 유실 없이, 없는 정보 증강만 금지)'으로 화면을 다시 짰다. 순서는 KPI(핵심 요약 4줄 + 카드) → HMG 브랜드별 비교(관리자, 브랜드 미선택) → 엔진별 비교 | 출처별 구성비 → KPI 추이(지표마다 작은 차트 6개 + 회차별 답변 수 · 공백) → 시장별 현황(지도 + 지표 5개 · 답변 · 당사 순위 · 선두 브랜드 한 표)이다. 새 BFF 화면 `website/brands`(브랜드마다 summary-deferred를 따로 읽음)와 `website/engines`(엔진 간 일관성 배지가 쓰는 kpi/engines 행)는 Gold 값을 펼칠 뿐이다. 최고 · 최저는 지표 방향만 따르고, 핵심 요약은 섹션 값을 다시 적을 뿐 임계값을 쓰지 않는다. 브랜드 · 엔진 · 국가 행을 누르면 필터 패널 토글로 그 조건이 걸린다. 레거시에서 빠졌던 시장 당사 순위 · 선두 브랜드와 수집 공백 표시(회차 줄)도 되살렸다. 아키텍처 문서의 'screens 빌더 88개'는 이미 HEAD(86)와 다르고 여러 W 세션이 화면을 더하고 있어, 커밋 시점에 실제 수로 맞춘다.
- W2: 2026-10-30 사용자 결정(추천안, 완료까지 추천안으로 진행). 리뉴얼 Global Mention(본문, BFF `mention/rn-*`)을 ctx.surface=website로 쓴다. 그래서 읽는 화면은 위 표의 `mention/view`가 아니라 `mention/rn-*`다. 2026-10-30 사용자 지시: 기존 KPI는 변형은 되지만 없애지 않는다. 정보를 잃지 않고 인사이트를 주도록 개편하되, 없는 정보를 만들지 않는다. 그래서 원본 website 값을 모두 남기고 세 가지를 더했다.
  - KPI 세부 지표('이번 회차 요약' 아래): 원본 요약 카드 6개와 감정 카드의 긍정 · 부정 신호 수를 설명하는 KPI 탭 아래로 묶었다(노출률: 측정 · 미언급 프롬프트, 점유율: 전체 언급 · 언급 브랜드 · 복수 언급 답변, 우호도: 긍정 · 부정 신호, 우선 노출도: Top 3 비율). 묶음 제목을 누르면 그 탭이 열린다. 값 · Δ · 기준일은 BFF `mention/view-cards`(`mention_surfaces.py`, 원본과 같은 읽기)다.
  - 미언급 프롬프트 목록(새 드릴다운): 미언급 수를 누르면 그 구성원(측정 − 언급 프롬프트, 카드와 같은 `kpi_cell` 조건)과 프롬프트별 답변 수 · 답변 속 브랜드 언급 합(`answer_fact.ment_total`)이 나오고, '다른 브랜드 언급 / 브랜드 언급 없음'으로 나뉜다. 프롬프트를 누르면 답변 원문이 열린다. Gold 리더 `mentions/missing-prompts`(`gold_reader/drilldown.py`, `readers.py` 한 줄), BFF `mention/drill-missing-prompts`, 프록시 `/api/scope/missing-prompts`(`_drill/proxy.ts`의 화면 목록 한 줄). 목록 길이는 카드 수와 같다(필터 없음 836, 미국 150, 미국+2026-09 0, Gemini 1,053).
  - 주별 브랜드 언급 수(브랜드 상세 끝): 원본 주간 Top10 추이를 브랜드마다 자기 눈금의 선, 최근 주 언급, 직전 주 대비로 보이고, 표로 보기에서 모든 주의 값을, CSV로 내보내기를 준다. BFF `mention/view-weekly`.
  - 표준 본문에는 빈 자리 두 개(`afterSummary` · `brandsExtra`)만 더했다. 표준 화면은 그대로다.
  - 그대로 남은 차이: 유형 조각을 눌러 프롬프트로 내려가는 기능은 리뉴얼(Global 포함)에 없다. 국가별 표는 website에서 브랜드를 하나 골라야 나온다(W1 Overview에 있음).
  - Gold 귀속 이상(보고 대상): Kona가 HMG가 아닌 별도 브랜드로 잡혀, 미국 미언급 목록에 Kona 질문이 들어간다.
  - BFF: `mention_renewal.py`의 `_begin`이 ctx.surface를 따른다(`surface_filters`, global은 그대로). `mention_data.py`의 KPI 브랜드 추이(`load_brand_trend` · `load_first_position`)는 surface와 관계없이 지표 셋(노출률 · 점유율 · 순위)을 읽는다. 원본 website · project 화면(`load_mentions_live`)은 SOV만 읽는 그대로다. 이 수정이 없으면 website의 순위 변화 · 순위 스파크라인 · 노출률 경쟁사 평균선이 빈다.
  - 브랜드 축: `scope.all` 계정에 ctx.admin을 보낸다(W0 패널이 브랜드 축을 보이는 기준). 원본은 role admin만이었다.
  - 표준 `_components`(`mention-brands.tsx`): 서랍(브랜드 프롬프트 · 인용 출처, 감정 프롬프트)은 경로에 `/website/`가 있으면 surface=website를 붙인다(답변 원문 창과 같은 규칙). 새 문구는 없다(표준 문구에 Global 표현이 없다). 경로 정책 행은 두지 않았다(W1 · W5와 같음).
  - 발견(기존 결함, W2 범위 밖): 브랜드 서랍의 프롬프트 · 인용 출처 탭은 어느 브랜드를 열어도 같은 목록(당사 목록)을 보인다. BFF `mention_drilldown.py`는 `mention_brand=<이름>`을 보내는데, Gold 리더(`gold_reader/drilldown.py`의 `mention_prompts`, 인용 도메인 읽기)는 `brand_key`만 받고 이름은 무시한다. Global · Website, 원본 · 리뉴얼 모두 같다. 따로 고친다(재현 시험 → 수정).
- W3: 2026-10-30 사용자 결정(추천안, 완료까지 추천안으로 진행). 리뉴얼 Global Citation 본문을 website 데이터로 쓴다(BFF `citation/website` + ctx.variant=renewal). 같은 날 사용자 요청으로 BI 개편을 했다(정보를 잃지 않고, 없는 정보를 만들지 않는다). 순서는 프롬프트 단위 → 인용 단위다: 이번 회차 요약(첫 문장 = 자사 · 타겟 URL 인용률 · 공식(당사) + Δ) → 사이트 인용 도달(측정 → 자사 URL → 타겟 페이지 깔때기, 단계 사이 수는 같은 Gold 답의 두 값 차이, 직전 회차 Δ, 엔진별 같은 깔때기) → 프롬프트(공식(당사) URL 인용 · 미인용 상위 5개, 원본의 화면 목록) → 인용 비중(공식(HMG) · 공식(당사) · 딜러, 전체 인용 · 도메인 · 출처 분류 수 칩) → 출처 구성 → 맥락 → 도메인. 요약 카드의 발견 규칙은 새로 만들지 않았다(판정 기준을 HUB가 새로 정하지 않음). 하위 화면 2개(`prompts` · `tone-urls`)는 BFF `citation/prompts` · `tone-urls`의 ctx.surface=website 분기로 읽는다.
  - 도달 Δ: 직전 회차 = 페이지의 다른 Δ와 같은 회차(카테고리 추이의 직전 유효 회차). 그 날 하루로 K-1을 한 번 더 읽는다(하루 = 그 회차와 정확히 같음을 Gold에서 확인: 10-09 하루 = 스냅샷). 기간 모드는 직전 같은 길이 기간이다. 값 출처(발행 / 실시간)가 다르면 비교하지 않는다. 엔진별은 인용 읽기가 찾은 엔진마다 K-1 한 번이고, 전체는 엔진 평균이 아니라 한 엔진이라도 인용한 프롬프트다.
  - Δ 기준: website의 Overview 카드 Δ(인용 점유율 추이)는 공식(당사)의 값이다(10-09 24.9%, 공식(HMG) 61.7%). 그래서 공식(HMG) 타일과 출처 구성 행은 카테고리 Δ를 쓰고(−5.0pp), 카드 Δ(−3.6pp)는 공식(당사) 타일에 붙인다. 기간 모드에서 공식(당사)는 직전 같은 길이 기간의 인용 읽기 값과 비교한다.
  - 관찰(업스트림 질문 후보): 공식(당사) 값(인용 사실 `citation_fact.loc_owned`)과 추이 마지막 점(셀 `cit_m05`)이 일부 필터에서 다르다(US 18.9 vs 19.9, en 18.3 vs 18.4, 필터 없음은 같음). 값은 원본처럼 인용 읽기 값이고, Δ는 표준 리뉴얼 카테고리 Δ처럼 추이 계열 안에서 계산한다.
  - 커밋: W0의 `surface: "website"`(미커밋)에 기댄다. 경로 정책 행은 두지 않았다(W1 · W2 · W5와 같음). 공유 줄: `rn-sidebar.render.test.tsx` 미구현 표시 개수(8 → 7), `citation-body.tsx`의 다른 작업 줄('climb' weeks)은 섞지 않는다.
- W4: 2026-10-30 사용자 결정(추천안, 완료까지 추천안으로 진행). 원본 기능(필터, 검색, 8열 표, 정렬, 쪽, 엑셀)을 리뉴얼 목록 틀로 옮기고 행 상세 시트를 더했다. 쪽은 번호 · 25/50/100이고, URL에는 q · sort · dir · size만 남긴다(새 조건은 1쪽부터). 필터는 W0 website 패널(stage overview)이고 선택지는 원본과 같은 `website/prompts-options`다. 엔진 · 기간이 측정 렌즈(행은 그대로, 측정 열만 그 범위)라는 설명은 패널 `axisHelp` · `hint`와 목록 위 한 줄로 보인다.
  - BFF 결함(원본 화면도 같았음, 재현 시험 → 수정): Gold 리더 `gold_reader/catalog.py`의 website 분기(`sf == 2`, 이 화면만 씀)에서 검색 · 정렬 · 렌즈가 듣지 않았다. 리더는 화면이 보내는 `search`를 읽지 않았고(본문만 찾음), 늘 prompt_id 순이었고, 늘 전체 회차 · 엔진을 셌다. 사용자가 W4가 이 분기를 고치도록 승인했다. 고친 것: 검색은 본문 + 타겟 URL(LIKE 문자 그대로), 정렬은 원본 규칙(빈 값 뒤, 동점은 id)에 글자 열은 ICU(`und-x-icu`, Gold 기본 정렬은 한글을 정렬하지 못함), 렌즈는 Gold가 노출하는 회차만 센다(servable · hidden_scope · view_date, 전체 측정 횟수 278,031 → 252,437). 집계 CTE는 MATERIALIZED로 고정했다(국가 + 언어를 함께 고르면 8.5초, 렌즈를 더하면 15초 제한 초과 → 0.4초). 도메인은 scheme 없는 타겟에서도 읽는다.
  - BFF 화면 2개를 `website_prompts.py`에 더했다: `website/prompts-page`(번호 쪽), `website/prompts-rows`(엑셀용 전체 행). 브라우저 읽기는 GET 프록시 `app/api/website/prompts/[view]/route.ts`(새 파일, W4 파일 목록 밖)로 한다. 로컬 모드는 `/api/hub/*` 밖의 POST를 막아 서버 액션을 쓸 수 없다. 아키텍처 문서는 빌더 수(88)와 프록시 줄만 고쳤다.
  - 원본 결함(원본 파일이라 고치지 않음): `/api/website/prompts/export`는 xlsx 대신 JSON 첫 100행을 `.xlsx` 이름으로 내려보낸다(리더가 `format=xlsx`를 처리하지 않음). 리뉴얼 엑셀은 브라우저에서 만든다.
  - 레거시 대조(2026-10-30, 같은 URL 조건 11개 + 2쪽): 총 개수 · 행 순서 · 측정 값이 모두 같다. 다른 것은 표시(허브 코드 이름, 날짜 형식, 엔진 이름)와 기능(번호 쪽, 상세 시트, 정상 엑셀)뿐이다. 두 화면 공통: Hyundai N 사이트 프롬프트 228개(Gold `site_brand_bit = 16`, Gold 가상 코드 `HYUNDAI-N`)는 리더 `BRAND_NAMES`에 16이 없어 브랜드가 빈칸이고, 브랜드 필터로 고를 수 없다. 후속으로 다룬다.
  - BI 개편(2026-10-30 사용자 요청: 정보는 잃지 않고, 없는 정보를 증강하지 않는 범위에서 인사이트 화면). 새 수는 모두 목록 행의 Gold 값을 세거나 더한 것이고, 판정 · 추정 · 변화율은 없다.
    - 목록 위 인사이트: KPI 5개(목록 · 측정됨/미측정 · 엔진별 측정 횟수 · 회차 · 최근 회차 측정), 회차별 측정 프롬프트, 마지막 측정 회차, 측정 깊이 · 엔진 조합, 시장(국가 × 브랜드), 언어, 타겟 사이트.
    - 차트를 누르면 목록을 좁힌다(m · rd · last · eset · ans, URL에 남음). 국가 · 언어는 패널 필터를 토글하고, 사이트는 검색한다.
    - 행: 원본 8개 정보를 모두 유지한다(국가 · 언어는 '시장' 한 칸, 엔진은 엔진별 측정 막대 + 범례 · 툴팁). 회차 띠(렌즈 회차 중 측정된 회차)를 더했고, 상세 · 엑셀에는 첫 측정 · 측정 회차 · 엔진별 측정 횟수를 더했다.
    - BFF: 리더 website 분기가 행마다 회차 · 첫 측정 · 엔진별 횟수를 보낸다. 집계는 목록 프롬프트로 좁혔고, 전체 0.85초 · 필터 시 0.2~0.4초다. 새 화면은 `website/prompts-insights`이고, 좁히기는 `prompts-page` · `-rows`에 있다.
    - 실데이터에서 보인 것: 07-24 · 08-07 · 08-14 회차는 측정 프롬프트가 적다. 마지막 측정이 07-17 · 07-03인 프롬프트가 2,563개다. Gemini로만 측정된 프롬프트가 188개다. 측정 깊이는 6회 · 23회 부근에 몰려 있다.
  - W0 영역 관찰: 기간 축 달력의 '기본 회차' 표시는 이 화면 뜻(고르지 않으면 모든 회차)과 다르다. 축 도움말로 설명했다. 엔진 선택지는 원본처럼 ChatGPT · Gemini이고, Gold에는 deepseek 측정도 있다(website 338 프롬프트). 경로 정책 행은 두지 않았다(다른 W 세션과 같음, `route-policy.test.ts`에 대응 한 줄).

- W6: 2026-10-30 사용자 요청('website 하위메뉴 디자인 다듬기', 지적 10개 모두 해결). 디자인 규칙과 Global 화면에 견줘 고쳤고, 데이터 · BFF · W0 공통 코드는 그대로다. 다른 W 세션 파일을 고쳤으니 커밋 때 함께 본다.
  - 제목: 다섯 화면을 '웹사이트 + Global 제목'으로 맞췄다(웹사이트 AI 답변 성과 요약 · 웹사이트 프롬프트 · 웹사이트 언급 분석 · 웹사이트 인용 분석 · 웹사이트 AI 유입 전환). 새 문구는 `renewal.website.overview.title` · `mention.title` · `conversion.title`이다. 원본 `website.dashboard.title`은 그대로 둔다.
  - Prompts 머리에 기준 칩 '주 1회 측정 | 측정 회차 {첫} ~ {끝}'(목록 `roundAxis`, 렌즈 회차)을 넣었다. 머리 높이가 다른 화면과 같아져 필터 · 본문이 움직이지 않는다. '목록 인사이트'는 20px 구역 제목이 되었고, 기준 문구는 칩으로 옮겼다.
  - 기준 문구 반복을 없앴다. Mention KPI 세부 지표는 칩 '증감 = 직전 회차(날짜) 대비' 하나만 둔다. 각주는 없앴다. 카드 기준일(`mention/view-cards`)이 요약 기준일(`mention/rn-asof`)과 다를 때만 날짜 칩을 더한다. Citation 도달 카드는 '실시간 집계' · '발행 리포트 값' 칩을 빼고 같은 뜻의 각주만 남겼다(문구 `chipLive` · `chipPublished` 삭제).
  - Overview KPI 카드는 532 → 474px다. 구역 이름을 구분선 위에 얹었고, 엔진 간 일관성 · 분자/분모 · 경쟁사 대비 SOV를 한 목록으로 묶었으며, 값 줄도 좁혔다. 값은 모두 그대로다. 남은 높이는 발견 4개(86px)와 타일 8개의 근거 줄이라, 더 줄이려면 무언가를 가려야 한다.
  - 증감: 반올림해 0이면 '변화 없음'(KPI 칩 · 브랜드 표, Global 브랜드 표 · Mention과 같음), 증감이 없는 URL 타일은 빈 칩 대신 흐린 글자 '증감 미제공'(`renewal.website.overview.noDelta`)이다.
  - KPI 추이 작은 차트 6개는 모두 당사 남색이다(점유율의 '나빠짐' 빨강 · 범례 점 없앰). 끝 라벨은 짧은 이름이고, 순위 눈금은 축마다 자릿수를 하나로 맞췄다(0.95 · 1.00 · 1.05 · 1.10). 엔진별 비교 · 출처별 구성비 두 카드는 높이를 맞췄다.
  - Mention KPI 세부 지표는 셈마다 한 줄(이름 · 값 16px · 증감)이다. 카드 안 구역 높이는 232 → 163px이고, 셈이 하나인 구역의 빈칸도 줄었다. Citation 프롬프트 구역은 카드 속 카드 대신 한 카드 두 칸 + 세로 구분선이다.
  - Overview 핵심 요약 4장은 사용자 요청(같은 날)으로 문장 대신 리스트로 바꿨다. 카드 머리에 주제 · 짧은 메모(증감 개수, 지표 일관성)를 두고, 값마다 '이름 — 값' 한 줄을 둔다. 리스트 카드는 `_overview/website-findings-view.tsx`이고, 공용 `RnFindingGrid`는 제목을 한 덩어리로만 그려서 따로 만들었다. 증감 줄의 화살표는 타일과 같은 규칙을 따른다(값 방향 · 좋아짐/나빠짐 색). 예전 문장은 순위가 나빠져도 ▼로 썼다. 엔진 줄에는 엔진 표의 '가장 앞섬 · 가장 뒤짐'을 붙였다. 남색 카드는 474 → 493px다(리스트 줄 높이).
  - KPI 추이의 회차별 답변 수에 막대를 얹었다(사용자 요청, 같은 날). 칸마다 0부터 같은 눈금이고, 숫자 · 공백 표시는 막대 아래에 그대로 있다. 답변이 적은 07-24 · 08-07 · 08-14 회차가 바로 보인다.
  - 2026-10-31 사용자 결정(추천안): 답변 수 막대는 중립 회색이다(답변 수에는 좋은 쪽이 없고 당사 계열도 아니다). 칸에 마우스를 올리거나 초점을 두면 공용 `useRnTruncTip` 툴팁이 회차 · 답변 수 · 직전 회차 대비 증감(보이는 두 수의 차, 색 없음)을 보인다. 첫 회차와 답변 수가 없는 직전 회차는 비교하지 않는다. 같은 작업에서 언급 공백 회차가 '0'으로 보이던 것을 '—'로 고쳤다(`website/trend`는 그 회차에 0을 보낸다).
  - Prompts '마지막 측정 회차' 카드를 뺐다(사용자, 같은 날). 빈 자리는 '회차별 측정 프롬프트'를 넓혀 채웠다. 프롬프트별 최근 측정은 목록 열 · 정렬 · 공유 URL의 `last` 좁히기로 남고, 미측정 수는 KPI에 있다. 카드가 가려내던 2,563개는 등록(`dim_prompt.web_reg`)은 되어 있지만, Gold `job_index`에 07-17(2,290개) · 07-03(273개) 뒤로 작업이 한 건도 없다(서비스하지 않는 회차 포함, 2026-10-30 확인). 열람 화면 사용자가 할 일이 아니라 측정 범위 질문이다. 업스트림 질문 후보: "웹 카탈로그에 등록된 website 프롬프트 2,563개가 7월 이후 측정되지 않습니다. 의도한 제외라면 등록을 해제하고, 아니라면 측정 대상에 다시 넣어 주실 수 있을까요?" 측정 범위를 보는 화면이 필요해지면 Admin 6단계(분석 엔진 · 측정 관리, ⛔C)에서 다룬다. BFF `website/prompts-insights`의 `lastMeasured`는 이제 화면이 쓰지 않는다(W4 BFF, 손대지 않음).
  - 그대로 둔 것: AI Conversion 본문(GA4 수집 전 빈 상태), Citation 하위 2화면(Global 하위 화면과 같은 틀이라 고치면 Global도 바뀜).
  - 품질 검수 뒤 수정(2026-10-30, 사용자 '1부터 3까지 쭉'). 결함은 재현 시험이 수정 전에 실패하는 것을 확인한 뒤 고쳤다.
    - 데이터 결함
      - Mention 주별 언급 수: 측정 없는 회차(분모 0)는 0이 아니라 공백이다(`mention_data.to_mention_trend`).
      - Citation 공식(당사): Gold 정의(website = loc_owned ∨ tgt_hit, `citation_cell` 설명)로 바꿨다(`gold_reader/citations.own_citation`). 도메인 표 · 서랍 · 프롬프트 분할 모두 같다. 미국 18.9 → 19.9이고, 당사 인용 프롬프트 8,736 → 8,815(= 도달 카드)다.
      - Citation 미인용: 인용 0건 프롬프트를 빼서 Gold 정의와 맞췄다(1,287 → 1,131).
      - Overview 기간 모드: 기간 결과가 없는 타일 · 브랜드 칸 · 요약에 회차 Δ를 쓰지 않는다('기간 증감 미제공').
      - Prompts 도메인 파싱(`catalog.target_host`): `kia.ro//…`의 도메인이 빈칸이 되지 않는다. 라벨은 '타겟 도메인'이다.
    - 요약 발견 기준값(추천안): Mention · Citation · Conversion 모두 기준값을 뺐다.
      - 순서는 정해진 순서로 둔다(Mention `FINDING_ORDER`, Citation `FINDING_ORDER`). 색은 방향만 나타낸다.
      - 다음을 없앴다: 부정 신호 +0.3pp 문턱, 엔진 5pp · 4pp, 유형 −1.5pp, 기회 40%, 출처 선호 1pp, 순위 3계단, '구매 의도가 가장 강한 유형', 매트릭스 30건 미만 회색, Conversion 표본 50명 · 입구 페이지 50% 문턱.
      - 처방 문구('보강 대상', '기회', '강점 영역')는 중립 문구로 바꿨다. golden 25건을 다시 썼다(README '2026-10-30 no HUB threshold').
    - 라벨 · 보이는 것 · 나머지
      - Overview: 시장 표 가상 코드 라벨(월드와이드(글로벌)), 경쟁사 값 안 잘림, 선두 브랜드 열은 showLead일 때만, '점유율 1위 경쟁사' 라벨, 경쟁사 대비 SOV '410.7배', 순위 축 1부터, '언급 · 인용 공백', 0에 가까운 기간 칩은 '변화 없음'.
      - Mention: 순위 표 '변화 없음', 주 라벨 '6/29 주', 기간 모드 세부 지표 Δ는 색 없음, 미언급 구분 수는 Gold 전체 수(리더 counts), 경쟁사 평균의 집합 이름.
      - Citation: website 도메인 태그 '당사', 회차 라벨(주 → 회차), 추이선 문구 '세로 범위 최소 2pp'.
      - Prompts: 시장 커버리지 색 범례.
      - Conversion
        - 전환율 정의는 '사용자 100명당 전환 수'다.
        - 수집기 창이 있는데 빠진 날이 있으면 합계는 모름이다(부분합 금지).
        - 엔진을 고르면 채널 비교를 계산하지 않고 이유를 보인다.
        - 보고서를 섞는 대체 계산을 없앴다. 중지 속성은 측정 범위에서 뺐다. '잘 전환합니다' 문구를 바꿨다.
    - 남긴 것(이유)
      - 'HMG 계열' 배지의 이름 목록: 지금 결과가 같다. 행마다 Gold HMG 플래그를 따로 실어야 해서 Global golden이 크게 바뀐다.
      - `pct1_or_zero`: 원본 계약을 golden이 고정한다. 아무것도 측정되지 않은 경우에만 0이다.
      - 브랜드 → 모그룹 표시 묶음: 사용자가 표시 묶음은 허용했다.
      - 카테고리 추이의 빌드 시점 category_key: Gold 설계다.
      - 엔진 필터의 DeepSeek: 원본과 공유하는 W0 필터다.
      - Gold 질문 4건: Hyundai N bit 16, 비완성차 경쟁사, 등록 프롬프트 2,563개 미측정, URL 카드 population 4 · 10.

**점검 결과** (W0)

2026-10-30에 확인했다. 시험 관리자로 로컬 API(5555)를 직접 불렀다. 19개 화면이 모두 200이고, 응답은 0.0~1.5초였다.

- 모두 같은 기준일 2026-10-09다. 필터 옵션은 국가 72 · 언어 39 · 매트릭스 141 · 회차 14다.
- W1: 카드는 `state=ok`다(Hyundai 가시성 95.6% = 3356/3512). 추이는 14점, 구성은 출처 8 · 주제 0이다. 주제 0은 website 프롬프트에 카탈로그 분류가 없어서다.
  - GEO는 브랜드를 고르지 않으면 시장 0이다(원본과 같다). 브랜드 하나를 고르면 시장 6이다.
- W2: `mention/view`는 브랜드 436 · 추이 14점이다.
- W3: `citation/website`는 도메인 200 · 카테고리 13이고, 자사 · 타겟 URL 인용률(`targetHitRate`)은 live다. `citation/as-of`의 경쟁사 옵션은 0이다.
- W4: 프롬프트는 12,729개(255쪽)이고, 브랜드 옵션은 Genesis · Hyundai · Kia다.
- W5: `acr/gold`는 비어 있다(브랜드 0 · 셀 0, ⛔H와 같다). `conversion/renewal`은 `state=noprop`이다(GA4 속성 · 수집 전, 표준 화면과 같다).

## 리뉴얼 점검 후속 (한 세션, 순서대로)

2026-10-31 사용자 결정이다. 같은 날 중간점검에서 나온 문제를 고친다. 점검은 Global · Website 전 화면을 원본과 대조하고, 지표와 규칙 5 · 7을 확인했다.

- 병렬로 나누지 않고 세션 하나가 1~16단계를 순서대로 한다. 단계마다 새 하위 에이전트에게 맡기고, 진행 세션은 단계마다 검증한 뒤 다음 단계로 간다(같은 날 사용자 결정, 그 파일 '진행 방식').
- 계획, 현재 위치, 단계마다 읽을 파일과 시험은 `docs/handoff/renewal-audit.md` 하나에만 둔다.
- 세션은 그 파일의 '이어 가는 법'대로 시작하고, 단계를 마칠 때마다 그 파일을 고친다.
- 이 파일에서는 다음만 고친다: 결정 대기 J · K · L, 결정 기록, 진행 기록, '지금 할 일' 줄(16단계에서).
- **2026-10-31 1~16단계를 모두 마쳤다.** 사용자 확인을 기다린다. 16단계에서 리뉴얼 · 원본을 같은 조건으로 대조했고(값 모두 같음), 전체 시험을 통과했다. 결과는 `renewal-audit.md` 단계 메모 '16단계'에 있다.

## 근거 — 점검 · 검수 기록

열린 일과 체크는 맨 위 '할 일' 절에만 둔다. 이 절은 그 근거이고, 끝난 줄은 '(끝)'으로 남긴다. 2026-10-31 점검 후속 16단계에서 모으기 시작했다. 괄호 안은 근거가 있는 `renewal-audit.md` 단계 메모다. 순서는 정하지 않았다. 코드를 고치는 일은 버그 수정 규칙(재현 시험 → 수정 → 전후 비교)을 따른다.

**보류 (다시 열 때 다룬다)**

- AI 가시성(`/renewal/standard/ai-funnel/visibility`): 메뉴에서 숨겼다. HUB가 만든 기준선 · 문턱이 많고 `rule_ver` · 원자료가 빠져 있다. 메뉴를 다시 열 때 다룬다(계획 16단계).
- Website ACR: ⛔H. Gold `acr_cell_fact`에 website 행이 없다. 답이 오면 W5의 ACR을 만든다.

**화면 · 코드**

- (끝) 한국어 화면에서 Gold 대륙 권역 이름(Asia · Europe · Latin America · Middle East · North America · Oceania 등)이 영어로 보인다. `rhqLabel`이 HUB RHQ id만 번역해서다. 원본 · 리뉴얼이 같다(4단계). 2026-11-02 Gold 대륙 권역 7개에 표시 이름을 붙였다(`9c69765`).
- (끝) 리뉴얼 사이드바 NavGroup `id`의 hydration 불일치(`_shell/rn-sidebar.tsx`, 5단계)와 원본 DashLayout의 hydration 불일치(6 · 7단계). Next 개발 오버레이에 가끔 뜬다. 16단계에 연 화면에서는 나지 않았다. 2026-11-02 12개 화면(리뉴얼 · 원본 · en)에서 0건이라 재현되지 않았다. 코드는 그대로 두었고, 다시 나면 재현 시험부터 한다.
- (끝) en 회차 달력(`components/renewal-ui/round-calendar.tsx`)이 요일 첫 글자('T' · 'S')를 key로 써서 key 중복 경고를 낸다(10단계). 16단계에도 `/en/renewal/dashboard`에서 났다. 2026-11-02 요일 머리를 자리로 key 삼았다(`9c69765`, 경고 6 → 0).
- AI Conversion: 직전 기간에만 빠진 날이 있으면 증감 칩이 이유 안내 없이 '−'다(12단계).
- AI Conversion 실제 숫자 대조: 12 · 15단계는 로컬 DB에 GA4 속성이 없어 fixture로만 봤다. GA4 수집을 시작하면 리뉴얼 · 원본을 같은 조건으로 한 번 대조한다.
- 원본 Prompts의 열람 범위 pill은 범위 계정에게 국가 목록 · '내 시장 기준' 안내를 보이지 않는다(원본 페이지 prop, 13단계). 리뉴얼은 보인다.
- (끝) 한국어 조사: 비교 브랜드 이름 뒤 조사가 받침과 관계없이 '와'로 고정이다. 예: Website Mention 미국 '2위 Audio System와 +51.6pp', '비교에서 Audio System와 차이가 가장 작음'. 문구는 `renewal.acr` · `renewal.mention`의 8곳이다(16단계). 2026-11-02 이름 뒤에 조사가 오지 않는 문장으로 바꿨다(10곳, `9c69765`).
- 레거시 정리: 페이지에서 닿지 않는 `front/lib/kpi/period-compare*`(기간 비교 억제 규칙)와 그 시험, 문구 키 3개(`periodCompare.reason.missingShare` · `startWindow` · `startMonth`). 명세 사본 `docs/spec/api/m-kpi.html` · `docs/spec/functional-spec.html` · `docs/design/api/전체-통합.md`의 억제 규칙도 남아 있다(`모듈-KPI.md` K-2는 고침, 14단계).
- 문서: `docs/catalog/global-renewal-catalog.html`의 ACR 지도 설명('평균선 아래 = …')은 15단계 전 화면 기준이다.
- 점검 전(`1a7dd8b`)부터 실패하는 원본 시험 3건: `(dash)/dashboard/_components/period-delta-off-parity.render.test.tsx` 2건(3단계), `(dash)/projects/[id]/project-gate.test.ts` 1건(demo project, gap G16, 16단계).
- (끝) Global Citation 자사 판정이 국가 · 언어 필터에서 Gold 정의와 다르다. 리더 `gold_reader/citations.py` `own_citation`은 Gold `dim_owned_base`의 관점 브랜드 베이스를 모두 자사로 보고, Gold 표 설명의 규칙은 요청 국가 → 언어로 더 좁힌다. 국가 미국(2026-10-05)에서 자사 인용 3,288건(화면 9.5%) 대 2,224건(약 6.4%)이고, 필터 없음에서는 같다. 버그 수정 규칙을 따른다(`kpi-data-lineage.html` 2절). 2026-10-31 고쳤다(`9dbd27d`). 리더 `owned_bases`가 Gold 규칙대로 허용 배열을 만든다. 관점 베이스에서 요청 국가 geo_code로, 다시 요청 언어로 좁히고, 좁힌 결과가 비면 그 단계는 건너뛴다. 도메인 표 · 프롬프트 분할 · 도메인 상세가 모두 이 배열을 쓴다. 미국은 2,226건(6.4%)으로 Gold `kpi_cell.cit_owned_c`와 같다. 미국+독일 · en · 미국+es도 `citation_cell` 허용 배열 합과 같다. 필터 없음은 그대로다.
- 분석 화면의 출처 카테고리 이름 · 순서는 코드 상수(`_query.py` `CITATION_CATEGORY_SLUGS` · `taxonomy.ts` · 문구 `citationCategories`)다. HUB 정본 코드표(`catalog.source_code`)를 고쳐도 분석 화면 이름은 바뀌지 않는다. 지금 13개는 같다(`kpi-data-lineage.html` 2절).
- (끝) Admin › Global prompts 편집은 Gold 측정 종류가 비면 'single'로 채운다(`catalog_editor.py`). Global Prompts는 13단계에서 이 규칙을 뺐다. 지금 빈 값은 0건이다. 2026-11-02 빈 값은 빈 값으로 보이고 거르기 · 정렬도 Gold 값 그대로다(`9c69765`). 새 프롬프트 폼의 기본값 'single'은 사용자가 저장할 입력이라 두었다.
- Mention 서랍 목록은 BFF가 2,000행을 청해도 Gold 리더 `limit` 상한 1,000에서 끊긴다(화면은 '1,000 / 전체' 안내). 상한을 맞출지 정한다.

**`CLAUDE.md`에서 옮긴 일** (2026-11-02, 마스터 룰 적용 때 문구 그대로)

- (끝) **P4 ACR 차종 전환율 분모 중복 확인** — 2026-10-28 완료. Gold 기준 영향 없음, 수정 없음. 결과는 `docs/handoff/p4-acr-model-denominator.html` 머리 배너.
- **ACR 후속** — `docs/handoff/acr-next-session.html` 2절. 2026-10-29 두 번째 세션에서 P1(회차 간 비교 막기)·P3(후보→선택 전환, 결선 맞대결)·P5(리더 SQL 집계)를 끝내 푸시했다(첫 세션 `341a09e`, 두 번째 세션 `2dfb8ef`). 같은 날 사용자 최종 결정으로 회차 간 비교를 다시 열고 숨김 코드도 지웠다. 추이·Δ·기간 합산을 리뉴얼·기존 화면 모두 보인다. 측정 방식·범위가 매주 달라질 수 있어도 그건 화면 사용자가 감수할 일이다. 숨기거나 경고하지 않는다. P2 업스트림 질문은 사용자가 보낸다. 미결: cell·fact family의 metric_version 혼재(Mention·Citation 추이).
- **GA4 수집 시작** — 2026-10-29 리뉴얼 AI Conversion 화면과 GA4 수집기(`back/analytics/ga4_collect.py`)를 만들었다. 수집기는 GA4 Data API를 직접 읽어 HUB 데이터 DB `analytics.ga4_*`에 쌓고, 화면은 그 DB만 읽는다. 수집할 속성은 리뉴얼 Admin › GA4 연동(`/renewal/admin/ga4`, 데이터 DB `analytics.ga4_registry`)에서 등록한다(2026-10-29, 파일 등록부는 없앰). GA4 계정 인계 뒤 VM에서 돌린다(사용자 결정: production·dev build가 HUB DB 하나를 같이 씀, production은 cron `vm.sh ga4-cron`, dev는 수동 `vm.sh ga4 …`). 순서와 남은 일은 `docs/handoff/p4-acr-model-denominator.html` 7-3절 13~18번.

**2026-11-02 대전제 검수에서 나온 일**

사용자 요청으로 Global · Website를 규칙 5 · 7에 대조했다. 값이 바뀌는 첫 두 항목은 고칠 방법을 사용자가 정한다. 사용자가 먼저 운영 웹과 대조하자고 했다. 운영 웹은 이메일 · 비밀번호 로그인이 필요하고 이 저장소에 운영 계정이 없어 아직 보지 못했다(2026-11-02).

- Website Overview 모수가 Gold 정의와 다르다. `web_report_prompt` 설명은 카드 ①~⑤ · 증감 · 기간 칩 · 엔진 배지 · 추이 · 시장 GEO · 출처 구성비(기간 없음)의 모수를 '보고 유닛 소속 ∧ 제외 유닛(`web_unit.excluded`, file_seq 71 · 94 · 97) 아님'으로 정한다. 리더는 `kpi_cell` population 8 · 9만 읽고 이 게이트가 없다(`gold_reader/context.py` `population`, BFF에 이 표를 읽는 코드 0건). 옛 구현 `back/app/core/measure.py` `web_unit_pred`에는 있다. 10-09 필터 없음 답변 20,216 → 19,400, 노출률 88.0 → 88.9, 미국 704 → 602 · 57.2 → 50.0(따로 다시 세어 같음). 원본 `/website`도 같은 BFF라 원본 대조로는 잡히지 않았다. `kpi_cell`에 이 모수가 없어, 사실 표를 읽거나 Gold에 population을 요청해야 한다.
- Website Overview ⑥ AI 타겟 출처 인용률의 정의가 Gold와 다르다. Gold는 기간 없는 카드 · 추이를 발행 시점 유닛 판정(`pub_cell_web.unit_owned` · `unit_target`)으로 센다고 적고, `url_prompt_cell` 설명은 이 정의를 셀로 내지 않는다고 적는다. 화면은 `url_prompt_cell` population 4다. 10-09 65.3%(Δ +1.4) 대 유닛 판정 89.6%(13,041 / 14,561, Δ −0.5). W1의 '카드와 Δ를 같게' 결정은 이 Gold 정의와 대조하지 않았다. 기간을 고른 ⑥(`web_target_url`)은 확인하지 못했다.
- (끝) Mention 트리맵 묶음 타일의 Δ · 색이 일부 브랜드 Δ의 합이다(`mention_renewal.py` `_group_of`, 안내는 hover뿐). 기본 조건 Global 12타일 중 6개(VW 8개 중 2개 등), Website 2타일 모두. '부분합 금지'(W6 · 12단계)와 어긋난다. 2026-11-02 고쳤다(`b013b8b`). 원인은 Δ를 상위 경쟁사 10개까지만 읽는 KPI 브랜드 추이에서 가져온 것이다. 회차 모드의 `mention/rn-ranking`이 모든 브랜드의 점유율 추이(`load_brand_share_lines`)를 읽고, 그래도 Δ가 빠진 구성원이 있는 묶음은 Δ를 내지 않는다(회색 + 이유). 기본 조건 부분합 타일 Global 6 → 0, Website 2 → 0이고, 순위표 Δ도 752 / 752행 · 436 / 436행으로 찼다. 기간 모드 '그 외'만 직전 기간에 없던 브랜드 때문에 Δ가 없다.
- (끝) Website Prompts 국가 축이 다른 화면과 다르다. 리더는 `dim_project.site_geo_key`, 다른 화면은 답변 국가다. SA-Jeddah 0 · SA-Riyadh 0 · SA-Dammam 246개 대 Mention 측정 프롬프트 93 · 84 · 69개. 2026-11-02 고쳤다(`0e69ace`). 다른 화면과 같아야 맞았다. Genesis 사우디 프로젝트(`project_key` 129)는 `site_geo_key`가 SA-Dammam 하나지만 프롬프트는 도시별 사이트(`genesis.com/sa-jeddah/…` · `sa-riyadh` · `sa-dammam`)를 겨누고, Gold 셀과 필터 선택지에는 세 도시가 있다. 리더가 `job_index`에서 사이트 국가와 다르게 측정된 프롬프트를 먼저 읽어 그 국가를 쓴다. 목록 12,729개 모두 측정 국가가 하나이고 달라진 것은 177개뿐이다. SA-Dammam 246 → 69, Jeddah 0 → 93, Riyadh 0 → 84개로 Mention과 같다. 원본 `/website/prompts`도 같은 리더라 같이 바뀌었다. 쿼리 안 CTE로 읽으면 job 스캔이 병렬로 돌지 못해(0.2 → 0.9초) 먼저 읽어 값으로 넘긴다(국가 필터 약 0.4초). 명세 `m-prompts.html` · `P-1-프롬프트-카탈로그.json`도 고쳤다.
- (끝) HUB가 정한 좋음 · 나쁨: Citation 발견 typeGap(추천 · 단순 언급 짝을 고정하고 warn/good, `citation_model.py`), 경쟁사 Δ 색(ACR 브랜드 표 · Overview 브랜드 표 · Citation 도메인 범프, Mention 순위표도 빠져 있었다), 프롬프트 하위 화면 머리 문구 '강점과 기회 영역'. 2026-11-02 고쳤다(`0e69ace`). typeGap은 값을 두고 `info`만 쓴다. 경쟁사 Δ는 화살표만 두고 회색이다. 리뉴얼 문구는 `renewal.citation.sub.promptsDescription`이고 원본 화면 문구는 그대로다. Mention 트리맵의 경쟁사 타일 초록 · 빨강은 범례가 있는 증감 인코딩이라 그대로 뒀다.
- 판단이 필요한 것: Citation 출처 선호 매트릭스의 '전체' 열(⛔L 목록 밖 HUB 기준선, 유형 축은 중복 계상), ACR 기간 모드에 Δ 없음(`acr.py` `show_delta`), Mention 요약 '{rank}위'(경쟁사 12개로 자른 표 안 순위, 최대 13위), Website Overview 첫 요약 카드의 '나빠진 것만 목록'(`website-findings.ts`), ACR 차종 발견의 '가장 낮은'(상위 12행 안 최저), AI Conversion 'coverage' 발견의 늘 warn.
- (끝) 레거시 정보: 우선 노출도 회차별 순위 답변 수(툴팁 · 표 · CSV), Mention '당사 = …' 칩 · 우호도 감정 신호 칩, 우선 노출도 '상위 N%'. 2026-11-02 되살렸다(`b013b8b`). '당사 = …' 칩은 숨김 클래스 말고도 조건이 문제였다. 당사가 한 행(R1)이라 표시 조건 '브랜드 2개 이상'을 못 채웠고, 이제 리더 `own.brands`로 센다.
- 레거시 정보 의심(아직 확인 안 함): Global 추이의 수집 공백 음영, 서랍 프롬프트 표 정렬, 경쟁사 표 전체 · 미측정 회차 수, Website 유형 구성의 경쟁사 건수.
- 작은 것: 답변 원문 창 스탠스의 '당사'가 이름 비교다(`answers.py`, 2% 표본 1만6천여 행 중 6행 'Hyundai N'만 다름). Overview 기간 모드의 인용 순위는 당사 card · 경쟁사 live를 견준다(2026-09 당사 23.3% 대 23.1%, 경쟁사 최고 2.2%, 순위 영향 없음). `published.ga4_*` 뷰가 미개방 역할 `hmg_data_external`에 남아 있다(규칙 5 '외부로 안 나감'과 어긋나는 잔재, 127.0.0.1 · 프로젝트별 승인 전이라 지금 나가지 않음). 셸 `rn-sidebar.tsx`의 `max-lg` 서랍은 모바일 잔재다.

**2026-11-02 Admin 화면 점검에서 나온 일**

사용자 요청으로 Admin 화면 10개를 1920×915에서 보고 폼 · 서랍 · 필터를 눌러 봤다. 바로 고친 것은 진행 기록(`f41a002`)에 있다. 아래는 남은 것이다.

- 고객 관심 › 소셜 결과 지도. Gold `ctx_entity`(4,136) · `ctx_combination`(5,739) · `ctx_domain` · `ctx_evidence`에 2026-07-07 스냅샷 결과가 있고, 표 설명의 쓰임에 Admin Customer interest config의 표 · 상세 · 조합 표 · 소스 도메인이 있다. 원본 페이지는 `SocialScrapingFlow`에 데이터를 넘기지 않아 늘 빈 카드였고, 3단계 범위에서 뺐다('3 범위'). 리더는 `gold_reader/insights.py` `social`에 있다. 옮길지는 사용자가 정한다.
- (끝) 저장한 필터가 없는 화면: 인용 출처 분류(교정 · 시드) · 고객 관심(키워드 · 소스) · 엔티티 카탈로그(`saved={null}`). 사용자 관리 · GA4 · 글로벌 프롬프트에는 있다. 화면 키를 `saved_filters.py` `PAGES` · `SavedFilterPage`에 더해야 한다. 2026-11-02 다섯 목록에 붙였다(공용 훅 `admin-saved-filters.tsx`, `9c69765`).
- 수집 소스의 실제 채널 값은 원본 운영 DB `standard_sources` 행에 있다(3단계 남은 일과 같음, 사용자 보유).

**2026-11-02 Admin › 사용자 관리 검수**

사용자 요청으로 Admin 화면을 하나씩 검수한다. 첫 화면이다. 실제 화면(1920×915, 쓰기 요청은 브라우저에서 막음)과 운영 DB 대조는 진행 세션이, 원본 대조 · 코드 · 권한은 하위 에이전트가 봤고, 중 3건과 권한은 진행 세션이 코드로 다시 확인했다. 목록 5개 계정의 역할 · 범위 · 상태 · 시각은 DB와 같고, 관리자 전용 · 쓰기 잠금 · 같은 트랜잭션 이력 · 임시 비밀번호 비노출은 지켜진다. 결함은 '할 일' F12~F19다. 사용자 지시로 심각도 순서대로 하나씩 고치고, 고칠 때마다 보고한 뒤 다음으로 간다. GA4 연동 검수는 나중에 한다(사용자).

- (끝) F12 상태 '첫 로그인 전'은 실제로 `must_change`(새 계정과 재설정마다 켜지고, 임시 비밀번호로 로그인해도 남음)였다. 2026-11-02 '비밀번호 변경 필요'로 바꾸고 머리 설명 · 임시 비밀번호 안내 · 상세 안내를 '다음 로그인 때'로 고쳤다(`3a07e7d`). 새 계정 폼의 '처음 로그인할 때'는 그대로 맞다.
- (끝) 임시 비밀번호 서랍이 Esc · 바깥 클릭 · X로 닫혀, 한 번만 보이는 비밀번호를 다시 볼 수 없었다(계정은 이미 만들어짐, 원본은 버튼으로만 닫힘). 2026-11-02 고쳤다(`d9792e9`).

**2026-11-02 Global 데이터 점수표에서 나온 일**

결과는 `docs/handoff/global-data-score.html`(205행)에 있다. 결함 15건은 2026-11-02 사용자 요청으로 모두 고쳤다(`97da2a0` · `38234bf` · `b805c7b` · `7a3875a` · `1d0a041`). 판단이 필요한 7건은 그 문서에 있고, 페이지별 인사이트 개선에서 사용자와 함께 다룬다. Overview부터 한 페이지씩 한다.

- (끝) Admin › 글로벌 프롬프트 '분류' 열이 비어 있었다. 2026-11-02 Admin 점검 때 '결함이 아니다'라고 한 답은 틀렸다. 2026-11-02 고쳤다(`1d0a041`). 목록 · 정렬 · 필터가 첫 번째 카탈로그 행의 값을 쓴다. 브랜드 행마다 값이 다른 프롬프트 115개는 첫 행 값으로 보인다.

**2026-11-02 Overview 개선안 적대적 검증**

첫 안(KPI 카드에 브랜드 포함 · 미포함 값, 뒤처진 시장 수, 격차 열)은 하지 않는다. 코드는 고치지 않았다. 고칠 안은 사용자가 정한다.

- (끝) 국가와 카탈로그 축을 함께 고르면 느리다. 2026-11-02 고쳤다(`77f0ec6`, 아래 진행 기록). `overview/cards` 독일 0.39초가 미포함을 더하면 13.8초(재측정), `overview/geo`는 독일에서 20초 제한에 걸려 `geo: null`이다. 범위 계정은 늘 국가가 붙어 이 경로다. 원인 후보는 `context.predicate`의 catalog_entry EXISTS다. 버그 수정 규칙을 따른다.
  - 2026-11-02 두 번째 검증: 원인은 card 모드 셀 읽기의 Nested Loop Semi Join이다(catalog_entry에 prompt_key 인덱스가 없고 추정 1,451행 대 실제 133k). 리더만으로 고칠 수 있다. `Context.create`에서 맞는 prompt_key를 한 번 읽어 `prompt_key=ANY(int[])`로 묶으면 DE+유형 cards 13.0→0.7초, 미포함+유형 15.3초(빈 화면)→0.5초, geo 20.0→1.0초이고, 끝까지 돈 12쌍은 화면 JSON이 같았다. 축마다 따로 고른 뒤 교집합을 내면 틀린다(카탈로그 행이 여럿인 프롬프트 231개).
- (끝) `overview/geo`는 요약이 시간 초과되면 `{"geo": null, "degraded": false}`로 아무 표시 없이 빈다. 위 수정과 같이 버그 수정 규칙대로 고친다. 2026-11-02 고쳤다(`77f0ec6`). 이제 `degraded: true`이고, 두 화면 모두 지연 안내를 보인다.
- 라벨 정의는 업스트림에 묻는다. `brandPresence`는 브랜드 행 값이라 78개 프롬프트가 브랜드마다 다르고, HMG 전체 보기에서는 76개 프롬프트 579답변이 양쪽에 잡힌다. branded 6,356개 중 1,159개(18.2%)는 본문에 브랜드 · 차종이 없다. unbranded는 5,546개 중 1개만 브랜드를 쓴다. 08-24 전 7회차는 Genesis 행 삭제로 라벨 없는 답변이 27~53%다.
- 믿을 수 있는 시장 사실: 미포함에서 JP · TH 열세(노출 · 점유율 · 언급 순위, 두 엔진, 6회 전부). AT는 노출로만 열세, DE는 ChatGPT · 독일어 프롬프트 한정. BH · DK · PR · SK는 오차 안이다. 시장 수는 지표마다 4~24개, 합집합 34개라 쓰지 않는다.
- 값이 가장 크게 갈리는 축은 포함 여부가 아니라 depth1이다(점유 폭 84.2 대 50.1). '1. Brand Image/key value'에서 당사 노출 2위, 우호 5위다.
- 두 번째 안(범위 칩 '전체 · 브랜드 미포함', 리스트 유형 카드)도 하지 않는다. 칩은 디자인 규칙 1 · 3(필터는 왼쪽 패널, 같은 정보를 두 번 쓰지 않음)에 어긋나고, 지금은 다른 축과 겹치면 본문이 사라진다. 유형 카드의 '위'는 카드가 고른 경쟁사 4곳 안의 순위다(`standing`, 전체 브랜드 기준 우호도 BM 16/80). 경쟁사 13곳 우호도 분산의 69%는 유형(문항) 효과이고, 같은 프롬프트 · 엔진끼리 비교하면 CBR '2위' · SM '4위'가 사라진다. Strategic Model은 Hyundai 카탈로그 1,595개뿐이고 71%가 IONIQ 5를 직접 쓴다. '유형'은 Mention의 멘션 유형과 이름이 겹친다.
- 우호도 5위는 구성비 때문이다. 당사 감정 신호의 62%가 CBR 브랜드 포함 질문(사용 · 구매 답변)에서 나온다. 리스트 유형의 뜻은 Gold · docs 어디에도 없다(업스트림 질문).

**2026-11-02 인사이트 · 정확도 마지막 검수**

사용자 요청으로 메뉴에 있는 실데이터 화면 9개를 다시 봤다.

- **범위:**
  - Website Overview · Citation은 처음 점수를 매겼다.
  - Website Mention · Prompts는 만든 쪽과 다른 눈으로 다시 봤다.
  - Global은 점수표의 낮은 행 47개와 고친 구역을 다시 봤다.
- **기준:** `global-data-score.html`과 같다. 합이 4 이하이거나 I가 1 이하이면 낮음으로 본다. 기준 회차는 Global 10-05, Website 10-09다.
- **결과:** 코드는 고치지 않았다. 값 자체는 Gold와 맞는다.
  - Website는 177항목 중 Gold와 대조한 161항목에서 157항목이 같다. 다른 4항목은 ⑥ 2(이미 알려짐)와 아래 Mention 2다.
  - Global은 고친 구역 약 5,000칸이 같다.
  - 문제는 정의 · 라벨 · 키다.

값이 바뀌어 사용자 결정 · 업스트림이 필요한 것

- Website 자사 · 타겟 URL 인용률이 Gold 규칙과 다르다. 해당 위치는 Overview 카드, Citation 깔때기, 요약 첫 문장, 엔진 '전체' 행이다.
  - **Gold 규칙:** `url_prompt_cell` 설명은 '율 · ⑥ 은 답변 수 합'이다.
  - **화면 계산:** 화면은 프롬프트 OR ÷ 측정 프롬프트다(`screens/_summary.py:130-149`).
  - **차이(화면 대 Gold):**

    | 조건 | 화면 | Gold |
    |---|---|---|
    | 10-09 필터 없음 | 88.0 · 66.6 | 74.1 · 48.4 |
    | US | 83.8 · 63.4 | 63.4 · 43.5 |
    | 2026-09 | 92.5 · 75.3 | 61.9 · 40.0 |
  - **발행값:** 발행값(`report_value`, 유닛 프롬프트 수 합)은 리더가 읽지 않는다. 그런데 각주는 모든 조건에서 '이 필터 조합은 발행 리포트가 답할 수 없어…'라고 쓴다(`gold_reader/context.py:145`).
  - **할 일:** 업스트림 D6에 두 정의가 갈린다는 점을 덧붙인다. 라이브 '율은 답변 수 합'과 발행값 '프롬프트 수 합'이다.
- URL 수는 `b805c7b`부터 `url_norm`으로 센다. 대상은 Citation 톤 타일, 톤 하위 화면, 도메인 서랍이고 Global · Website 모두다.
  - **Gold 규칙:** `citation_fact` 설명은 '고유 URL 수는 count(DISTINCT url_key)'다.
  - **차이(화면 대 Gold):**
    - Global 긍정: 130,284 대 226,805
    - Website 긍정: 66,458 대 134,811
  - 목록 행을 `url_norm`으로 묶는 것은 표시 묶음이라 괜찮다.
  - 업스트림 B6와 같은 질문이다.

값은 그대로이고 라벨 · 키 · 정렬만 틀린 것

- (끝) Website Overview — 2026-11-02 고쳤다(`e41ea10`).
  - 기간 증감 문구 '현재 n회차 / 직전 n회차'의 n은 표면 전체의 발행 회차 수다(`compare.py:108`). 2026-09 + US에서는 '직전 4회차'로 나오지만, US의 8월 측정 회차는 2개다.
  - ④ 분자 이름 '최초 등장 순위의 합'이 값과 맞지 않는다. 값은 경쟁 순위 합(`rank_sum`) 19,042이고, 첫 등장 순서의 합은 17,941이다.
  - ⑤ 정의는 'HMG 사이트 base URL'이지만 분자는 자사 ∨ 타겟이다(103,528. 자사만 세면 103,260).
  - 추이 머리 '최근 N회차'가 기간 모드에서도 그대로 나온다(`website-trend.tsx:54`).
  - 엔진 선택지가 front에 고정된 값(ChatGPT · Gemini)이라 Gold에 있는 DeepSeek(CN 284답변)을 거를 수 없다(`dimension-filter-panel.tsx:166`).
- (끝) Website Citation: 공식(당사) 타일 ⓘ('공식(HMG)은 3사 전체라서')와 프롬프트 하위 화면 제목 '공식 도메인'이 Gold의 website 자사 정의와 다르다. Gold 정의는 사이트에 등록한 URL · 하위 페이지 ∨ 타겟이다. 2026-11-02 고쳤다(`e41ea10`).
  - 필터가 없어도 61.7% 대 24.9%로 차이가 난다.
  - '미인용' 1,131개 중 968개가 공식(HMG) 출처를 인용한다.
- (끝) Website Mention — 2026-11-02 고쳤다(`e41ea10`).
  - 시장 표 '선두 경쟁사(노출률)'는 언급 수 1위를 고른다(`gold_reader/advanced.py:44`). 59개 시장 중 24곳에서 노출률 1위와 다르다(CA: Tesla 2.4 대 Audio System 3.5). Global Overview 시장 표 인용 탭의 '최대 경쟁사'도 같아서 51개국 중 43곳이 다르다.
  - 점유율 히어로의 '2위'는 반올림한 값이 같으면 이름순으로 정한다(`mention_renewal.py:345` `_board_cmp`, `mention_view.py:275`). 화면은 BMW인데 Gold로는 Tata다(0.235 > Toyota 0.222 > BMW 0.217).
  - 'Top 3 노출 비율' ⓘ는 '평균 순위 3 이하'라고 적었다. 실제 값은 Gold `kpi_cell.top3`, 곧 가장 앞선 당사 순위가 3 이하인 답변이다.
  - 엔진 표 셋째 열은 머리가 비어 있다. aria-label은 '당사 − 경쟁사 평균'인데 값은 회차 Δ다(`site-engines.tsx:42`).
  - 주별 언급 표에 차트 시절 문구('선은 자기 눈금…', '선이 끊긴 곳')가 남아 있다. ⓘ는 '최신 답변 1개 기준'인데 값은 모든 답변이다.
  - 각주 '답변이 없는 시장 n개'는 브랜드를 고르면 그 브랜드 사이트가 없는 시장까지 센다(Kia 34 = 미측정 15 + 사이트 없음 19).
- (끝) Global — 2026-11-02 고쳤다(`e41ea10`).
  - Overview 기간 모드 브랜드 비교: 증감 안내 · 툴팁은 '마지막 두 회차 차'라고 하지만 값은 기간 비교다. `97da2a0`이 BFF만 바꿨다(`overview-body.tsx:378-395`).
  - Prompts 상세 '변경 이력'이 늘 비어 있다. `prompt-detail.tsx:67`은 Gold `catalog_row_id`(`row.id`)를 넘기는데, 이력 화면은 HUB UUID(`scopePromptId`)만 받는다.
  - Prompts 변경 이력 탭은 최신 500건을 먼저 읽고 그 뒤에 기간 · 종류를 거른다(`standard_prompts.py:349-357`). 그래서 90일 24,460건 중 '일괄 교체 500건' 한 줄만 보이고, 사용자 수정 2건은 보이지 않는다.
  - ACR 차종 발견 '표에서 가장 낮은'은 실제로 당사 차종 중 최저를 가리킨다(`acr.py:535-540`). ChatGPT 조건에서 문구는 17.9%이고 표 전체의 최저는 17.7%다.
  - ACR 필터 선택지가 최신 회차 셀로 고정돼 있다(`acr.py:196-199`). 08-17을 고르면 국가 51개 중 8개에만 셀이 있다. EG는 07-13~08-17에 셀이 있는데 선택지에서 빠진다.
  - Mention 요약 '변화' 발견은 아직 상위 10 추이를 읽는다(`mention_renewal.py:995`). 미국 · 비교 없음 조건에서 발견은 'Porsche ▲0.3pp 가장 큰 변화'인데, 표에는 Mazda ▼0.4가 있다.

인사이트가 낮은 것

수: Website Overview 16, Citation 15, Mention 11, Prompts 10. Global 47행은 그대로다.

- **원인 1. 늘 같은 값:** 순위는 늘 1위다. 기준일 표시, 우선 노출도 1.0~1.1, Website 경쟁사 0.x%도 늘 같다.
- **원인 2. 같은 수의 반복:**
  - Overview 요약 '인용 출처' 카드가 구성비 카드와 같다.
  - Prompts 12,729가 세 곳에 나온다.
  - Citation 8,815가 88.0%와 89%로 두 번 나온다. 분모가 다르다.
- **원인 3. Gold 쪽 원인:**
  - D8 분석 빈 답변 때문에 노출률 −5.2pp, DeepSeek 31.0%, US Hyundai 0.0%, 엔진 일관성 배지 34.7%가 나온다.
  - D3 경쟁사 분류 때문에 Audio System · Facebook · Visa가 경쟁 1위로 잡히고, SOV가 410배로 나온다.
- **원인 4. 발견 4칸 고정:** Website Citation '가장 크게 움직인 출처'와 Global Mention '순위 변화'는 어떤 조건에서도 보이지 않는다.
- **정리 후보:** 리뉴얼이 더한 반복만 후보다. Overview 요약 '인용 출처' 카드와 Website Overview 시장 표 경쟁사 인용 점유율 칸(39개국 중 37곳이 0.0%)이다. 레거시는 남긴다(⛔L).
- **Gold 값으로 바로 더할 수 있는 것:**
  - Website ⑥ · 자사 · 타겟 URL 증감: 지금은 '증감 미제공'이지만 `url_prompt_cell`에 회차 · 기간 값이 있다.
  - Citation 엔진 발견 · 매트릭스 엔진 열에 측정 프롬프트 수와 국가를 붙인다. DeepSeek은 CN 284개뿐이다.
  - kia.com 행에 Gold 자사 인용 수를 붙인다(83,061 중 37,559).

**확인 메모**

- 9단계에서 본 로컬 front의 옛 ko 문구(`/ko/renewal/website/answer-analysis/citation`)는 16단계에 다시 열었을 때 새 문구('당사 도메인')로 보였다. 풀렸다. front 재시작은 사용자가 정한다.
- 첫 방문 때 페이지 요청이 아닌 404가 1건 난다(5 · 6 · 7 · 16단계). 화면에는 영향이 없다.
- 2026-11-02: 로컬 front(3333)가 `messages/*.json` 변경을 다시 읽지 않던 것은 17:23 사용자 지시로 front · API를 다시 띄워 풀렸다.

**업스트림 답 대기**

- D1 ~ D8(`upstream-questions-2026-10-30.md` 'D. 2026-10-31 점검'). 사용자가 보낸다. 16단계에서 D1 · D3 · D7을 2 ~ 15단계 결과와 맞췄다. 답이 오면 각 질문의 '답에 따라 HUB가 할 일'을 한다. 같은 파일의 A ~ C절도 아직 보내지 않은 초안이다.

## 결정 대기 (⛔)

| ID | 질문 | 막는 단계 | 상태 |
|---|---|---|---|
| A | 기준값(출처 분류, 시드 키워드, 엔티티 역할)을 누가 정하나. **추천:** HUB가 정본을 갖는다. HUB에서 편집한 값을 외부 API로 업스트림에 주고, Gold가 재가공한 뒤 화면에 반영된다. Gold 가져오기는 HUB가 고친 항목을 덮어쓰지 않는다. **다른 길:** 열람만 하고, 수정은 업스트림에 요청한다. 덮어쓰기(BFF가 읽을 때 적용)는 규칙 5 때문에 후보가 아니다. | 2 · 3 · 4 | 2026-10-30 결정 |
| B | GA4 '검증' 버튼. 원칙('BFF는 GA4를 부르지 않는다')을 지키면 검증 결과는 수집기 실행 결과(권한 대기 / 활성)로 보인다. 누르자마자 확인하려면 BFF가 GA4를 부르도록 구조를 바꿔야 한다. | 1의 검증 항목만 | 2026-10-29 결정 |
| C | 분석 엔진 · 리포트 관리 · 측정 크레딧 명세. 운영 웹(hmg-geo.vercel.app) 화면 캡처나 설명이 필요하다. | 6 | 미정 |
| D | 키워드 도구. DataForSEO · OpenRouter 키를 인계받는지, BFF가 유료 외부 API를 불러도 되는지, 비용 상한을 어떻게 둘지. | 5 | 2026-11-02 답: 계정 인계 대기(결정 기록 'D') |
| E | 고객 관심. 커뮤니티 수집 소스를 HUB가 새로 가질지. 2026-10-30 확인: Gold 표 86개에 없고, 저장소에서 이 목록(원본 `app.standard_source`)을 읽는 수집기도 없다. 원본 관리 CRUD만 쓴다. | 3 | 2026-11-02 결정: HUB가 갖는다(결정 기록 'E') |
| F | 엔티티 카탈로그. 원본의 초안·검토·적용 흐름을 옮길지, 글로벌 프롬프트처럼 버전 행과 변경 이력만 둘지. | 4 | 2026-11-02 결정: 버전 행과 변경 이력만(결정 기록 'F') |
| G | 출처 시드 · 공식 소셜 목록의 정본. Gold `dim_source`에는 결과(분류 출처 4 · 2)만 있고, 원래 값은 원본 HUB 앱 파일이다(`front/lib/citation-categorizer/seed.json` 795개 · `official-social.ts` 9개, 2026-10-30 대조). HUB 편집 대상으로 할지, 파일로 둘지, Gold 열람만 할지. | 2 (공통 구조 '소유') | 2026-10-30 결정: HUB 편집 대상 |
| H | Website ACR. Gold `acr_cell_fact`에 website(surface 2) 행이 0개다(global 89,808 · project 76, 2026-10-30). 표 설명에는 'Website · Project ACR'에 쓴다고 되어 있다. 원본 website ACR은 `acr/gold`로 surface website를 읽는다. Gold 팀에 가공 예정인지 묻는다. | W5의 ACR | 미정 |
| I | Project 화면(목록, 상세의 Dashboard · Intent · Prompt · Analysis · AI Agent Funnel · Setting)을 이 목록의 어디에 둘지. 지금은 어느 todo에도 없다. | 없음 | 2026-11-03 결정: D안(결정 기록 'Project 메뉴') |
| J | Website 범위 계정 접근. hq · region · country 계정은 Website 메뉴가 보이지만 BFF가 website 읽기를 모두 403으로 막는다(`access.py` `clamp`, 범위 '전체'는 관리자뿐). **추천:** website에도 global과 같은 브랜드 · 국가 범위를 건다. 국가는 사이트 국가다. 원본 규칙과 같다: country = 자국 사이트, region · hq = 권역 국가, 브랜드 통합은 관리자만. project는 그대로 막는다. | 점검 후속 2단계 | 2026-10-31 결정: 추천안(결정 기록 'J · K · L') |
| K | 기간 비교 억제. 수집분이 70%에 못 미치거나, 시작 유예 기간이거나, 적용일(2026-09-08) 전이면 Δ를 숨기고 경고한다(`compare_logic.py`). 원본 API 명세에 있는 규칙이고 원본 화면과 같이 쓴다. Website 인용 도달 Δ도 값 출처가 다르면 숨긴다. 규칙 5와 맞지 않는다. **추천:** 비교할 값이 없는 경우(unsupported · no_prev · no_data)만 남기고 나머지는 뺀다. | 점검 후속 14단계 | 2026-10-31 결정: 추천안(결정 기록 'J · K · L') |
| L | HUB가 만든 평균 기준선 · 분해. 리뉴얼에서 새로 만든 것은 넷이다: Mention 경쟁사 평균 추이선, 유형별 경쟁사 평균(상위 5), ACR 브랜드 평균선과 '평균선 대비' 편차, Conversion 전환 변화 분해. 원본에 있던 엔진별 경쟁사 평균은 레거시 KPI라 남긴다. **추천:** 새로 만든 기준선 · 분해는 빼고, 비교 브랜드 값과 두 요인의 값 · Δ를 나란히 보인다. | 점검 후속 15단계 | 2026-10-31 결정: 추천안(결정 기록 'J · K · L') |

## 기준값 편집 공통 구조

2단계(2026-10-30)에서 정했다. 3·4단계도 이 구조를 따른다. 예시는 2단계 이름이다.

- **소유.** 사람이 정한 값은 HUB가 갖는다(출처 교정, 시드 키워드, 엔티티 역할). 출처 분류 코드표(카테고리 13개 · 분류 출처 코드 1~6)도 HUB가 정본이다(결정 기록 '코드표'). 출처의 시드 · 공식 소셜 목록도 HUB가 편집하는 정본이다(결정 기록 G). Gold에는 결과로만 있고 원래 값은 원본 HUB 앱 파일이다. 편집 화면을 만들기 전까지 화면은 Gold 값을 열람만 한다. 자동 판정(출처 자동 분류, 발견 엔티티)은 Gold 소유이고 HUB는 읽기만 한다. Gold 가져오기의 거울 family(`source` · `keyword` · `entity`, source `gold`)는 그대로 둔다.
- **저장.** 데이터 DB `catalog`에 종류마다 현재 값 표와 이력 표를 하나씩 둔다. 예: `catalog.source_override`(키, 값, `status` active·cleared, `origin` gold_import·hub, 시각과 행위자)와 `catalog.source_override_event`(`changes = {필드: [전, 후]}`, 행위자, `published_seq`). 행은 지우지 않고, 원복은 `cleared`다.
- **키와 값.** 키는 파이프라인이 비교하는 정규형이다(출처: 소문자, 앞 `www.` 제거). 값은 Gold 코드만 받는다(출처 카테고리: `gold.dim_category.slug`). Gold는 쓰기 전에 잠금 밖에서 읽는다. 검증은 DB CHECK와 BFF 양쪽에서 한다.
- **처음 값.** `manage.py import-<종류>`가 Gold에서 사람이 정한 값을 한 번 가져온다(`origin = gold_import`, 행위자 없음). HUB에 값이 하나라도 있으면 거부한다. 2단계는 `import-source-overrides`이고, 가져온 값은 Gold `dim_source.category_src = 1`인 2건이다.
- **Gold 재가져오기.** `sync-gold-catalog`는 HUB 편집 표에 권한이 없고, HUB family도 기록하지 않는다. 그래서 HUB 편집이 남는다. HUB 값과 Gold 값이 다르면 덮어쓰지 않고 화면에 상태로만 보인다.
- **업스트림 전달.** 쓰기마다 같은 트랜잭션에서 활성 값 전체를 family 하나(`source_override`, source `hub_edit`)의 새 set으로 기록한다. 내용이 같으면 기록하지 않는다. 기록은 전용 함수 `catalog.publish_<종류>()`(SECURITY DEFINER)만 한다. 다른 역할이 `hub_edit` set을 쓰면 트리거가 막는다. 외부 API는 기존 경로 `GET /ext/v1/reference/<family>`로 내보내고, 공개는 `manage.py publish-reference <family>`로 승인한다.
- **change_seq 알림.** 기록은 catalog lock(617427413) 안에서 하므로 순번이 커밋 순서다. 소비자는 `GET /ext/v1/reference`의 `change_seq` · etag를 폴링하고, 바뀐 family만 다시 읽는다. `hub_edit`은 `ext.meta.hub_reference`(source `hub`만)에 들지 않으므로, 편집해도 `contract_version`이 바뀌지 않는다.
- **변경 이력.** 같은 트랜잭션에서 이력 행을 남긴다(누가, 무엇을 전 → 후, 실린 목록 순번). 화면에는 행마다 이력 서랍을 둔다.
- **버전(2026-11-03, 인용 출처 분류 네 종류만).** 현재 값 표가 바뀔 때마다 트리거가 행 전체를 `<표>_version`에 다음 버전으로 쌓는다(키마다 1, 2, …, 기록 시각 · 기록자 · `change_seq`). 트리거만 쓰고 고치거나 지우는 계정은 없다. 현재 행은 늘 최신 버전과 같다(`data-013.sql`, 결정 기록 '인용 출처 버전'). 고객 관심 · 엔티티 역할에 붙일지는 D-8.
- **전용 DB 역할.** 화면 하나의 입력 묶음마다 하나를 둔다. 예: 인용 출처 분류의 교정 · 시드 · 공식 소셜 · 코드표는 `hmg_source_override_editor` 하나가 쓴다(2026-10-30, 같은 관리자가 같은 화면에서 고치는 한 묶음). 표마다 필요한 열만 UPDATE하고, 발행은 종류마다 있는 함수로만 한다.
  - 권한: 편집 표 INSERT, 값 · 상태 · 시각 · 행위자 열 UPDATE, 이력 INSERT, 발행 함수 EXECUTE.
  - 없음: 키 · origin · 메모 UPDATE, DELETE, 다른 catalog 표, reference_set 직접 INSERT, 운영 DB 접속.
  - 비밀번호는 `.env.source-override-db.local`, 연결은 `.env.hub-edit.local`의 `HGH_SOURCE_OVERRIDE_EDITOR_DB_URL`.
- **BFF.** `hub_stores/<종류>.py`와 `/v1/hub/<종류>`를 둔다. 관리자 전용이고, 쓰기는 catalog lock 안에서 한다(5초 대기 뒤 503). 목록은 Gold 값과 HUB 값을 나란히 주고 `state`를 붙인다: applied(Gold가 HUB 값을 적용함), pending(아직), upstream(Gold에만 있음). 같은지 비교만 하므로 새 판단이 아니다.
- **화면 반영 시점 문구.** "고친 값은 HUB에 저장되고 외부 API 목록으로 파이프라인에 넘어간다. 화면 숫자에는 파이프라인이 가져가 Gold를 다시 만든 뒤 반영되고, 그 전까지 '반영 대기'로 보인다." '저장 즉시 반영'은 쓰지 않는다.
- **3단계 시드 키워드.** 그대로 썼다. 거울은 family `keyword`(term · term_norm · 수집 조건)이고, HUB 표 키는 term_norm, 값은 수집 조건(location · language)이다. Gold `kw_suggestion.is_seed`는 2026-10-30 기준 84 term이다. 만들며 확인한 사실: 이 행은 사람이 고른 목록이 아니라 요청 시 수집한 호출의 시드 행이다(`su`, `SIIIUUUUUU`도 있음, 업스트림 C2). 원본의 켜기/끄기 · 삭제는 `status`(active · stopped) 하나로 합쳤고, 원본이 메모를 입력받으므로 `note`는 이 화면 역할이 UPDATE한다. 전용 역할은 `hmg_interest_editor`, 종류는 `interest_keyword` · `interest_source`다.
- **4단계 엔티티 역할.** 그대로 썼다. 거울은 family `entity`(registry_role 지정분, 2026-10-30 기준 own 5 · excluded 14)이고, HUB 표 키는 Gold `entity_id`, 값은 역할과 자사 브랜드다. Gold에 있는 엔티티에만 역할을 줄 수 있다. 편집 흐름은 F 결정대로 저장 → 발행 → 반영 대기이고, 전용 역할은 `hmg_entity_role_editor`, 종류는 `entity_role`이다. 경쟁사는 저장하지 않아 `status`는 active · cleared다.

## 단계

### 0. 계정 관리(사용자 관리) 마무리

- [x] 2026-10-29에 만든 계정 관리 작업을 커밋한다. 같은 날 커밋·푸시했다(`768d7f6`).
- [ ] VM 반영(`manage.py init`, `vm.sh bff`, 관리자 등록)은 사용자가 직접 한다. 다음 단계를 막지 않는다.

### 1. GA4 연동 (`/admin/ga4`)

목표는 속성 목록을 파일(`.local/ga4-properties.json`)에서 HUB 데이터 DB로 옮기는 것이다. 관리자가 화면에서 등록·수정·중지하고, 수집기는 DB에서 목록을 읽는다.

- [x] 범위를 확인한다. 원본(`ga4-registry-client.tsx`)에는 속성 이벤트 목록, 프로젝트별 덮어쓰기, 레거시 가져오기가 있다. 이 셋을 옮길지 확인한다. 2026-10-29 확인, 아래 '결정 기록'의 GA4 범위 줄.
- [x] 등록부 표를 설계한다. 수집기가 데이터 DB에만 접속하므로 데이터 DB에 둔다. (`data-006.sql`)
  - 담을 값: 속성 ID, 브랜드, 국가, 전환 기준(key_events / events와 이벤트 목록), 수집 여부(`enabled`, 중지). 한 시장에 수집하는 속성은 하나(원본 규칙).
  - `analytics.ga4_property`는 수집기의 기록으로 둔다. 수집기가 실행마다 등록부를 복사하고, 중지한 속성은 `unmapped`(리더가 뺌)로 둔다. 결과는 새 표 `ga4_collect_status`.
  - 변경 이력은 같은 DB의 `ga4_registry_event`(같은 트랜잭션).
- [x] 전용 DB 역할을 만든다. `hmg_ga4_registry_editor`: 등록부 INSERT·UPDATE(속성 ID 제외), 이력 INSERT, 지우기 권한 없음. Mac 저장소에 적용, `verify` 통과.
- [x] 입력 검증은 `load_registry` 규칙과 같게 한다. DB CHECK와 BFF 둘 다 둔다. 이벤트 이름은 GA4 규칙을 BFF·화면에서 본다.
- [x] 수집기가 DB 등록부를 읽게 한다. 파일 읽기와 예시 파일은 없앴다. 전환 기준을 바꾸면 다음 실행이 저장된 이벤트 행 전체의 `is_conv`를 다시 정한다. `test_ga4_collect.py` 갱신(PostgreSQL 시험 포함).
- [x] 화면을 만든다(`/renewal/admin/ga4`).
  - 목록 열: 시장(브랜드·국가), 속성 ID, 전환 기준, 수집 설정(+반영 대기), 수집 결과(수집기 값과 시각), 마지막 수집일.
  - 등록·수정 폼, 중지·재개, 변경 이력, 전환 이벤트 고르기(수집된 최근 90일 이벤트 + 직접 입력), 저장한 필터.
- [x] ⛔B 검증 버튼은 두지 않는다(2026-10-29 결정). 상태 열에 수집기가 마지막 실행에서 남긴 값(수집됨 / 권한 대기)과 그 시각을 보이고, 등록 직후에는 '수집 전'으로 보인다.
- [x] 같은 커밋에서 절차 문서를 새 방식으로 고친다: `scripts/vm.sh` 의 ga4 안내, 인계 문서 `p4-acr-model-denominator.html` 7-3절 13·18번, CLAUDE.md 'GA4 수집 시작' 줄.
- [x] 공통 완료 기준을 채운다. 2026-10-29 사용자가 확인했고 커밋·푸시했다(`08b533c`).

### 2. 인용 출처 분류 (`/admin/standards/citation-sources`)

이 단계에서 기준값 편집의 공통 구조를 세운다. 3·4단계는 그 구조를 따른다.

- [x] 범위를 확인한다. 원본(`domain-list.tsx`)에는 도메인 목록, 카테고리 교정, 후보 도메인이 있다. 2026-10-30, 결정 기록 '2 범위'.
- [x] A 결과에 따라 구조를 만든다. HUB가 정본이다. 교정만 HUB 표 `catalog.source_override`에 두고, Gold `source` 거울 family는 건드리지 않는다. 외부 API에는 새 family `source_override`(source `hub_edit`)로 내보낸다(`data-007.sql`). 아래 '기준값 편집 공통 구조'.
- [x] 후보 도메인과 인용 수는 Gold 읽기 값을 그대로 쓴다(최신 회차 · 글로벌 live, 인용 화면과 같은 모수).
- [x] 화면에는 반영 시점을 사실대로 적는다(업스트림 재가공 뒤에 반영, 행마다 반영 대기 / 반영됨). '저장 즉시 반영' 문구는 쓰지 않는다.
- [x] 정한 구조를 이 파일의 '기준값 편집 공통 구조' 절에 적는다.
- [x] 업스트림 합의 요청 초안을 쓴다(아래). 사용자가 보낸다.
- [x] 출처 분류 코드표를 HUB 정본으로 둔다(결정 기록 '코드표' · '2 남은 범위'). `catalog.source_code`(카테고리 13 · 분류 출처 6, `data-008.sql`)와 기준값 종류 `source_code`. 화면 코드표 탭은 이름 · 설명 · 카테고리 순서만 고친다. 시드 카테고리 검사는 이 코드표를 쓴다(교정은 아직 Gold `dim_category`).
- [x] ⛔G를 묻고 정한다. 2026-10-30 결정: 시드 · 공식 소셜 목록은 HUB 편집 대상이다.
- [x] 시드 · 공식 소셜 목록을 HUB에서 편집한다(결정 G · '2 남은 범위'). `catalog.source_seed` · `source_social`과 기준값 종류 `source_seed` · `source_social`, 화면 시드 · 공식 소셜 탭. 처음 값은 `manage.py import-source-lists`(시드 795 · 소셜 9 · 코드 19). 쓰기는 교정과 같은 `hmg_source_override_editor`(공통 구조 '전용 DB 역할').
- [ ] 공통 완료 기준을 채운다. 교정 탭은 커밋·푸시(`e12eeb5`), Mac 적용, e2e를 마쳤고 '전체' 두 번 결함을 고쳤다. 시드 · 공식 소셜 · 코드표 탭은 2026-10-30 Mac 적용(`init` 008 · `import-source-lists` · `verify`), BFF 시험 전체(32개 모듈 479개, 새 `test_hub_source_lists` 11개는 실 DB 롤백 포함), 프런트 typecheck · lint · 관련 시험 301개, 아키텍처 문서 · ERD, e2e 한 번(시드 · 소셜 · 코드표 핵심 흐름, 끝 상태는 처음과 같음)을 마쳤고 2026-10-30 사용자 요청으로 커밋 · 푸시했다(`a36b835`). 남은 것: 사용자 확인.

**업스트림 합의 요청 초안** (사용자가 파이프라인 팀에 보낸다)

> [HMG GEO HUB] 인용 출처 분류 교정값 전달 방식 확인 요청
>
> HUB가 출처 카테고리 교정(override), 출처 분류 코드표, 시드 · 공식 소셜 목록의 정본을 갖게 되었습니다. 자동 분류(규칙)는 지금처럼 파이프라인이 정합니다. 교정값은 외부 API(https://10.0.20.132:8087/ext/)로 드립니다.
> - `GET /ext/v1/reference`: family `source_override`의 `change_seq` · etag
> - `GET /ext/v1/reference/source_override`: 활성 교정 전체(키 = 소문자 · 앞 `www.` 뺀 skey, `category` = `dim_category.slug`)
>
> 확인 부탁드립니다.
> 1. `change_seq` · etag가 바뀌면 목록 전체로 교정 입력을 바꾸는 방식(폴링)이 가능한가요? 주기는 얼마인가요?
> 2. 목록에서 빠진 키(원복)는 기본 분류(소셜 → 당사 → 시드 → 규칙 → Other)로 되돌려 주시나요?
> 3. 반영 확인은 Gold `dim_source`의 `category_src=1`과 `category_key`로 하려고 합니다. 맞나요? 셀(`citation_cell`) 재빌드는 언제 하나요?
> 4. 키 정규화 규칙(소문자, 앞 `www.` 제거, 소셜은 계정 키)이 파이프라인과 같은가요?
> 5. 지금 파이프라인 쪽 교정 2건(arxiv.org, danawa.com)을 HUB 초기값으로 가져왔습니다. 앞으로 파이프라인 쪽에서 직접 교정하지 않는 것으로 정리해도 될까요?
> 6. API 키 발급 대상(호출자 이름)을 알려 주세요.
> 7. 출처 분류 코드표(카테고리 13개, 분류 출처 코드 1~6)와 시드 · 공식 소셜 목록도 HUB가 정본으로 관리하고, 같은 방식(외부 API, change_seq)으로 드립니다: `GET /ext/v1/reference/source_code` · `source_seed`(도메인 → 카테고리) · `source_social`(계정 키, 도메인, URL 매칭 규칙 `[{prefix, boundary}]`, 카테고리 officialHmg). 지금 이 값들을 어디서 가져가시는지(`dim_category` 설명에는 HUB 코드표의 투영이라고 되어 있습니다), 이 목록으로 바꿔도 되는지 알려 주세요.

### 3. 고객 관심 데이터 관리 (`/admin/standards/customer-interest`)

- [x] 범위를 확인한다. 2026-11-02, 결정 기록 '3 범위'. 원본은 카드 3개(소셜 리서치 · `keyword-list.tsx` · `source-list.tsx`)다.
- [x] 시드 키워드는 2단계 공통 구조로 만든다. `catalog.interest_keyword`, 기준값 종류 `interest_keyword`, 처음 값은 `manage.py import-interest-keywords`(Gold 84개).
- [x] 커뮤니티 수집 소스는 E 결정을 따른다. Gold에 해당 표가 없음을 다시 확인했다(결정 기록 'E'). `catalog.interest_source`, 기준값 종류 `interest_source`, 처음 값 없음.
- [ ] 공통 완료 기준을 채운다(`53126de`). 사용자 확인만 남았다. 마이그레이션 `data-009.sql` · 전용 역할 `hmg_interest_editor` · Mac 적용 · `verify`, `hub_stores/interest.py` · `/v1/hub/interest-*`, 화면 · render 시험 16개, 메뉴 · 경로 · 사이드바 시험, 아키텍처 문서 · ERD, e2e 한 번을 마쳤다.
- [ ] 원본 운영 DB의 `standard_keywords` · `standard_sources` 행(이관 필수, 마이그레이션 부록 A)을 받지 못했다. 로컬에 그 DB가 없다. 받으면 화면에서 넣거나 가져오기를 만든다(사용자 보유 정보).
- [ ] 업스트림 C2(`upstream-questions-2026-10-30.md`). 사용자가 보낸다. 답이 오면 공개 승인(`publish-reference interest_keyword interest_source`)과 수집 소스 화면의 '읽는 수집기 없음' 문구를 정리한다.

### 4. 엔티티 카탈로그 (`/admin/standards/entities`)

영향이 가장 크다. 역할 지정이 모든 KPI의 당사 판정을 정한다.

- [x] 범위를 확인한다. 2026-11-02, 결정 기록 '4 범위'.
- [x] 역할(자사 / 경쟁 / 제외) 편집은 2단계 공통 구조로 만든다. `catalog.entity_role`, 기준값 종류 `entity_role`, 처음 값은 `manage.py import-entity-roles`(Gold 19건).
- [x] `dim_entity` 에는 분석이 찾은 행과 사람이 정한 행이 섞여 있다. 외부 API에는 사람이 정한 역할만 낸다(규칙 5, 결정 기록 '4 범위'). 2026-10-31 규칙 2로 사용자에게 묻지 않고 정했다.
- [x] 발견 브랜드와 언급 수는 Gold 값을 그대로 쓴다. 표시 브랜드 · 분류 · 수치를 합치거나 고치지 않는다.
- [x] F 결정에 따라 편집 흐름을 만든다. 저장 → 발행 → 반영 대기이고, 자사가 바뀌면 확인을 받는다.
- [ ] 공통 완료 기준을 채운다(`bb34ac4`). 사용자 확인만 남았다. 마이그레이션 `data-010.sql` · 전용 역할 `hmg_entity_role_editor` · Mac 적용 · `verify`, `hub_stores/entity_roles.py` · `/v1/hub/entity-roles`, 화면 · render 시험 16개, 메뉴 · 경로 · 사이드바 시험, 아키텍처 문서 · ERD, e2e 한 번을 마쳤다.
- [ ] 업스트림 C3(`upstream-questions-2026-10-30.md`). 사용자가 보낸다. 답이 오면 공개 승인(`publish-reference entity_role`)을 하고, 병합 · 표면을 입력으로 받는다는 답이면 그때 만든다.

### 5. 키워드 도구 (`/admin/keyword-tools`) ⛔D

- [x] 계정을 받기 전 화면(2026-11-02, `3043512`): 리뉴얼 `/renewal/admin/keyword-tools`가 두 도구를 샘플 행으로 그리고 'DataForSEO · OpenRouter 계정 필요' 막으로 덮는다. 아무것도 읽지 않고 유료 API를 부르지 않는다. 계정을 받으면 실제 도구로 바꾸고 `renewal-pages.ts` `ACCOUNT_PAGES`의 줄을 지운다.
- [ ] 범위를 확인한다. 원본(`components/keyword/keyword-tools.tsx`)은 검색량 조회, 키워드→프롬프트 생성, CSV를 갖췄다.
- [ ] 키는 `.env.*.local` 에만 두고, BFF만 읽는다. 외부 호출 원칙이 바뀌는 것을 아키텍처 문서에 적는다.
- [ ] 관리자 전용으로 하고, 받은 계정에 정해진 호출 범위 · 비용 한도를 따른다(결정 기록 'D'). 계정을 받으면 그 값을 여기에 적는다.
- [ ] 생성한 프롬프트를 저장하는 흐름이 있으면 기존 글로벌 프롬프트 편집 경로를 쓴다.
- [ ] 공통 완료 기준을 채운다.

### 6. 분석 엔진 · 리포트 관리 · 측정 크레딧 ⛔C

- [ ] 명세를 받는다. 받은 뒤 페이지별 하위 항목을 이 파일에 더한다.
- [ ] 측정 크레딧 › 계정 목록은 미뤄 둔 '운영 웹 계정 가져오기'와 같이 한다.

## 결정 기록

| 날짜 | ID | 결정 | 근거 |
|---|---|---|---|
| 2026-10-29 | 순서 | 0 → 6 순서로 한다 | 사용자 승인 |
| 2026-10-29 | 1 범위 | 옮긴다: 등록·수정 폼(전환 기준 포함), 목록(상태, 마지막 수집일), 중지·재개(원본의 삭제 대신), 전환 이벤트 고르기. 옮기지 않는다: 속성 ID 없는 '대기 시장', 프로젝트별 덮어쓰기 목록. 전환 이벤트 목록은 수집기가 쌓은 최근 90일 이벤트 이름·횟수로 보이고, 수집 전 속성은 이름을 직접 입력한다. | 사용자 선택. 대기 시장은 수집기·화면 어디에도 쓰이지 않는다. 프로젝트별 속성 데이터와 리뉴얼 프로젝트 화면이 없다. BFF는 GA4를 부르지 않는다. |
| 2026-10-29 | 1 파일 | 파일 등록부(`.local/ga4-properties.json`)를 없앤다. 수집기는 DB 등록부만 읽는다. 파일 읽기 코드와 예시 파일을 지운다. | 사용자 선택. GA4 인계 전이라 가져올 값이 없다. |
| 2026-10-29 | B | 검증 버튼을 두지 않는다. 수집기 실행 결과(수집됨 / 권한 대기)와 시각을 상태 열에 그대로 보인다. | 사용자 선택. 'BFF는 GA4를 부르지 않는다' 원칙을 지킨다. |
| 2026-10-29 | 원칙 | 데이터는 한 방향으로 흐른다. HUB가 만든 데이터(프롬프트 목록, URL 기반 페이지 특성 등)는 Gold가 원천 데이터로 가져가 분석하고, HUB는 Gold의 분석 결과를 읽어 보기 좋게 가공해 보여준다. HUB가 가공한 결과를 Gold가 다시 가져가는 일은 없다. | 사용자 설명 |
| 2026-10-29 | A · 2 범위 (바뀜) | 다른 세션에서 '기준값은 Gold의 분석 결과, HUB는 열람만'으로 정하고 열람 전용 2단계를 만들었다(미커밋). 2026-10-30 A로 바뀌어 쓰지 않는다. 그 작업은 `.local/backup/2026-10-30-step2-readonly/`(git 제외)에 남겼다. | 2026-10-30 사용자 확정(아래 'A 확정') |
| 2026-10-30 | A | HUB가 정본이다. 사람이 정하는 기준값(출처 분류 교정, 시드 키워드, 엔티티 역할)은 HUB DB에서 CRUD로 관리하고 변경 이력을 남긴다. 편집값은 외부 API로 업스트림에 넘기고, 화면 숫자에는 Gold 재가공 뒤 반영된다. Gold 가져오기는 HUB가 고친 항목을 덮어쓰지 않는다. 분석이 자동으로 정한 값(자동 분류, 발견 엔티티)은 Gold 소유로 두고 HUB는 읽기만 한다. | 편집 화면이 서비스에 있고 관리자가 실제로 고친다. 사람이 정한 값의 원본은 편집하는 곳의 DB다. 업스트림이 HUB 값을 읽는 합의가 있어야 편집이 숫자에 닿는다(2단계 업스트림 질문 초안). |
| 2026-10-30 | 2 범위 | 옮긴다: 관리자 전용, 목록(인용 수 상위 500 + 교정한 도메인 전부, 인용 수는 Gold 최신 회차 · 글로벌), 열(도메인 · 인용 수 · 카테고리 · 분류 출처 배지 · 메모 표시 · 작업), 요약, 필터(미분류 · 카테고리 · 검색), 정렬, 셀렉트 즉시 저장, 원복, 당사 도메인 덮어쓰기 경고(Gold `owned_brand_bit` 기준), 하단 힌트, 조회 실패 구분, 변경 이력. 편집은 교정(override)만 하고 시드 · 소셜은 Gold 열람만 한다. 더한다: 행별 반영 상태(반영 대기 / 반영됨, HUB 값과 Gold 값 비교). 메모는 표시만. 원복은 행을 지우지 않고 cleared로 남기며 업스트림 목록에서 뺀다. family `source_override`, 출처 구분 `hub_edit`(외부 API contract_version에서 뺌), 처음 값은 Gold 교정 2건(arxiv.org, danawa.com). 옮기지 않는다: 캐시 태그 무효화, 소스 스위치, 대기 큐(409). 업스트림 합의 요청 초안은 사용자가 보낸다. | 원본 기능 목록과 Gold · HUB 데이터 사실을 확인한 뒤 추천안대로 정했다. |
| 2026-10-30 | A 확정 | 두 세션이 A를 반대로 정했다(10-29 열람 전용, 10-30 HUB 정본). 사용자가 HUB 정본(`e12eeb5`)을 확정했다. | Gold에는 사람이 정한 값의 원본이 없다. `dim_source`는 출처 1개당 최종 카테고리와 분류 출처 코드만 갖고, 표 설명은 '입력: 데이터 분석팀'이다. 원래 값은 원본 HUB 앱에 있다. 교정은 원본 앱 DB `citation_domain_overrides`, 시드는 `seed.json`(Gold 시드 701건 모두 같은 카테고리), 공식 소셜은 `official-social.ts`(Gold 8건 모두 포함)다. `geo_readonly`는 Gold에 SELECT만 가진다. |
| 2026-10-30 | 코드표 | 출처 분류 코드표(카테고리 13개, 분류 출처 코드 1~6)도 HUB가 정본이다. | 사용자 결정. Gold `dim_category` 표 설명이 'GEO HUB 출처 카테고리 코드표의 투영'이고, 원래 값은 `taxonomy.ts`다. `dim_source.category_src`는 smallint이고 코드표 없이 열 설명('1 교정 2 공식 소셜 3 당사 도메인 4 시드 5 규칙 6 Other')에만 뜻이 있다. 카테고리 번호는 `answer_fact.cit_c<k>` 열 번호와 묶여 있어, 카테고리를 더하거나 빼는 일은 Gold 변경이 따라야 한다. |
| 2026-10-30 | G | 출처 시드 · 공식 소셜 목록은 HUB 편집 대상이다(HUB 정본). | 사용자 결정. Gold에는 결과만 있고 원래 값은 원본 HUB 앱 파일이다(시드 701건 · 소셜 8건 모두 일치). |
| 2026-10-30 | Website 우선 | Website 하위 화면을 Admin 3단계 이후보다 먼저 만든다. Admin 2단계 남은 일은 다른 세션에서 진행 중이다. 화면마다 세션 하나씩 병렬로 하고, 공용 필터 등 공통 코드는 W0 세션만 고친다. | 사용자 결정. Gold 팀이 website 데이터 가공을 마쳤다(website 발행 2026-10-29 활성). |
| 2026-10-30 | W0 추천안 | W0는 모두 추천 기준대로 개발하고, 끝날 때까지 정할 일은 추천안으로 정해 바로 진행한다. 정한 것은 이 파일에 적는다. 첫 적용: website 필터는 원본 축 그대로 옮기고 더하는 것은 없다. 계정 범위는 세 화면 모두 Website 기준이다. | 사용자 지시(W0 세션). 같은 날 W1 · W4 · W5 세션도 같은 지시를 받았다. |
| 2026-10-30 | 2 남은 범위 | 코드표: HUB DB가 갖고 외부 API로 내보낸다. 화면에서는 이름(한국어 · 영어) · 순서 · 설명만 고치고, 카테고리를 더하거나 빼는 일은 막는다(Gold `cit_c<k>` 열과 묶임). 분류 출처 코드 1~6은 이름 · 설명만 고친다. 시드: 교정과 따로 둔 목록으로, 같은 편집 공통 구조(추가 · 카테고리 변경 · 제외, 이력, 반영 상태)를 쓴다. 처음 값은 `seed.json` 795개다. 공식 소셜: 계정 단위로 추가 · 수정 · 중지하고 이력을 남긴다. 매칭 규칙(접두어 · 경계)도 편집하고, 카테고리는 Official (HMG)로 고정한다. 처음 값은 `official-social.ts` 9개다. 화면: 인용 출처 분류에 탭 4개(교정 · 시드 · 공식 소셜 · 코드표)를 두고 메뉴는 그대로 둔다. 원본 코드 파일은 손대지 않는다(기존 화면이 씀). 가져온 뒤의 정본은 HUB DB다. 범위 밖: 당사 도메인 목록(분류 출처 3, 4단계와 묶임). | 사용자 확인(추천안). 시드를 교정과 합치면 우선순위(교정 > 공식 소셜 > 당사 > 시드)가 바뀌어 Gold 분류 결과가 달라진다. |
| 2026-10-31 | 결정 · 커밋 | 데이터 · 화면 원칙(규칙 5 · 7)을 충실히 따른 결정은 묻지 않고 진행하고, 새 원칙이 필요하면 반드시 묻는다(규칙 2, Website 세션의 추천안 규칙을 모든 작업으로 넓힘). 커밋 · 푸시는 시험을 통과하면 자동으로 한다(규칙 6). VM 반영은 사용자가 정한다. 레거시 KPI는 더 나은 인사이트를 위해 통합해 쓸 수 있지만 없애지 않는다(규칙 7). 규칙 5에는 이미 정한 데이터 원칙(한 방향 흐름 · 없는 정보 금지 · 측정 변화 그대로)을 모았다. | 사용자 결정. 푸시도 자동으로 한다(같은 날 사용자). |
| 2026-10-31 | 점검 후속 | 중간점검 결과는 세션 하나가 순서대로 고친다(`renewal-audit.md` 1~16단계). Admin 3단계는 그 뒤에 한다. 새 원칙이 필요한 것은 ⛔J · K · L로 두었다. 나머지는 규칙 5 · 7로 정해 계획에 적었다. 예: ACR 발견은 W6 방식으로 바꾼다. `NON_AUTO`는 묶음 이름만 두고 늘 접던 것을 뺀다. 경쟁사 접기는 이름 대신 `brand_key` 기준이다. 레거시 KPI(엔진 일관성, 경쟁사 대비 SOV, 엔진별 경쟁사 평균)는 남긴다. | 사용자 결정. 처음 낸 병렬 세션안을 사용자가 한 세션 순차안으로 바꿨다. |
| 2026-10-31 | 선택 추이 | 원칙(규칙 5 · 7)으로 정할 수 없는 결정도 지금까지 사용자가 내린 결정의 추이를 따라 정하고 묻지 않는다. 추이로도 정할 수 없는 새 원칙만 묻는다(규칙 2). | 사용자 지시: "웬만한 결정은 지금까지 내가 해온 결정들을 기반으로 내 선택의 추이대로 따라가줘." |
| 2026-10-31 | J · K · L | 셋 다 추천안. J: website에도 global과 같은 계정 범위를 건다(사이트 국가, 원본 규칙). project는 그대로 막는다. K: 기간 비교 억제는 비교할 값이 없는 경우(unsupported · no_prev · no_data)만 남기고, 수집분 70% · 시작 유예 · 적용일 게이트와 도달 Δ의 값 출처 억제는 뺀다(값 출처 각주는 둔다). L: 리뉴얼에서 새로 만든 평균 기준선 4개 · 전환 변화 분해는 빼고, 비교 브랜드 값과 두 요인의 값 · Δ를 나란히 보인다. 엔진별 경쟁사 평균(레거시)은 남긴다. 다른 안: J는 관리자만 Website 열람, K · L은 지금 그대로. | 선택 추이(위 줄). J: 원본 규칙과 같게 맞추는 쪽을 늘 골랐다(W0~W5). K: 측정이 바뀌어도 숨기거나 경고하지 않는다(규칙 5, 2026-10-29 ACR 숨김 철회). L: HUB가 만든 판단 · 기준선을 빼 왔다(W6 문턱 제거, 규칙 5). |
| 2026-10-31 | 점검 3단계 | 기간 비교 라벨: 카드(타일)들이 같은 라벨이면 머리에 한 번만, 다르면 머리는 '카드마다 적은 기간 비교'이고 카드마다 칩 옆에 자기 라벨(다른 안: 늘 카드마다 — W6에서 사용자가 기준 문구 반복을 뺐다). Global 브랜드 표의 Δ 없음은 카드 · Website 브랜드 표와 같은 '−'(다른 안: 계획의 '—' — 이 표에서 '—'는 비교 경쟁사가 아닌 칸이다). 스파크라인 점 영역은 카드 링크 위(ⓘ와 같음, 띠를 누르면 열리지 않음). | 규칙 7(설계는 UX로)과 W6 결정. 근거는 `renewal-audit.md` 단계 메모 '3단계'. |
| 2026-10-31 | 점검 4단계 | 경쟁사 접기는 이름(trim + 소문자) 그대로 둔다. 위 '점검 후속' 줄의 '`brand_key` 기준'은 하지 않는다. 다른 안: 접기만 `brand_key`로 바꾸기(추이 · 우선 노출도 읽기는 키가 없어 이름으로 짝지으므로 반쪽만 키 기준이 된다). | 4-1 재현 안 됨: Gold `dim_brand` 5,273개를 이 키로 접으면 겹침 0, 키 = `bare`(name · bare UNIQUE). 이름 접기가 Gold 귀속을 합치지 않는다(규칙 5). |
| 2026-10-31 | 점검 5단계 | 회차별 분자 · 분모는 추이 툴팁 아래 줄 · 표 보기 행 · CSV 행으로 되살리고, 유형 선은 점 툴팁과 CSV '회차 답변 수' 행으로 되살린다(원본 WoW %는 HUB가 만든 값이라 뺀다). 답변당 언급 수 Δ는 달력 월에만 요약 아래 기간 줄 하나로 둔다. 줄에는 탭 · 히어로에 없는 그 지표만 둔다(리뉴얼 Citation의 답변당 인용 수 줄과 같음). 다른 안: 원본처럼 다섯 지표를 다 두기(네 지표는 탭 · 히어로에 이미 있다, W6 반복 줄이기). 전체 언급 수 Δ는 중립 색이다. 공용 함수라 원본 website · project도 같이 바뀐다. 다른 안: 리뉴얼만. 5-3(당사 위치 추이)은 재현 안 됨이라 그대로 둔다. | 규칙 7(레거시 KPI는 없애지 않음, 설계는 UX로), 규칙 5(HUB가 좋고 나쁨을 새로 정하지 않음). 근거는 `renewal-audit.md` 단계 메모 '5단계'. |
| 2026-10-31 | 점검 6단계 | Mention 순위표는 BFF가 모든 브랜드 행을 보내고 화면이 처음 100행 · 전체 검색 · '더 보기'(100행씩)로 보인다. 100위 밖 행은 서랍 행을 같이 실어 서랍이 같은 수치를 바로 보인다. 다른 안: BFF에서 쪽 나누기 · 검색(정렬 · 검색마다 요청), 서랍 행을 필요할 때 새 화면 + 프록시로 읽기(수치가 늦게 뜨고 실패 상태가 생김). 카드 제목은 '(상위 100)'을 빼고 트리맵에 '언급 상위 {n}개 브랜드'를 적는다. 복수 언급 기준의 열 정의는 BFF 계산을 그대로 적은 새 문구다. 다른 안: 복수 언급일 때 ⓘ를 숨기기(정보가 빠짐). | 규칙 7(설계는 UX로, 레거시 정보는 없애지 않음). 행은 수백~천여 개라 압축 뒤 44 KB 수준이다(global 최근 회차). 근거는 `renewal-audit.md` 단계 메모 '6단계'. |
| 2026-10-31 | 점검 7단계 | 서랍 › 인용 출처는 그 브랜드가 언급된 답변의 인용만 세고, 모수는 같은 서랍 프롬프트 탭 · 순위 행과 같은 Gold 조건(answer_brand_fact std_in ∧ competitive ∧ mention_count > 0)이다. 커버리지 분모도 그 답변이다(원본 API). 다른 안: 원본 API처럼 std_in만(competitive가 아닌 행이 live global 51개 브랜드 50,025행이라, 순위 행 · 프롬프트 탭과 모수가 달라짐). 당사 행(HMG 관점의 이름 HMG는 Gold 브랜드가 아님)은 두 탭 모두 own으로 읽는다(관점의 자사 브랜드가 언급된 답변). 다른 안: 이름이 Gold에 없으면 빈 목록(원본 API의 fail-closed, 원본 당사 행이 빈 목록이 됨). 인용 출처 표는 원본 열(점유율 · 커버리지 · 당사 표시)을 되살리고 늘 '—'이던 URL 열은 뺀다. 행을 누르면 그 아래에서 URL · 프롬프트를 고른다(Citation 서랍 부품). 다른 안: URL 열을 상세를 읽은 뒤 채우기(열이 펼치기 전까지 비어 있음). 유형 드릴다운은 리뉴얼 유형 카드의 당사 보기 행에 붙인다(원본 website · project 당사 유형 건수와 같은 신호 경로). | 규칙 5(새 판단 없이 Gold 플래그 · 키만 씀, 이름으로 brand_key를 찾는 것은 귀속을 바꾸지 않음) · 규칙 7(UX, 레거시 정보 유지). 근거는 `renewal-audit.md` 단계 메모 '7단계'. |
| 2026-10-31 | 점검 9단계 | Citation 출처 선호 매트릭스에서 인용이 0인 열은 지우지 않고 칸을 '—'로 두며, 칠하기 · cap · 발견에서 뺀다. 유형 다섯 열이 모두 0이면 원본 유형 차트의 빈 안내를 보인다. 다른 안: 0인 열을 표에서 빼기(어느 유형의 표본이 0인지 보이지 않음), 모두 0일 때도 '—'만 있는 표. '당사' 태그(U6)는 Gold의 표면별 자사 판정 그대로 둔다. 다른 안: `dim_source.owned_brand_bit`로 바꾸기. 범위 계정의 Website 도메인 표 · 서랍 · 내보내기는 본문과 같은 website 계정 규칙을 쓴다. | 0인 열: 원본이 '—'였고, 없는 값을 0으로 만들지 않는다(규칙 5). 열을 남겨 표본 0을 그대로 보인다(규칙 7). 빈 안내는 원본 문구다. U6: Gold 표 설명이 도메인 순위의 자사 표시를 표면별 자사 판정으로 정한다(`citation_cell` '자사 판정은 표면별', `dim_owned_base` 쓰임). `owned_brand_bit`는 출처 분류(당사 도메인)용이다. HUB는 두 Gold 값을 합치거나 고치지 않는다(규칙 5). 계정 규칙: 같은 화면이 두 범위를 읽는 결함이고, 원본 website 규칙을 따른다(2단계). |
| 2026-10-31 | 점검 10단계 | Website 도메인 표는 원본처럼 서버 쪽 '더 보기'로 101위 이하를 보인다. 같은 route `citation/domains`를 200행씩 읽고, 불러온 행을 모두 보이며, 카테고리 선택은 불러온 행 안에서 한다(검색 · 정렬은 서버가 전체에서). 다른 안: 6단계 Mention 방식(BFF가 모든 행을 보내고 화면에서 자르기). Global 표는 원본처럼 상위 100. 출처 구성 회차 수치는 같은 화면의 `live.categoryTrend`(원본 구성 차트가 그리던 값)를 점 툴팁 · 표 보기 · CSV로 보이고, 출처 하나면 선을 인용 수로 그린다. 회차 선은 필터 버튼 밖에 둔다(선 칸은 필터를 걸지 않음). 다른 안: 버튼 안에 두기(초점 가능한 점이 버튼 안이라 키보드로 닿지 않음). | 규칙 7(설계는 UX로). website 출처는 14,687개(2026-10-31)라 모든 행을 보내면 첫 응답이 약 3.6 MB이고, 다음 쪽은 1.2초 · 50 KB다. Mention 순위표는 행이 수백~천여 개라 전체 전송을 골랐다. 근거는 `renewal-audit.md` 단계 메모 '10단계'. |
| 2026-10-31 | 점검 11단계 | ACR 요약 발견은 W6 방식이다. 순서를 고정하고(당사 순위와 격차 → 후보군 포함율이 가장 가까운 경쟁사와의 Top1 ACR 차 → 엔진별 당사 1위 프롬프트 → 모든 엔진에서 1위인 경쟁사 → 당사 차종 전환율 → 당사가 선택되지 않은 프롬프트 → 가장 크게 움직인 브랜드), 값이 있는 앞 4개를 보인다. 문턱은 없고, 색은 당사 방향만이며, 경쟁사 사실은 info다. '후보군이 비슷한 경쟁사'는 당사 브랜드마다 포함율이 가장 가까운 경쟁사이고, Top1 차가 가장 작은 당사 브랜드를 보인다(Mention 유형 발견과 같은 규칙). 다른 안: 당사 합계로 비교(원본은 브랜드별이었고, 합계 포함율은 합집합이라 어느 브랜드의 차인지 흐려짐). 'HMG 계열' 배지는 그 행의 당사 판정에 리더가 쓰는 Gold 값을 따른다. 브랜드 행은 명부 `acr_entity_fact.own_bit`, 차종 · 맞대결은 `dim_brand.own_bit`다. 다른 안: 모두 `dim_brand.own_bit`(브랜드 표 안에서 당사와 계열이 서로 다른 Gold 값을 읽게 됨). 브랜드 표는 원본 정렬 5종을 모두 둔다(이름은 오름차순). 11-6(필터 무시 안내)은 리더가 무시하는 필터가 없어 만들지 않는다. | 규칙 5(HUB 문턱 · 판단 없음, Gold 귀속을 합치거나 고치지 않음) · 규칙 7(레거시 정렬 유지). Gold 설명: `acr_entity_fact.own_bit` '당사 비트: 명부', 표 쓰임 'Global ACR 브랜드별 ACR 표'. 두 Gold 값의 차이는 업스트림 D1. 근거는 `renewal-audit.md` 단계 메모 '11단계'. |
| 2026-10-31 | 점검 12단계 | AI Conversion: 수집기가 활성 속성의 하루를 빠뜨리면 기간 합계(W6)와 같은 규칙으로 그 조각(엔진 · 채널 · 세그먼트 전환 · 입구 페이지 · 이벤트 수)과 그 위의 비중 · 순위 · 7일 합도 모름이다. 시장(속성별) 값은 그 속성이 빠졌을 때만 모름이다. 이유는 Hero 안내 한 줄로 알린다(카드마다 되풀이하지 않음). Hero '사이트 전체'(report 5)와 채널 카드 합계 행은 이름을 나눈다: 합계 행은 '채널 합계'(채널 행의 합). 다른 안: 한 정의로 맞추기(합계 행을 report 5로 두면 행의 합과 달라지고, 비중 분모로 쓰면 보고서를 섞음). 관리자가 중지한 속성(unmapped)은 '수집 중지'라 부르고, 측정 범위 밖이라 시장 카드 목록 · 칩 total에서 뺀다(발견과 같은 total). 상태 카드의 속성 목록에는 남긴다. 다른 안: 시장 카드에 남기고 total만 빼기(칩 수와 행 수가 달라짐). | 규칙 5(부분합은 없는 정보, W6 '부분합 금지'를 넓힘) · 규칙 7(설계는 UX로, W6 반복 줄이기). 중지는 W6 결정(측정 범위에서 뺌)과 Admin › GA4 연동 문구('다음 수집부터 AI Conversion 화면에서 빠집니다'). 근거는 `renewal-audit.md` 단계 메모 '12단계'. |
| 2026-10-31 | 점검 13단계 | Global prompts의 브랜드 포함 여부 · 측정 종류는 Gold 값만 쓴다. 빈 값은 '—'이고, 필터는 범위에 빈 값 행이 있을 때만 '값 없음'을 더한다(측정 종류도 같은 규칙, 계획 밖). 다른 안: '값 없음'을 늘 두기(live에서는 늘 0건인 선택지). 범위 계정의 국가는 Gold 리더가 원본 API의 범위 규칙(B1: 대상 시장 미지정 · 실국가 없음 · 범위 국가 포함)으로 건다. 다른 안: 요청 필터 규칙(정확 포함, 미지정 제외). 이 읽기의 국가는 clamp가 붙인 범위뿐이고 live 결과는 같다. 열람 범위 pill은 누르면 브랜드 · 권역 · 국가 전체가 열리고, 권역 계정의 국가는 권역 국가다(리더 범위와 같음). 다른 안: pill title 툴팁에 나열(국가가 많으면 읽기 어렵고 키보드로 닿지 않음). '값 없음' 문구는 두 목록이 같이 쓰는 `standardPromptsView`에 둔다. | 규칙 5(없는 값을 만들지 않음, 원본 API 범위 규칙 그대로) · 규칙 7(설계는 UX로). 근거는 `renewal-audit.md` 단계 메모 '13단계'. |
| 2026-10-31 | 점검 14단계 | 기간 비교 억제는 Gold 리더 한 곳에서 정한다(비교할 값이 없을 때만). 화면 쪽 억제 이식 · 세 사유 문장, 쓰지 않던 적용일 상수 · `before_epoch` 분기는 지운다. 인용 도달 카드 각주는 이번 답의 값 출처 하나만 둔다. 다른 안: 직전 답의 출처도 적기(K는 각주를 '둔다'고만 했고, live에서는 둘 다 실시간이다). 프런트 문구 키 `periodCompare.reason.missingShare` · `startWindow` · `startMonth`는 남긴다. 다른 안: 지금 지우기(레거시 `front/lib/kpi` 순수 계층과 그 시험이 아직 쓰고, 그 계층은 페이지에서 닿지 않는다. 16단계 '다음 일'). golden은 리더가 보내지 않는 녹음 답을 지금 리더 답으로 바꾼다(11단계 방식). | 규칙 5(측정 범위가 달라 값이 튀어도 숨기거나 경고하지 않는다) · ⛔K. 근거는 `renewal-audit.md` 단계 메모 '14단계'. |
| 2026-10-31 | 점검 15단계 | ⛔L 적용. Mention 히어로는 비교 브랜드가 없으면 당사 선만 그린다. 유형 비교 · 발견의 기준은 그 유형에서 가장 앞선 비교 브랜드뿐이고, 비교 브랜드 값이 없으면 차이 · 발견이 없다. 가장 작은 유형 차이가 반올림해 0.0이면 '앞섬' 대신 '같음'(info)이다(계획 밖, W6 · 11단계 leak과 같은 규칙). ACR 지도는 점만 그리고 공용 `RnScatterChart`의 기준선 prop을 지운다(ACR만 씀). AI Conversion은 분해 대신 AI 유입 세션 · 세션 100회당 전환 · 전환을 직전 · 이번 · 증감으로 나란히 보이고, 엔진별 세션 변화와 '그 외' 줄은 둔다(두 값의 차일 뿐 기준값이 없다). 다른 안: 엔진별 세션 변화도 빼기(분해 카드의 일부였지만 L은 유입 · 효율 분해만 겨눴다), 차트 기준선을 선택 prop으로 남기기(쓰는 곳이 없다). 당사 순위 격차 변화가 반올림해 0.0이면 '변화 없음'(Mention · ACR). | 규칙 5(HUB가 새 기준선 · 판단을 만들지 않는다) · ⛔L · W6 문턱 제거. 근거는 `renewal-audit.md` 단계 메모 '15단계'. |
| 2026-11-02 | 검수 후속 | 트리맵 묶음 Δ는 모든 브랜드 Δ를 읽어 채우고, 그래도 빠진 구성원이 있으면 Δ를 내지 않는다. 다른 안: 부분합만 지우기(기본 Global 6타일 · Website 2타일이 회색이 되어 정보가 준다). 직전 회차에 행이 없는 브랜드는 0으로 본다(Gold는 0 행을 두지 않는다, 8-4). 우선 노출도 '상위 N%'는 원본대로 표 브랜드 수가 분모다(순위 없는 브랜드 포함). 전체 브랜드 분모로 바꾸지 않았고, 도움말에 분모를 적었다. 다른 안: 전체 브랜드 기준(원본 값과 달라진다). | 규칙 5 · 7, 사용자 '수정해' · '다시 넣어보자'. |
| 2026-11-02 | 검수 후속 2 | Website Prompts의 국가는 프롬프트가 측정된 국가다(`job_index.geo_key`, 측정이 없으면 사이트 국가). 다른 안: 사이트 국가 유지(필터의 Jeddah · Riyadh가 0개이고 Gold 셀과 어긋난다). 경쟁사 Δ는 화살표만 두고 당사만 색을 쓴다(Mention 규칙을 ACR · Overview 브랜드 표 · Mention 순위표 · Citation 범프로 넓힘). 다른 안: 지표 방향대로 칠하기(경쟁사 상승이 초록이라 HUB가 좋고 나쁨을 정한다). typeGap은 `info`다. 트리맵 색은 범례가 있는 증감 인코딩이라 그대로 뒀다. 다른 안: 판단 없는 색으로 바꾸기(요청 범위 밖). | 사용자 '수정 시작'(추천안), 규칙 5, W6 '색은 방향만'. |
| 2026-11-02 | Website Prompts 정리 | 실제 값으로 차트를 평가한 뒤(13개, 종합 44점) 사용자가 권고를 승인했다. 남긴다: KPI 3개(목록 프롬프트 · 최근 회차 측정 · 최근 회차 미측정), 엔진 조합(KPI 줄), 회차별 측정 프롬프트, 시장 커버리지. 뺀다: 측정된 프롬프트 · 측정 횟수 · 측정 회차 KPI, 측정 깊이, 언어, 타겟 도메인 카드, 행의 회차 띠(상세로) · 엔진 막대(엔진 점과 숫자로). 빠진 카드의 좁히기 `m` · `ans`도 없앴다. 다른 안: 카드를 두고 접기(값이 변하지 않거나 다른 카드와 같은 사실이라 접어도 얻는 것이 없다). 시장 표 기본 정렬은 빈칸 많은 순이고 프롬프트 많은 순을 고를 수 있다. 칸 색은 값 있음 / 없음 하나다(값이 100 · 200으로 몰려 진하기가 숫자를 되풀이했다). 빈칸 합계는 표시하지 않는다(Hyundai N 열까지 세면 뜻이 흐려진다). 회차가 없는 주는 빈 칸으로 둔다(추이의 `fill_trend_gaps`와 같은 규칙). 사이트 브랜드 비트 16은 'Hyundai N'으로 표시만 하고 Hyundai에 합치지 않으며, 브랜드 필터 선택지는 Gold 3개 그대로다. | 화면 원칙(설계는 UX로, 뺀 카드는 W4가 더한 것이고 원본 정보는 목록 · 상세 · 엑셀에 남는다), 데이터 원칙(Gold 귀속을 합치지 않음). |
| 2026-11-02 | Website Mention 개편 | 차트 평가(42점)와 중립 검증 뒤 사용자 승인('1. 제안대로 2. 제안대로'). Website 전용 본문을 두고 표준 Mention 부품은 export · 선택 prop만 더했다(Global 그대로). 노출률은 바꾸지 않고, 시장 표에 '브랜드 언급 없는 답변 수'(Gold `answer_fact.ment_total = 0`)를 값 옆에 경고 없이 둔다. 분석이 비어 돌아온 답변은 업스트림 D8로 묻는다. 시장 표 기본 정렬은 다른 브랜드가 언급된 미언급 프롬프트 많은 순이다(하락 순은 분석 빈 답변을 맨 위로 올림). 요약 시장 발견은 최대 감소 · 증가를 함께 보인다(문턱 없음). KPI 칸은 선택기(`?kpi=`), 브랜드 상세는 KPI 카드 머리 버튼으로 여는 별도 보기(`?view=brands`)다. 다른 안: 선택기 끝 다섯째 칸(빈 세로 칸이 네 칸 폭을 줄였다). 브랜드 열은 계정 범위 안 브랜드가 둘 이상일 때만 보인다(`access.clamp`가 범위 밖 브랜드를 바꾸므로). 당사 대 비교 표는 마지막에 고른 비교 브랜드를 따른다. 빠진 것(경쟁 구도 표 · 엔진 카드 · 트리맵 · 주별 순위 · 위치 트랙)의 값은 순위표 · 비교 표 · 엔진 표 · 주별 표에 남는다. 정본은 `website-mention-redesign.md`. | 데이터 원칙(Gold 값을 나란히, 새 판단 · 경고 없음), 화면 원칙(탭 아래에는 탭이 바꾸는 것만, 레거시 값은 남김, 설계는 UX로). |
| 2026-11-02 | E | 커뮤니티 수집 소스는 HUB가 갖는다. HUB 표 `catalog.interest_source`에 두고 외부 API 목록(`interest_source`)으로 내보낸다. 다른 안: 옮기지 않기(원본 목록이 사라지고, 입력을 정할 곳이 없어진다). 지금 읽는 수집기가 없다는 사실은 화면 안내에 그대로 적는다. | 선택 추이(규칙 2): A · G · 코드표에서 사람이 정한 입력은 늘 HUB 정본을 골랐고, 외부 API는 수집 입력을 낸다(규칙 5). 재확인: Gold 표에 없고 저장소에 읽는 수집기가 없다. Gold 소셜 코퍼스는 `scope_context_mirror` 스냅샷 1개다. |
| 2026-11-02 | 3 범위 | 옮긴다: 키워드 · 소스 목록을 탭 2개로(`?tab=`), 추가, 메모, 정렬, 빈 상태. 켜기/끄기 · 삭제는 중지 · 재개 하나로 합친다(GA4 범위 결정과 같음, 행은 지우지 않음). 더한다: 수집 조건(공통 구조), 편집, 필터 · 검색, 변경 이력, Gold 값 나란히(키워드는 조건별 수집일, 소스는 활성 스냅샷의 host 근거 수), Gold에만 있는 키워드 · host의 업스트림 행과 추가 버튼. 키워드 하나가 소스 · 브랜드를 여럿 가질 수 있다(원본은 행을 나눴고, 키가 term_norm이라 합쳤다). 옮기지 않는다: 소셜 리서치 카드(원본 페이지가 데이터를 넘기지 않아 늘 빈 상태, Gold `ctx_research_*` 0행, 실행 경로 없음). 처음 값: 키워드는 Gold 84개를 활성으로 넣고 정리는 관리자가 한다. 다른 안: 빈 목록으로 시작(공통 구조와 다르다). 소스의 코퍼스 비교는 www.를 뺀 host가 정확히 같을 때만 한다(하위 도메인을 묶으면 HUB가 판단을 더한다). 머리 칩의 출처 수는 Gold `source_total`(606)을 그대로 보인다(목록은 www.를 접어 593행). 소스 상태는 '반영됨'이라 부르지 않고 '코퍼스에 있음'이라 부른다(이 목록을 읽는 곳이 없다). | 규칙 5(HUB가 판단 · 숫자를 새로 만들지 않음, 없는 정보 금지) · 규칙 7(설계는 UX로). GA4 범위 결정의 중지 · 재개 선례. |
| 2026-11-02 | F | 엔티티 역할은 버전 행과 변경 이력만 둔다. 저장하면 HUB에 남고 외부 목록으로 발행되며, Gold가 반영할 때까지 '반영 대기'로 보인다. 초안 · 적용 요청 · 미리보기 · 승인 · 포기 · 되돌리기는 옮기지 않는다. 다른 안: 원본 흐름을 옮기기(적용은 로더가 Gold를 다시 쓰는 일이고, 미리보기는 HUB가 KPI를 다시 계산하는 일이라 규칙 5와 맞지 않는다). | 규칙 5(Gold에 쓰지 않음, 없는 정보를 만들지 않음). Gold `dim_cycle.ecat_ver`는 전 회차 NULL이라 원본 흐름이 Gold에 쓰인 적이 없다. 2 · 3단계와 같은 저장 → 발행 → 반영 대기다. |
| 2026-11-02 | 4 범위 | 옮긴다: 엔티티 목록(`entity_mention_total` 1,927개 + 역할이 있는 엔티티), 표시 브랜드, 답변 · 언급(전 기간), 역할(자사 · 경쟁사 · 제외), 자사 브랜드, 메모, 관측 표면, 언급 표본, 행별 이력, 전체 최근 변경. 합친다: 검토함은 첫 발견일 정렬과 역할 필터로, L2 린트는 자사가 바뀔 때의 확인 체크로. 옮기지 않는다: 병합 · 모 브랜드 · 표면 추가/차단 · 허브 엔티티 추가(Gold 귀속에 손대는 일이고 입력 자리가 없다, 업스트림 C3), 언급 표본 접근 감사(읽기 감사 표가 없다, 다른 화면의 답변 원문과 같음). 외부 API에는 사람이 정한 역할만 낸다. 다른 안: 발견 엔티티도 내기(분석 결과라 규칙 5와 맞지 않는다). 언급 표본은 Global 최근 8개 회차의 표시 브랜드 답변 2,000건 안에서 찾는다(엔티티로 바로 읽으면 18초로 Gold 제한 15초를 넘는다). 드문 표기는 안 나올 수 있어 화면에 적었다. 관측 표면의 숫자는 관측된 달 수다(Gold에 표면별 언급 수가 없다). 역할 미지정은 경쟁사로 보인다. | 규칙 5 · 규칙 7(설계는 UX로), Gold 귀속 원칙. |
| 2026-11-02 | 수집 소스 채널 | 채널은 Gold에 없는 HUB 입력값이다(`ctx_*` · `dim_source`에 없음). 등록 전 코퍼스 행에는 Gold `dim_source`의 출처 분류를 새 열로 보인다(593개 중 362개, www.를 뺀 도메인이 정확히 같을 때만). 이름이 곧 채널인 분류만 채널 열에 흐린 '제안'으로 보인다(커뮤니티·포럼 → 커뮤니티, 소셜·영상 → 소셜, 뉴스·미디어 · 자동차 미디어 → 뉴스, 공식 → PR, 지금 125개). 필터 · 정렬 · 추가 폼 기본값이 같은 값을 쓰고, 소스로 추가하기 전에는 저장 · 발행되지 않는다. 다른 안: 출처 분류 열만 두기(채널 열이 모두 비고 채널 필터가 늘 0건), 코퍼스 host를 제안 채널로 일괄 등록(사람이 정하지 않은 값이 외부 API로 나감), 상위 도메인의 분류를 물려받기(158개를 더 채우지만 `kin.naver.com`이 자동차 미디어가 됨). | 규칙 5(없는 정보를 저장 · 발행하지 않음, 표시 묶음은 허용) · 규칙 7(설계는 UX로). |
| 2026-11-02 | 마스터 룰 | 규칙의 정본을 `CLAUDE.md` 한 파일로 모았다. 이 파일의 절대 규칙은 번호 대응표만 남겼다. 바뀐 것: '확인 · 봐 줘 · 점검'은 보고만 한다, 사용자가 지시하면 앞 단계 확인 전에도 다음 단계를 시작한다, 값은 Gold 표 · 열 설명과 대조한다, 시험은 기준선보다 새 실패 없음으로 본다, 넘기는 결정의 형식을 정한다, 일관성만으로 고르지 않는다, 응답은 결론 + 표 + 원인 + 다음 행동(사용자가 고른 레벨 4)이다. 세션 시작 때 이 파일을 자동으로 불러오지 않고 '지금 할 일'과 '결정 대기'만 읽는다. 첫 답변에 '지금 할 일'을 옮겨 적는 규칙은 없앴다. 데이터 원칙은 지금처럼 어기지 않는다로 둔다. 다른 안: 사용자 지시가 데이터 원칙에 앞선다는 조항(사용자: 현행대로), '확인'에 명백한 결함 수정까지 포함(사용자: 보고만). 훅 · 검사 명령 · 경로별 규칙 · 작업 트리 분리는 적용하지 않았다. | 사용자 결정. 세션마다 읽던 137 KB 중 규칙은 약 9 KB였다. |
| 2026-11-02 | 점수표 결함 | 시장 표의 경쟁사 인용은 그 시장의 언급 1위 경쟁사(다른 지표 탭과 같은 브랜드)의 공식 출처 인용 ÷ 그 시장 전체 인용이다. 기간을 고른 브랜드 표에서 당사 Δ는 카드 칩과 같은 기간 비교이고, 경쟁사 Δ는 뺀다. 다른 안: 경쟁사도 직전 기간을 따로 읽기(읽기가 늘고 카드에 없는 값이 된다). Citation 카테고리 거르기는 서버에서 전체 출처로 한다(10단계의 '불러온 행 안에서'를 바꿈, Website도 같음). URL은 Gold `url_norm`으로 묶고 가장 짧은 표기로 보인다. 다른 안: url_key 그대로(같은 페이지가 두 줄). 인용 URL 화면 첫 읽기는 약 4.3초다. ACR 패널은 `funnel/acr/coverage`로 셀이 있는 회차 · 국가 · 카탈로그만 보이고, 원본 화면은 그대로다. taxon 코드 대소문자 쌍은 필터에서 하나로 본다(표시 묶음). Global prompts 변경 이력은 HUB `catalog.prompt_version`을 읽고, 범위 계정은 전 시장 피드라 보지 못한다(프롬프트별 타임라인은 본다). | 규칙 5(Gold 값 · Gold 정규형만 사용) · 규칙 7(설계는 UX로). |
| 2026-11-02 | D | DataForSEO · OpenRouter 키는 아직 없고 추후 받는다. 유료 호출 범위와 비용 상한은 받는 계정에 정해져 있어 HUB가 미리 정하지 않는다. 5단계는 계정을 받은 뒤 범위 확인부터 시작한다. 다른 안: 키 없이 먼저 만들기(실제 호출을 시험할 수 없고, 계정의 범위 · 한도가 설계를 바꿀 수 있다). | 사용자 답(2026-11-02). 시작 시점은 규칙 1(단계를 건너뛰지 않음)과 공통 완료 기준(핵심 흐름 e2e)을 따랐다. |
| 2026-11-02 | 계정 대기 화면 | GA4 · DataForSEO(+OpenRouter) 계정이 없어 데이터를 받지 못하는 화면 3개(Global · Website AI Conversion, 키워드 도구)는 메뉴에 공사 아이콘 대신 열쇠 아이콘(올리면 필요한 계정)을 붙이고, 화면은 샘플 데이터로 그린 뒤 반투명 막과 계정 안내로 덮는다. 샘플은 프런트 고정 값(AI Conversion = 본문 render 시험 fixture, 즉 BFF 출력 · 키워드 도구 = 만든 행)이고 BFF · DB · 외부 API로 가지 않는다. 막 아래는 inert라 누르거나 고르거나 복사할 수 없고, 필터 패널도 덮는다. AI Conversion은 BFF 상태가 noprop(읽을 수 있는 GA4 속성 없음)일 때만 막을 쓰고, 권한 대기 · 측정 대기 · 결과 없음 · 연결 끊김은 지금 상태 카드를 둔다. 다른 화면에서 국가가 붙어 오면 noprop 대신 '조건 없음'이 뜨던 것을 BFF에서 고쳤다(속성이 하나도 없으면 noprop). GA4 연동 화면은 계정 없이도 등록할 수 있어 표시하지 않는다. 계정을 받으면 `ACCOUNT_PAGES`에서 그 줄을 지운다. 다른 안: 미구현 표시 유지(들어가 봐야 빈 화면), 권한 대기도 막으로 덮기(등록한 속성 목록과 이유가 가려진다), 메뉴 표시를 BFF 상태로 바꾸기(레이아웃마다 GA4 읽기가 는다). | 사용자 요청(2026-11-02). 샘플은 분석값이 아니라 화면 미리보기이고, 실측 값과 함께 보이지 않으며 '샘플 화면'이라고 적어 규칙 1 '없는 정보를 만들지 않는다'와 맞춘다. |
| 2026-11-02 | 범위 교차 | 계정 범위는 저장 · 집행이 평면 배열이라 브랜드 × (고른 권역 국가 합집합)으로 풀린다('Hyundai 유럽 + Kia 북미' 계정이 Hyundai 미국 · Kia 독일도 읽음, 원본도 같음). 권역 · 국가 담당은 브랜드를 하나만 고르게 한다. 권역이 원래 브랜드별(`kia-western-europe` 등)이라 저장 모양을 바꾸지 않고 교차가 사라진다. 본사(HQ)는 지금처럼 여러 브랜드. 다른 안: 브랜드별 권역 · 국가로 저장 모양 바꾸기(새 원칙 · 마이그레이션), 지금대로 원본과 같은 교차 범위. 운영 웹에 여러 브랜드를 맡는 권역 · 국가 계정이 있는지는 확인하지 못했다(운영 계정 목록 없음, 로컬 0개). | 사용자 결정('제안대로', 사용자 관리 검수). |
| 2026-11-02 | 발행 시점 판정 (Gold 사용 방식) | 화면은 완결된 주까지만 보인다. 서비스 전체가 기준 주 하나를 공유하고, 주기는 월요일 시작 주로 맞춘다(Global · Website 날짜가 제각각이면 안 된다). HUB BE의 cron이 Gold의 회차 상태(`dim_cycle.status` · servable) · 발행 상태(`publication.state`) · 공개 버전(`active_release.version`)을 지켜보다 다음 주가 Global · Website 모두 완료되면 기준 주를 올린다. Gold 정보를 믿는다('n시간 그대로면 완료' 확인 없음). Gold 갱신이 지나치게 늦으면 FE에 문제를 보인다. Gold가 지난 주를 재발행하면 그 발행본을 따른다. 다른 안: Gold 지정대로 혼합(카드류만 발행 세대), 모든 화면 라이브(지금), n시간 안정 확인을 겹치기, 표면마다 각자 최신 회차. | 사용자 결정. 지금은 화면마다 자기 데이터의 최신 발행 회차를 따로 고르고, `publication` · 공개 버전은 읽지 않는다. Gold와 아직 협의 전이다. |
| 2026-11-02 | Website Overview 모수 | KPI 카드 · 증감 · 추이 · 시장 표 · 출처 구성비는 Gold 정의대로 보고 유닛 소속 ∧ 제외 유닛 아님(`web_report_prompt`)만 센다(10-09 답변 20,216 → 19,400, 노출률 88.0 → 88.9). 다른 안: 지금 그대로, 운영 웹(운영 중인 레거시) 대조 후. | 사용자 결정. Gold 표 설명, 옛 구현 `measure.py`에도 같은 게이트. |
| 2026-11-02 | ⑥ · 자사 · 타겟 URL 인용률 | 발행 시점 판정(`pub_cell_web`)으로 센다. 단위는 Gold 발행값과 같은 보고 유닛별 프롬프트 수 합. 09-11 발행 판정으로 다시 세면 자사 77.9 · 타겟 71.8, Gold 발행값 78.7 · 58.0이라 타겟이 맞지 않는다 — 업스트림 D6에 덧붙였다. 다른 안: 라이브 그대로, 답변 단위(09-11 자사 59.4). | 사용자 결정('발행 시점 단위'). |
| 2026-11-02 | 인용 URL 수 | 주 수치는 '페이지'(Gold `url_norm`, Global 긍정 130,284), Gold 정의의 'URL'(`url_key`, 226,805)은 툴팁. 목록은 페이지 단위 한 줄. 다른 안: Gold 정의만, 둘을 동등하게 나란히, 그대로(이름 'URL'). | 사용자 결정. 마케터 · 기획자는 '어떤 페이지가 근거로 쓰였나'를 본다(같은 기사가 utm 꼬리로 4위 · 6위로 갈림, 합치면 2위). |
| 2026-11-02 | 출처 선호 매트릭스 '전체' 열 | '전체'는 Gold 실제 전체 비중(출처 구성과 같은 값)이고 칸 색은 그 값과의 차. 유형 축은 열을 더해 중복 계상했다(1,400,034건 대 실제 934,592건, 공식(HMG) 32.3 대 25.0). 다른 안: '전체' 열과 색칠 빼기, 그대로. | 사용자 결정. |
| 2026-11-02 | 기준 주 세부 | 주 이름은 ISO 방식(그 주 목요일이 속한 달의 몇째 주, 예: 10/5~10/11 = 10월 2주차). 기준 주가 끝난 뒤 10일이 지나도 다음 주가 완료되지 않으면 FE에 지연 안내를 띄운다. 한 표면에 회차가 없는 주는 기준을 막지 않고 그 표면의 '측정 없음'을 그대로 보인다. 임의의 여과 · 필터 없이 데이터는 정직하게 보인다. 다른 안: 달력 월 기준 주차, 14일 지연, 회차 없는 주에서 기준을 멈추기. 2026-11-03 '미적재 표면'으로 좁혔다(그 표면의 더 뒤 회차가 Gold에 없으면 아직 적재 전으로 보고 막는다). | 사용자 결정. Global 회차는 월요일, Website 회차는 금요일이라 같은 ISO 주에 든다(지금 기준 주 = 10월 2주차: Global 10/5 · Website 10/9, 끝난 지 22일). |
| 2026-11-03 | 미적재 표면 | 한 표면에 그 주 회차가 없으면 Gold가 그 표면의 더 뒤 회차(상태 무관)를 가질 때만 건너뛴 주로 보고 '측정 없음'으로 둔다. 더 뒤 회차가 없으면 아직 적재 전으로 보고 그 주를 막는다('A 10/5 · B 10/12 → 10/5'). Gold에 행이 전혀 없는 표면은 막지 않는다. '기준 주 세부'의 '회차 없는 주는 막지 않는다'를 이 경우만 좁혔다. 다른 안: 늘 막지 않기(한 표면 적재가 늦으면 미완료 주가 열리고 늦은 회차가 사이트마다 따로 보인다), Gold에 수집 시작 때 회차 행(status 0)을 보장해 달라고 묻고 기다리기(답 전까지 위험이 남는다). | 규칙 2: 사용자의 적재 이격 예시와 '측정 없음' 결정을 함께 지킨다. 적대적 검증 r2-1. 6/8~11/3 매일 옛 · 새 규칙의 기준 주가 같다(차이 0일). Website가 빈 주(6월 초 3주 · 07-27 주)는 뒤 회차가 있어 '측정 없음' 그대로다. 남는 위험: 한 표면 측정을 영영 멈추면 기준 주도 멈춘다(10일 뒤 지연 안내). |
| 2026-11-03 | Website 프롬프트 등록 목록 | 기준 주에도 Gold의 지금 등록 목록(`dim_prompt` web_reg)을 그대로 보인다. 기준 주 뒤에 처음 측정된 프롬프트 · 사이트도 목록 · 개수에 들고 '측정 없음'으로 보인다. Gold에 등록일 · 버전 축을 묻는다(업스트림 D9). 다른 안: 측정일로 기준 주 뒤 첫 측정 행을 뺀다(HUB가 등록 정의를 새로 만든다). | 규칙 1, 엔티티 누계를 Gold 값 그대로 둔 선례(업스트림 D10). 지금 기준 주 영향 0건(기준 주가 09-21 주라면 44행). 적대적 검증 r4-1. |
| 2026-11-03 | 적대적 검증 통과 기준 | 서비스 기준 주 적대적 검증은 4회차부터 상 · 중만 고치고 하 지적은 할 일 0절에 남긴다. 5회차에서 끝낸다(5회차 중 3건은 고쳤고 6회차 검토는 하지 않았다). 다른 안: 새 확정 0건 회차까지 계속(7~9시간 이상), 지금 단계에서 멈추기. | 사용자 결정(시간). |
| 2026-11-03 | 서비스 기준 주 저장 | 데이터 DB `catalog.service_week` 표 하나에 바뀔 때마다 한 행(이력)을 쌓고 같으면 `checked_at`만 고친다. 최신 행은 뷰 `current_service_week`. 쓰기는 전용 계정 `hmg_service_week_writer`(이 표의 열 INSERT · UPDATE(checked_at)만, API에는 주지 않음), 읽기는 기존 데이터 DB 조회 계정. 판정은 가장 최근 완료 주이고 뒤로 가지 않는다. VM은 매시 10분 cron(설치는 사용자). 데이터 DB를 두었는데 읽지 못하면 Gold 화면은 503, 데이터 DB를 두지 않으면 상한이 없다. 다른 안: 운영 DB에 두기, 카탈로그 쓰기 계정 재사용, 한 행 덮어쓰기(이력 없음), BFF가 요청마다 Gold로 판정. | 규칙 2, 공통 구조('전용 DB 역할', 기준값 이력 표). |
| 2026-11-03 | GA4 · SEO와 기준 주 | AI Conversion · AI Visibility(GA4 · SEO)는 서비스 기준 주와 따로 둔다. 그 화면은 HUB가 날마다 모으는 데이터를 마지막 수집일까지 보이고, 기준 주 칩 · 지연 안내를 보이지 않는다(지금 동작 그대로). 다른 안: 기준 주로 묶기(완결된 일 단위 값을 기준 주에서 자른다). | 사용자 결정('GA4와 SEO는 무관해. 따로 두자'). |
| 2026-11-03 | Project 메뉴 | 안 D: 프로젝트는 자기 브라우저 탭에서 연다. 메인 사이드바의 Project 구역은 'Project list' 하나로 그대로 두고, 목록 행은 이름 있는 프로젝트 탭 하나(`hgh-project`)를 열거나 다시 쓴다(⌘ · Ctrl 클릭은 탭을 더 엶). 프로젝트 탭의 사이드바는 프로젝트 카드(ID와 Gold 값, ⇅로 같은 메뉴의 다른 프로젝트) + 원본 프로젝트 메뉴(순서 · 라벨 그대로, AI Visibility · ACR은 원본처럼 뺌)이고, 'Project list'는 원래 탭(`hgh-main`)에서 연다. 탭 제목은 '<메뉴> · <ID 8자리> · 앱 이름'. 범위 계정에는 Project 구역을 숨긴다(⛔J). 다른 안: A 한 사이드바에 프로젝트 문맥 구역(프로젝트를 열면 Global · Website 접힘), B 레거시처럼 사이드바 전체를 프로젝트 메뉴로(리뉴얼엔 위 GNB가 없어 다른 구역이 멂), C 메뉴에 최근 프로젝트 나열(3단 트리 · ID만), E 상세를 페이지 안 탭으로(디자인 규칙 금지). | 사용자 결정(사용자 제안 'D안이 좋다'). 목업 `docs/design/ui/project-menu-mockup.html`. 메인 메뉴가 늘지 않고, Website Overview 카드의 새 탭(W1)이 선례. |
| 2026-11-03 | Project 필터 축 | 프로젝트 탭 화면의 필터는 원본 프로젝트 패널 그대로 기간 · 측정 국가 · AI 엔진 · 커스텀 태그(`cf_<fieldId>`, '태그' 구역)다. 측정 국가가 하나면 국가를 잠근다. 브랜드 · 언어 축은 없다(원본도 언어 옵션을 넘기지 않았고, 프로젝트에는 브랜드가 없다). 저장한 필터는 화면마다 `project-<화면>` 한 목록이고 프로젝트끼리 같이 쓴다(다른 프로젝트의 태그 조건은 그 프로젝트에서 빠진다). 다른 안: 언어 축 더하기(할 일 6절 초안), 프로젝트마다 저장 목록. | 원칙(원본 축 그대로) · 사용자 지시('축은 원본 프로젝트 필터와 같다'). |
| 2026-11-03 | Project 당사 · Dashboard 구성 | 프로젝트 화면의 당사는 Gold 관점 기본값 HMG(현대 · 기아 · 제네시스 합)다. 원본 project 분기(`mention/view`)가 같다(실측: 35ae7ec0 당사 'HMG' 611회). Dashboard는 Website Overview 부품(KPI · 엔진 · 출처 · 추이)과 프로젝트 현황이고, Gold에 없는 원본 값(후보 수 · 멤버 수 · 프롬프트 상태 · 최근 후보)은 '데이터 없음'으로 둔다. 원본의 빠른 실행 링크는 메뉴와 같은 일이라 뺐다. 다른 안: 프로젝트 브랜드로 당사 정하기(Gold `kpi_cell.bgrp`에 프로젝트 셀의 브랜드 비트가 있다. 35ae7ec0은 1=Hyundai) — HUB가 새로 정하는 판정이라 하지 않았고, 업스트림에 물을 거리로 남긴다. | 원칙(원본 · Gold 값 그대로). |
| 2026-11-03 | Project 입력 정본 | (D-7 · D-6) 프로젝트 입력의 정본은 HUB다. 레거시 대조에서 원칙과 맞지 않은 동작은 바꾼다: Scope 답변 당겨오기 · 판정 · 읽기 투영(적재 IG-1 · IG-2)과 설정 변경 재판정은 살리지 않고 '저장 → 발행 → Gold 반영 대기'로 둔다. 측정 실행은 Scope 쓰기(아웃박스)만이고 경로(U8)를 받은 뒤 만든다. DataForSEO 결과는 Gold에 쓸 수 없으니 HUB 수집 저장소에 두고 계정(⛔D) 뒤에 만든다. 키워드 신선도(24시간)는 재수집 판단에만 쓰고 화면 경고로 두지 않는다. 멤버 · 역할은 관리자 전용(⛔J) 유지, 만들지 않는다. LLM 초안 생성에 Gold 결과를 보내는 것은 허용한다(공개가 아닌 입력 생성용 가공 호출). D-6: Intent는 프로젝트 탭에 Gold `kw_*` · `ctx_*` 읽기와 추적 키워드 입력으로 두고 Admin으로 옮기지 않는다. 다른 안: 레거시 운영 DB · API를 되살려 정본으로 두기, 멤버를 HUB 운영 DB 프로젝트 역할로 만들기, Admin 고객 관심에 수집 결과 붙이기(D-6 첫 제 안). | 사용자 결정('판정대로 진행', 레거시 대조 보고의 제 안 그대로. ①멤버 · ②LLM은 제 안으로 정했고, ③Scope 경로 · ④`app.project` 행은 U8 · U9). 근거: 데이터 원칙(HUB 판단 없음 · Gold에 쓰지 않음), 결정 A · E · F · J. |
| 2026-11-03 | 프로젝트 프롬프트 적재 | 프로젝트 프롬프트 · 커스텀 태그는 새 표 없이 HUB 데이터 DB의 기존 카탈로그에 둔다: 프롬프트는 `catalog.prompt` · `prompt_version`(`project_id`), 태그 열은 프로젝트 정의 `custom_fields`, 태그 값은 프롬프트 정의 `custom_values`. 처음 값은 Gold 가져오기가 이미 기록한 3,072개(98개 프로젝트, 태그 열 160개)이고 지금 Gold 값과 모두 같아 따로 가져오지 않는다. 고칠 때마다 `recorded_by`가 있는 버전을 더하고 행은 지우지 않는다(삭제 = archived, 복원 가능). 버전 행이 곧 외부 API 발행(`change_seq`, `ext.prompts`)이다. HUB가 한 번 고친 항목은 Gold 가져오기가 HUB 키를 덮어쓰지 않고 Gold 키만 갱신하며, HUB 소유 프롬프트를 removed로 바꾸지 않는다. 상태는 draft · active · paused · archived · removed. 쓰기 계정 `hmg_project_editor`(프로젝트 표면만, 트리거). 다른 안: Admin 2~4단계처럼 별도 HUB 표 + 이력 표 + 기준값 set 발행(같은 프롬프트가 두 곳에 생기고 수천 행 set을 쓰기마다 다시 기록), 운영 DB에 두기(측정 입력이 외부 API 경계 밖), Gold 출처 프롬프트는 읽기 전용(Global 편집 선례, 결정 A 전이고 D-7과 맞지 않음). | 사용자 지시('db에 어떻게 적재할지 정하고 진행') · 규칙 4(원칙으로 결정). 데이터 DB의 설계(README '프로젝트·프롬프트 정의/버전'), Gold 표 설명('GEO HUB 프롬프트 태그 값의 투영'). |
| 2026-11-03 | 프로젝트 프롬프트 편집 범위 | 원본 Prompt 화면에서 옮긴 것: 수동 추가(줄마다 초안, 같은 원문은 건너뜀), 원문 · 언어는 초안만, 측정 유형은 언제나, 태그 값(칸 · 선택 일괄 · 지우기), 태그 열 추가 · 보관 · 복원(예약어 · 같은 이름 거부), 측정 중지 · 재개, 삭제 · 복원(원본은 완전 삭제, HUB는 이력을 남기고 되돌림), 변경 이력. 미룬 것: 측정 실행(U8), 후보 풀, 엑셀 가져오기, 원본 분류 메타. 태그 완전 삭제는 옮기지 않는다. 행은 Gold와 같은지만 견준다(중지는 Gold에 상태가 없어 견주지 않음). 추가한 뒤에는 초안 탭으로 옮긴다(측정 전이라 목록 끝으로 정렬되기 때문). 다른 안: 일괄 중지 · 삭제(원본은 행마다), 추가 뒤 전체 탭 유지. | 규칙 2 · 3 · 7(원본 기능 · UX). |
| 2026-11-03 | Intent 원형 막 | (사용자 '원형은 만들되 백드랍으로 막아두자') Project › Intent 두 화면은 원본 프로젝트 화면을 샘플 행으로 그리고, 다른 계정 대기 화면과 같은 막을 쓴다. 막의 안내는 두 화면 모두 기존 'DataForSEO · OpenRouter 계정 필요'(U3 한 건)다: Google Keyword는 검색량 · 검색 결과 · 관련 검색어(DataForSEO)와 프롬프트 생성(OpenRouter), Social Scraping은 프롬프트 생성(OpenRouter)이 그 계정을 쓴다. 원본의 탭 · 펼침 패널은 막 아래에서 열 수 없어 모든 부분을 한 번에 보인다(키워드 도구 선례). 다른 안: Social Scraping에 'OpenRouter 계정 필요'를 따로 두기(인계는 U3 한 번이라 열쇠를 나눌 일이 없다), 계정이 아닌 '준비 중' 막(디자인 규칙의 막은 계정 대기용이고, 원본 기능이 실제로 계정을 기다린다). Gold `kw_*` · `ctx_*`는 있지만 프로젝트 열이 없어 이 프로젝트의 실측 값이 아니므로 '실측 값이 있으면 막을 쓰지 않는다'에 걸리지 않는다. | 사용자 지시 · 규칙 4(원칙 · 추이: 3043512 키워드 도구 · P5 Conversion의 계정 막). |
| 2026-11-03 | 인용 출처 버전 | 인용 출처 분류 입력(교정 · 시드 · 공식 소셜 · 코드표)은 프롬프트처럼 버전을 데이터로 남긴다. 표마다 `<표>_version`(키마다 1, 2, …, 바뀐 뒤의 행 전체, 기록 시각 · 기록자 · `change_seq`)을 두고, 현재 값 표에 걸린 트리거만 쓴다. 현재 값 표와 그 제약(코드표 순서 중복 금지 등)은 그대로 두고, 현재 행은 늘 최신 버전과 같다. 이전 기록은 이력 표를 현재 행부터 거꾸로 되짚어 옮겼다(발행 set 21개가 모두 그 시점 버전과 같음). 목록 단위 버전은 발행 set(`reference_set.version`) 그대로다. 프롬프트와 묶을지 따로 둘지는 정하지 않았다(같은 `change_seq`라 어느 쪽이든 읽힘, D-8). 다른 안: 프롬프트처럼 현재 값을 최신 버전 뷰로 바꾸고 UPDATE 권한을 없애기(대화에서 먼저 낸 안. 보장은 같고, 코드표 순서 중복 금지 같은 표 제약을 DB에서 잃어 트리거로 다시 만들어야 한다), 이력 표(차분)만 두기(가져온 첫 행에 메모 · 상태 · 번호 · 설명이 없어 과거 상태를 보장할 수 없음), 발행 set만 두기(업스트림 열과 활성 항목만 담김). | 사용자 '버전이 데이터로 명확히 남도록, 프롬프트처럼' · '진행'. 데이터: 로컬 이력 844행 중 가져오기 행은 바뀐 열만 담음(소셜은 matchers만, 코드표는 이름 · 순서만). |
| 2026-11-05 | 서비스 팔레트 | 사용자 확정 팔레트(Point · Surface · Text · Chart - Own · Chart - Other · System)를 리뉴얼 화면 전체에 쓴다. 토큰 이름은 두고 값만 바꿨다(`rn-navy` = 포인트 파랑 #1e38fa). 차트 계열색은 `components/renewal-ui/palette.ts` 한 곳에 두고 화면은 거기서 읽는다. 옛 색의 역할을 그대로 옮긴다: 남색 계열 → Chart - Own(단계는 기준색에서 옅은 쪽으로), 비교 브랜드 색(주황 · 초록 · 보라) → Chart - Other 주황 · 분홍 · 보라, 회색 맥락 → #d5d5d6, 좋아짐 · 나빠짐 · 주의 → System. 핵심 카드는 Chart - Own 3 → 2 → 1 그라데이션(포인트 파랑이면 카드 안 흰 글자 72%가 4.3:1). System 색은 칠 · 옅은 칠에만 쓰고, 글자 · 아이콘은 같은 색을 Text #101012와 섞은 진한 색(#278323 · #d01b26 · #77750a, 흰 바탕과 12% 칠 위 4.5:1). `rn-faint`(#d5d5d6, 1.5:1)는 값 없음 · 비활성에만 두고, 메뉴 아이콘 · 언어 코드 · 순위 숫자처럼 읽는 값은 `rn-muted`로 옮겼다. 원본 (dash) 화면은 그대로다(design-rules '원본 화면은 지금 껍데기 그대로'). Chart - Other 주황의 네 번째 값은 목록에 없어 이미지에서 뽑았다(#ffd6cb, 아직 쓰는 곳 없음). Point 3(#5afbd9)도 쓰는 곳이 없다. 다른 안: 핵심 카드를 포인트 파랑으로(흰 글자 72%가 AA 미달), System 색을 글자에 그대로(초록 1.5:1 · 노랑 1.2:1), 비교 3색에 노랑을 넣기(흰 바탕 1.65:1로 선이 옅음), 보라를 둘째로(당사 파랑과 CIEDE2000 18.9), 토큰 이름을 `rn-point`로 바꾸기(약 330곳의 이름만 바뀌고 같은 작업 트리의 다른 세션과 겹칠 위험). | 사용자 '서비스 컬러 팔렛트 이렇게 사용하도록 해줘. 확정안이야'(이미지). 데이터: 흰 바탕 · 카드 위 대비와 색 간 CIEDE2000을 계산했다. |
| 2026-11-05 | 서비스 팔레트 — 원본 화면 | 원본 (dash) 화면에도 같은 팔레트를 쓴다. `globals.css`의 토큰 값을 역할대로 바꿨다: brand → Point 1과 Chart - Own 단계, ink · bg → Text · Surface, 계열 1~12 → Chart - Other 네 계열의 기준색 → 둘째 → 셋째 단계, 당사 3사 → Chart - Own(현대 기준색 · 기아 가장 진한 단계 · 제네시스 옅은 단계), 감정 · 증감 → System(글자로 읽히는 positive · accent-gold는 진한 색). 화면에 박혀 있던 hex 목록(도넛 · KPI 추이 · 언급 추이)은 토큰 참조로 옮겼고, 출처 카테고리 13색은 알파 hex를 붙여 쓰므로 hex로 두고 팔레트 안에서 다시 골랐다(당사 공식 = 파랑, 경쟁사 공식 = 주황, 가장 가까운 쌍 CIEDE2000 15.0). HMG 로고는 SVG 자산이라 그대로다. 껍데기(머리 · 공지 띠 · 레일 · 메뉴)는 Global · Website · Project · Admin이 함께 쓰므로 Global 화면만이 아니라 원본 화면 전체가 바뀐다. 다른 안: Global 경로만 덮어쓰기(메뉴를 옮길 때마다 껍데기 색이 바뀜), 카테고리 색을 Chart - Other와 Point만으로 고르기(가장 가까운 쌍 10.1). 종전 카테고리 팔레트의 dataviz 검증기는 다시 돌리지 않았다. | 사용자 'global 화면에도 적용해줘'. 리뉴얼 Global 화면은 이미 적용돼 있었고, 첫 화면(`/dashboard`)이 원본 Global이다. |
| 2026-11-05 | 그라데이션 · 글래스 없음 | 면은 단색만 쓴다. 핵심 카드는 Chart - Own 2(#111f8a) 단색, 당사 행 칠은 `rn-navy-25`의 50%(hover · 선택 행의 칠과 겹치지 않게 선택 행에서는 빼고), 저장한 필터 영역은 `rn-navy-25`, 인용 매트릭스 범례는 5단계 칸, 원본 KPI 카드 스파크라인 아래는 8% 단색, 원본 로딩 블록은 shimmer 대신 pulse. 블러(`backdrop-blur`) 4곳은 불투명 단색으로 바꿨고, 계정 대기 막은 반투명(55%)만 남겼다(사용자가 정한 '백드랍으로 막기'라 샘플이 비쳐야 함). 쓰지 않던 `.gradient-brand` · `.gradient-sand`는 지웠다. 색 경계가 끊기는 CSS 그라데이션(데이터 없음 줄무늬, 형광펜 밑줄, 5단계 범례)은 보이기에 단색이라 남겼다. 다른 안: 계정 대기 막도 불투명(샘플이 안 보여 막의 뜻이 사라짐), 범례를 없애기(매트릭스 칸 색의 방향을 읽을 수 없음). | 사용자 'glass morphism과 그라데이션 모두 제거해줘'. |
| 2026-11-05 | Global Mention 브랜드 상세 먼저 | Global Mention의 보기 탭 줄은 브랜드 상세 → 구분선 → 네 KPI 탭 순서이고, 페이지는 브랜드 상세로 연다. `?view=kpi`나 지표를 지정한 링크(`?kpi=`, Overview KPI 카드)는 그 KPI 탭으로 열고, `?view=brands`도 그대로 쓴다. 브랜드 상세로 돌아가면 `?view` · `?kpi`를 지운다(남은 `?kpi=`가 다시 KPI 보기를 열지 않게). Project Mention(같은 본문)과 Website Mention은 KPI 보기가 먼저다. 다른 안: 탭 순서만 바꾸고 첫 화면은 노출률(맨 앞 탭과 첫 화면이 어긋남), 첫 화면만 바꾸고 탭은 끝(첫 화면이 줄 끝 탭이라 어디 있는지 안 읽힘), Project도 함께(사용자가 Global만 말함, Website 개편 때도 다른 화면은 그대로 둠). | 사용자 'global mention에서 브랜드 상세가 맨 처음에 나오도록하자'. |
| 2026-11-05 | 팔레트 빠진 곳 | 점검에서 찾은 다섯 곳을 팔레트에 맞췄다. ① 어두운 면(핵심 카드 · 잉크 말풍선 · 파랑 버튼 · 칠한 막대) 위 글자는 Text 5 `#f7f7f7`(리뉴얼 `rn-on-dark`, 원본 `ink-50` · `primary-foreground`). 보라 칠 위 라벨만 흰색이다(Text 5가 4.34:1, 흰색 4.65:1). ② 원본 화면의 Tailwind 기본 색 88곳을 역할대로 토큰으로 옮겼다: 성공 → 진한 초록 · System 초록 칠, 주의 → 새 `warn` · `warn-ink`, 실패 · 판매자 → System 빨강, 진행 · 정보 → 파랑 계열, 중립 → 회색, 의도 4분류는 같은 색상환(파랑 · 보라 · 초록 · 노랑의 진한 색). 켜지지 않은 `dark:` 기본 색은 지웠다. ③ BFF가 보내던 색: ACR 브랜드 색 → `own-*` · 계열 토큰, 감정 칠 → `bg-sentiment-*`. 화면 golden 84건은 색 값만 바뀌었음을 전수로 확인한 뒤 갱신했다(README 'Changes since recording'), 프런트의 같은 출력 고정본(`mention-screen.frozen.json`)도 맞췄다. ④ sonner 토스트의 성공 · 정보 · 주의 · 오류 색을 팔레트로(`lib/viz/toast-style.ts`). ⑤ ACR 상세 비당사 행 표시선 옛 `#f0a28f` → `#ffb49f`. 다른 안: 어두운 면 글자를 흰색으로 두기(Text 5가 쓰이지 않음), 원본 기본 색은 원본 화면이 대체될 때까지 두기(팔레트를 거치지 않는 색이 남음). | 사용자 '모두 수정'(점검 보고의 세 가지 제 안 + 토스트). |
| 2026-11-05 | Admin 목록 페이지 | 한 번에 다 읽는 Admin 목록(사용자 관리 · GA4 연동 · 고객 관심 키워드 · 소스 · 인용 출처 교정 · 시드 · 엔티티 역할)을 표 아래 페이저로 나눈다. 페이저는 Global prompts의 것(`RnListPager`)을 그대로 쓰고, 페이지당 25 · 50 · 100 중 50으로 연다(Global prompts · 엔티티 역할과 같음). 필터 · 검색 · 정렬이 바뀌면 1페이지로 돌아간다(엔티티 역할은 정렬 때 페이지를 그대로 두던 것을 맞췄다). 공용 훅 `admin/_components/admin-list-page.tsx`. 공식 소셜(9행) · 코드표(19행)는 나누지 않는다. 키워드 도구는 계정 대기 샘플이라 그대로다. 다른 안: 25로 열기(Admin의 기존 두 목록과 달라짐), 짧은 두 목록까지 나누기(한 페이지뿐인 페이저만 늘어남), 페이지를 넘길 때 표 맨 위로 스크롤(기존 페이저 어디에도 없음). | 사용자 'admin 하위 메뉴에서 리스트 테이블에 페이지네이션을 넣자. 스크롤이 너무 길어'. 데이터: 로컬 행 수 시드 795 · 소스 593 · 교정 501 · 키워드 84 · 엔티티 1,927 · 계정 5. |

## 진행 기록

- 2026-10-29 — 이 목록을 작성했다. 다음은 0단계다.
- 2026-10-29 — 0단계: 계정 관리 작업을 커밋·푸시했다(`768d7f6`). 커밋 전에 시험을 다시 돌려 모두 통과했다(BFF 30개 모듈, 관련 프런트 시험 12개 파일, typecheck, lint). 언급·인용 '순위 변화' 제목 변경과 `p4-acr-model-denominator.html` 19~23번 행은 다른 세션 작업이라 넣지 않았다. VM 반영은 사용자가 한다. 다음은 1단계 범위 확인이다.
- 2026-10-29 — 1단계: 범위를 확인하고 결정 B를 정했다. GA4 등록부(DB · BFF · 수집기 · 화면 · 문서)를 만들었다. BFF 시험 전체, 관련 프런트 시험, typecheck, lint, 저장소 `verify`, Playwright e2e 10단계를 통과했다. 커밋될 파일만 얹은 임시 작업 트리에서 다시 검증한 뒤 사용자 요청으로 커밋·푸시했다(`08b533c`). 다음은 2단계(⛔A 결정부터)다.
- 2026-10-30 — 2단계: 범위를 확인했다(결정 기록 '2 범위'). '기준값 편집 공통 구조' 절과 업스트림 합의 요청 초안을 썼다. 구현을 마쳤고 같은 날 사용자 요청으로 커밋·푸시했다(`e12eeb5`).
  - 저장소: `data-007.sql`(`catalog.source_override` · `source_override_event` · 발행 함수 · `hub_edit` 트리거), `hmg_source_override_editor`, `manage.py import-source-overrides`.
  - BFF와 화면: `hub_stores/source_overrides.py`, `/v1/hub/source-overrides*`, `/renewal/admin/standards/citation-sources`, `/api/hub/source-overrides`. 메뉴, 경로 정책, 아키텍처 문서와 ERD도 고쳤다.
  - Windows Docker 저장소: `init`과 `verify`를 통과했고, 처음 값 2건을 가져왔다.
  - 시험: BFF 464개 중 실패 0(`test_live_reads`는 이미지에 jsonschema가 없어 불러오기 오류). 새 시험 11개, 롤백 트랜잭션 실DB 쓰기 확인. 프런트 typecheck · lint 통과, 관련 시험 4개 파일 통과.
  - 기준 회차: 목록의 인용 수 회차(2026-10-05)가 리뉴얼 인용 화면 기본 회차(`citation/as-of`)와 같음을 Gold에서 확인했다.
  - 남은 것: API 재빌드 뒤 Playwright e2e(테스트 관리자 필요: `set-admin`은 비대화형 셸에서 비밀번호 입력이 멈춰 등록하지 못했다), Mac 저장소 적용, 사용자 확인, 커밋.
- 2026-10-30 — Mac 작업 트리를 `95964b7`로 받았다. 다른 세션이 만든 열람 전용 2단계(미커밋)와 원격 `e12eeb5`가 같은 화면을 반대 결정으로 만들어, 사용자가 HUB 정본을 확정했다('A 확정'). 열람 전용 작업은 `.local/backup/2026-10-30-step2-readonly/`와 `git stash`에 남겼다. 언급 · 인용 '순위 변화' 제목('최근 N회차/주')과 `p4-acr-model-denominator.html` 19~23번 행은 다시 얹었다(미커밋). 결정 '코드표'와 ⛔G를 더했다.
- 2026-10-30 — 2단계: Mac 저장소에 `007_source_overrides`를 적용했다(`init`, `import-source-overrides` 2건, `verify` 통과). API를 다시 띄우고 e2e(danawa.com 저장 → 원복 → 다시 저장, 이력 서랍)를 돌렸다. 끝 상태는 처음과 같고, 이력 3건과 업스트림 목록 v2~v4가 남았다. e2e 화면에서 필터 패널의 '전체'가 두 번 나오고 둘 다 선택되는 결함을 찾았다. `axisOptions`가 ALL을 넣고 `RnRadioAxis`도 '전체'를 그렸다. render 시험으로 재현한 뒤 고쳤다. 결정 G(시드 · 공식 소셜 = HUB 편집)를 기록했고, e2e는 새 화면의 핵심 흐름에만 돌리기로 완료 기준을 고쳤다.
- 2026-10-30 — 사용자 결정으로 Website 화면을 앞에 두었다('Website 우선'). Gold website 데이터를 확인했다: 발행 1,087건 2026-10-29 활성, ACR 셀은 website 0행(⛔H). 'Website 화면' 절(세션 W0~W5, 병렬 규칙)을 썼다. 같은 시각 다른 세션이 Admin 2단계 남은 일(`data-008.sql`, `source_lists.py`, 코드표 · 시드 · 소셜 화면)을 만들고 있어 그대로 두었다.
- 2026-10-30 — 2단계 남은 일: 범위를 확인했다(결정 기록 '2 남은 범위'). 시드 · 공식 소셜 · 코드표를 HUB 정본으로 만들었다(`data-008.sql`, `manage.py import-source-lists`, `hub_stores/source_lists.py`, `/v1/hub/source-seeds` · `source-socials` · `source-codes`, 화면 탭 3개, 아키텍처 문서 · ERD). Mac 적용 · `verify`, BFF · 프런트 시험, e2e 한 번을 마쳤다. e2e 실패 1건은 스크립트 타이밍 문제였고 같은 흐름을 따로 다시 돌려 정상임을 확인했다. 전용 DB 역할은 화면 묶음마다 하나로 정했다(공통 구조 '전용 DB 역할'). 사용자 요청으로 커밋 · 푸시했다(`a36b835`).
- 2026-10-30 — W5: 범위를 확인했다(추천안, 세션 메모 W5). `/renewal/website/ai-funnel/conversion`을 만들었다(page · page 시험, `RENEWAL_PAGES`, 사이드바 · 경로 시험 줄). 시험: 관련 5개 파일 285개 통과, typecheck · lint 통과. e2e 9단계 통과(상위 경로 → conversion, 사이드바 현재 항목, 기간 7일, 국가 US → '해당 데이터 없음', 초기화). 원본 `/ko/website/ai-funnel/conversion`과는 같은 필터에서 둘 다 'GA4 속성 없음'이다(GA4 인계 전이라 숫자 대조는 수집 뒤). ACR은 ⛔H까지 보류했다. 마지막 재실행에서 `rn-sidebar.render.test.tsx`의 'knows exactly the renewal pages' 1건이 실패했다. W1이 진행 중인 `renewal/website/page.tsx`의 `/website` 줄이 아직 `RENEWAL_PAGES`에 없어서이고, W5 파일 문제는 아니다.
- 2026-10-30 — W0: 저장된 필터 키 6개(`website-*`), website 필터 구성(`surface: "website"`, parity 시험 32개), BFF website 화면 19개 점검(모두 200, 결과는 '점검 결과')을 마쳤다. 시험: BFF 33개 모듈 490개, 프런트 필터 · 화면 시험 12개 파일 117개, typecheck, lint 통과. 미커밋. 사용자 지시로 W0 결정은 추천안으로 했다(결정 기록 'W0 추천안').
- 2026-10-30 — W1: 범위를 확인했다(추천안, 세션 메모 W1). `/renewal/website`를 만들었다(page, `_overview/website-overview-body.tsx`, render 시험 16개 · page 시험 5개, `RENEWAL_PAGES` · 사이드바 · 경로 시험 줄, 문구 `renewal.website.overview`). 필터는 W0의 `surface: "website"`, 저장 필터 키는 `website-overview`다. 시험: 자기 시험 21개, 사이드바 · 경로 · `[...slug]` · 리뉴얼 Overview 시험, typecheck · lint 통과. e2e 7단계 통과(열기, 브랜드 Kia 적용, 시장별 현황, 원본 `/ko/website?brand=Kia`와 카드 8개의 값 · Δ · 분자 · 분모 일치, 카드 → website Mention 새 탭, 우선 노출도 계열, 처음 상태). e2e에서 우선 노출도 눈금 중복('1.1' 두 번)을 찾아 고쳤다. `rn-sidebar.render.test.tsx`의 'knows exactly the renewal pages' 1건은 W2의 페이지 줄이 `RENEWAL_PAGES`에 들어오기 전이라 실패했고, 다른 W 세션이 각자 줄을 더한 뒤 다시 돌려 통과했다(관련 10개 파일 331개). 이어서 사용자 지시로 타겟 출처 인용률 불일치를 고쳤다(`gold_reader/metrics.py`, 세션 메모 W1). 수정 전 실패하는 시험 3개를 `test_gold_metrics`에 더했고, 수정 뒤 BFF 시험 전체 496개가 통과했다(5개 건너뜀). API를 다시 띄워 실제 Gold 값을 확인했고 e2e 7단계를 다시 통과했다(원본과 같음, Kia 63.2% · +2.2pp). 원본 `/ko/website`와 8개 조건(필터 없음, 브랜드 Kia · Hyundai, Hyundai + US, Genesis + en, 엔진 gemini, 기간 9/1~10/9, Kia + 기간)으로 대조했다. 카드 8개(값 · Δ · 엔진 일관성 · 분자 · 분모 · 경쟁사 SOV · 출처 문구), 출처 구성비, 시장별 권역 · 국가 점유율이 모두 같다. 대조 중 시장별 현황의 시작 지표를 원본과 같은 점유율로 바꿨다. 이어서 BI 개편(세션 메모 W1): BFF `website/brands` · `website/engines`와 시험 5개(배지 = 일관성 행 확인 포함), 화면 파일 6개(`website-kpis` · `-breakdowns` · `-trend` · `-sources` · `-markets` · `-findings`)와 시험 36개. BFF 시험 전체 523개, typecheck · lint 통과. e2e 7단계(구역 전부, 일관성 행 = 카드 배지, 브랜드 행 → brand, 시장 열 → 지도 · 순서, 국가 행 → geography, 엔진 행 → engine, 카드 → 새 탭) 통과. 레거시 대조 8개 조건 모두 같고, 브랜드 표 3행은 레거시에서 그 브랜드를 고른 카드 8개와 같다. 미커밋.
- 2026-10-30 — W2: 범위를 확인했다(추천안, 세션 메모 W2). `/renewal/website/answer-analysis/mention`을 만들었다(page · page 시험 3개, 서랍 요청 시험 3개, `RENEWAL_PAGES` · 사이드바 · 경로 시험 줄). BFF 두 곳(`mention_renewal.py`의 `_begin`, `mention_data.py`의 KPI 브랜드 추이)은 재현 시험 2개가 수정 전에 실패하는 것을 확인한 뒤 고쳤다. 시험: BFF 33개 모듈 503개, 프런트 Mention 관련 7개 파일 37개, 사이드바 · 경로 270개 통과. typecheck · lint에서 W2 파일은 깨끗하다. 남은 오류는 진행 중인 W4 `website-prompts-read.ts`와 W3 `citation-body.tsx`에 있다. API를 다시 띄웠다. e2e 8단계 통과: 기본 KPI 4개, 국가 미국 적용 뒤 값 변경, 원본 `/ko/website/answer-analysis/mention?geography=US`와 브랜드 행(점유율 · 언급률 · 평균 위치) 일치, 브랜드 서랍(프롬프트 · 답변 원문 · 인용 출처)과 감정 서랍이 모두 surface=website로 200. 기간(2026-09 · 미국)도 원본과 같다. e2e에서 브랜드 서랍 목록 결함(기존, 세션 메모 W2)을 찾았다. 미커밋.
- 2026-10-30 — W3: 범위를 확인했다(추천안, 세션 메모 W3). `/renewal/website/answer-analysis/citation`과 하위 화면 `prompts` · `tone-urls`를 만들었다. 표준 인용 `_components`에 website 타일(공식(당사), 자사 · 타겟 URL 인용률)을 더했고 표준 화면은 그대로다(render 시험). BFF `citation.py`: `citation/website`의 renewal 변형, 하위 화면 website 분기, 공식(당사) Δ · 추이(`load_own_share_line`). 시험: BFF 33개 모듈 전체 통과(새 시험 5개, citation golden 그대로), 프런트 인용 · 사이드바 · 경로 시험 303개, typecheck · lint 통과. API를 다시 띄웠다. e2e 14항목 통과: 첫 화면 값, 국가 미국 적용 뒤 값(공식(당사) 18.9 · HMG 53.1 · URL 83.8/63.4 · 프롬프트 260/92), 출처 행 토글(URL 인용률 '산출하지 않음'), 도메인 서랍, 하위 화면 개수, 원본 `/ko/website/answer-analysis/citation?geography=US`와 숫자 일치. 미커밋.
- 2026-10-30 — W4: 범위를 확인했다(추천안, 세션 메모 W4). `/renewal/website/prompts`를 만들었다(page · loading, 목록 · 상세 render 시험 7개, GET 프록시와 시험 6개, `RENEWAL_PAGES` · 사이드바 · 경로 시험 줄, 문구 `renewal.website.prompts`). BFF는 리더 website 분기를 고치고(재현 시험 5개가 수정 전 실패, 수정 후 통과) 화면 2개를 더했다. 시험: BFF 33개 모듈 492개 통과(건너뜀 5), 프런트 관련 시험 · typecheck · lint 통과. e2e 한 번(열기 → 국가 독일 288개 → 검색 ev6 5개 → 측정 횟수 정렬 → 다음 쪽 → 상세 → 엔진 렌즈(행 288개 그대로) → 엑셀). 원본 `/ko/website/prompts`도 같은 조건에서 288개다. 미커밋, 사용자 확인 대기.
- 2026-10-30 — W2: 사용자 지시(기존 KPI는 없애지 않는다)로 원본 website 요약 카드 6개를 '언급 현황' 카드로 되살렸다(BFF `mention/view-cards`, 카드 · render 시험 3개, BFF 시험 2개는 수정 전 실패 확인). 실제 화면에서 필터 없음 · 미국 · 미국+2026-09의 카드 값과 Δ가 원본과 같고, Global Mention에는 카드가 없다. 시험: BFF 33개 모듈 509개, W2 · 표준 Mention 시험 28개 통과, typecheck · lint 통과. API를 다시 띄웠다. 미커밋.
- 2026-10-30 — W2: 사용자 지시(정보를 잃지 않는 BI 개편, 없는 정보 증강 금지)로 화면을 다시 짰다(세션 메모 W2): KPI 세부 지표(KPI별 묶음, 탭 이동), 미언급 프롬프트 목록(Gold 리더 · BFF · 프록시 새로 추가, 다른 브랜드 언급 / 없음으로 나눔, 답변 원문), 주별 브랜드 언급 수(선 · 표 · CSV). 시험: BFF 534개(새 시험 7개, 수정 전 실패 확인), 프런트 W2 · 표준 Mention 33개 통과, W2 파일 typecheck · lint 통과(남은 tsc 오류는 W1 · W4 · W5 진행 중 파일). API를 다시 띄웠다. 실제 화면 e2e 통과: 묶음 → 탭 이동, 미언급 836 → 세그먼트 63 / 773 → 답변 원문(surface=website 200), 주별 11행 · 표로 보기. 미커밋.
- 2026-10-30 — W3 BI 개편: 사용자 요청('정보 유실 없이 인사이트, 없는 정보 증강 금지'). website 화면만 다시 배치했다(세션 메모 W3). 새 카드 2개(`citation-website.tsx`: 도달 · 프롬프트)와 BFF `load_url_reach`. 표준 화면은 그대로다(render 시험). 시험: BFF 33개 모듈 전체 통과(`test_screens_citation` 31개 중 도달 시험 3개 추가, golden 그대로), 프런트 인용 · 사이드바 · 경로 305개, 제 파일 typecheck · lint 통과. e2e 16항목 통과(도달 깔때기 · 엔진 표, 미국 필터, 출처 행 → 도달 '계산하지 않음', 서랍, 하위 화면, 원본 대조). legacy 대조 8개 조건 × 9개 값 + 도메인 상위 10행이 모두 같다(출처 필터로 공식(HMG)이 빠질 때만 '0.0%' 대신 '—'). 미커밋.
- 2026-10-30 — W4 BI 개편: 목록 인사이트(KPI 5개 · 카드 6개)와 차트 → 목록 좁히기 · 패널 필터, 행 회차 띠 · 엔진별 측정 막대, 상세 · 엑셀 추가 열을 만들었다(세션 메모 W4 'BI 개편'). 시험: BFF 33개 모듈 523개 통과(건너뜀 5), W4 render 14개 · 라우트 7개, typecheck · lint 통과(conversion 3건 · `preview-w5` 사이드바 시험 실패는 W5 작업 중 파일). e2e(회차 막대 → 마지막 측정 겹쳐 좁히기 2,290개 → 모두 해제 12,729개 → 엔진 조합 188개 → 시장 독일 패널 필터 288개 → 사이트 검색 107개 → 엑셀 13열 → 상세) 통과. 해제 뒤 목록이 갱신되지 않던 결함을 e2e에서 찾아 고쳤다. 미커밋, 사용자 확인 대기.
- 2026-10-30 — W5 BI 개편: 레거시 정보(페이지 조회 수 합계, 기간 사용자 원자료, 일별 표)를 되살리고, 수집기가 이미 쌓은 값으로 인사이트를 더했다. 채널 비교(AI Assistant vs 다른 채널, GA4 주요 이벤트), 전환 변화 분해(유입 규모 + 세션당 전환, 산술 항등식), 기기 · 신규/재방문 구성, 같은 입구 페이지의 일반 유입, 시장별 AI · 일반 전환율, 이벤트 AI · 일반 분할이다. 추정 · 채움 · 유의성 판정은 없다. 시험: BFF 33개 모듈 523개 통과(새 단언 6개, fixture 재생성), 프런트 render 10개 · 관련 4개 파일 282개, typecheck · lint 통과. fixture 미리보기 화면 캡처로 1920×915 배치를 확인했고(임시 경로는 지웠다), 새 리더 SQL은 로컬 저장소에서 읽기 역할로 EXPLAIN 했다. API를 다시 띄운 뒤 e2e 9단계를 통과했다.
- 2026-10-30 — W0: Website 화면 BI · 데이터 출처 점검(병렬 감사 4건, 결과는 대화로 보고)과 레거시 필터 대조 뒤, 사용자 지시로 필터 차이 세 가지를 맞췄다(세션 메모 W0). 재현 시험은 수정 전 실패를 확인했다(리더 `pin_top_rival` 1, Mention 평균 · 요청 2, Conversion 화면 · 리더 2, 빈 국가 축 render 1). 시험: BFF 33개 모듈 540개(golden 포함), 리뉴얼 프런트 39개 파일 303개, typecheck · lint 통과. API를 다시 띄워 실제 화면으로 확인했다(website Mention 'Tata · 자동', Conversion 국가 축 없음, 하위 화면 칩 × → 260 → 8,736개 · 2,060 → 134,811개). 아키텍처 문서의 HUB 읽기 경로 줄을 고쳤다. 미커밋.
- 2026-10-30 — W6: 사용자 요청으로 Website 하위 화면 디자인 지적 10개를 고쳤다(세션 메모 W6). 1920×915 화면 캡처로 전후를 대조했다(Overview KPI 카드 532 → 474px, Mention KPI 세부 지표 구역 232 → 163px). 시험: website · 표준 인용 · 표준 언급 · 셸 · 경로 정책 20개 파일 395개, typecheck, lint(오류 0) 통과. 고친 시험은 W1 KPI · 브랜드 표 · 추이, W2 KPI 세부 지표다(새 표시 규칙에 맞춤). 표시만 바꿔 e2e는 돌리지 않았다(완료 기준). 미커밋.
- 2026-10-30 — W6: 사용자 요청으로 Overview 핵심 요약을 리스트 카드로 바꿨다(세션 메모 W6). 시험: W1 5개 파일 41개(리스트 render 3개, 순위 화살표 1개 추가), typecheck, lint 오류 0. 화면 캡처로 전체 · Kia 조건을 확인했다. 미커밋.
- 2026-10-30 — W6: 사용자 요청으로 KPI 추이의 회차별 답변 수를 막대 + 숫자로 바꿨다. 시험: W1 37개(막대 높이 시험 1개 추가), typecheck, lint 오류 0. 화면 캡처로 확인했다. 미커밋.
- 2026-10-30 — W6: 사용자와 검토한 뒤 Prompts '마지막 측정 회차' 카드를 뺐다(세션 메모 W6, 업스트림 질문 후보 포함). 시험: Prompts 14개, typecheck, lint 오류 0. 화면 캡처로 확인했다. 미커밋.
- 2026-10-30 — W6: 사용자 요청으로 Website 화면 품질을 검수했다(보이는 것 · 인사이트 · 데이터 출처). 화면 캡처를 직접 검토했고, 출처 감사 4건(Overview · Mention · Citation · Prompts+AI Conversion, 읽기 전용, Gold SQL 확인 포함)을 돌렸다. 결과는 대화로 보고했다. 가장 큰 결함은 넷이다. Mention 주별 언급 수가 측정 없는 주를 0으로 그린다(미국 7/20 · 8/3 · 8/10). Citation 공식(당사)가 Gold 정의(website = loc_owned ∨ tgt_hit, `citation_cell` 설명)보다 좁다. Citation 미인용에 인용 0건 프롬프트가 들어간다. Overview 기간 모드에서 타겟 출처 Δ가 회차 Δ로 나온다. 요약 발견의 HUB 기준값(Mention · Citation · Conversion, Global 표준에서 옴)은 사용자 결정이 필요하다. 아무것도 고치지 않았다.
- 2026-10-30 — W6: 품질 검수 결과를 1~3단계로 고쳤다(세션 메모 W6 '품질 검수 뒤 수정'). 고친 범위는 BFF(리더 3 · 화면 4 · HUB 리더 1), front(W1~W4 · 표준 언급 · 인용 · 전환 `_components`), 문구다. 시험: BFF 34개 모듈 550개(새 시험: `test_gold_citations`, 주별 공백, 대상 도메인, 미언급 구분 수, 전환 기준값 · 부분합 · 채널 · 대체 계산, golden 25건 재작성), front renewal 43개 파일 589개, typecheck · lint 오류 0. API를 다시 띄워 실제 화면을 확인했다: 기간 모드 · Kia 시장 표 · Mention 요약 순서 · 미국 주별 공백 · Citation 미국 19.9% · 1,131 · 당사 태그 · Prompts 64. 미커밋.
- 2026-10-31 — W6: 사용자 결정으로 KPI 추이 답변 수 막대를 중립 회색으로 바꾸고 직전 회차 대비 증감 툴팁을 붙였다(세션 메모 W6). 언급 공백 회차의 '0'을 '—'로 고쳤다. 재현 시험 3개(회색 막대, 툴팁, 공백 '—')는 고치기 전에 실패했다. 시험: 리뉴얼 39개 파일 316개 · renewal-ui · dash 475개, typecheck 오류 0, lint 오류 0. 실제 화면에서 14회차 툴팁 값을 확인했다. 커밋 전 점검: BFF 시험 전체 550개 통과. front 시험 전체에서 작업 트리만 실패하던 `test/bff-boundary.test.ts`(Website Overview `page.tsx`가 옛 `lib/scope/engines`를 읽음)를 같은 폴더 `engineLabel`로 고쳤다. 남은 실패 23개 파일 · 121개는 HEAD에서도 똑같이 실패한다(옛 `lib/scope` · `lib/db` 시험). 미커밋.
- 2026-10-31 — W0~W6 커밋 · 푸시: 사용자 승인으로 Website 작업 전체를 한 커밋으로 올렸다(`f28395f`). 화면 폴더 · W0 필터 · 같이 쓰는 BFF 리더 · golden 압축 파일이 얽혀 W 번호별로 나눌 수 없었다. 그 앞에 다른 작업의 '순위 변화' 제목 짝(문구 4줄 · 본문 2줄, BFF는 이미 HEAD)을 따로 올렸다(`911a7d3`). `p4-acr-model-denominator.html` 19~23번 행(다른 세션의 언급 BI 검토 메모)은 넣지 않았다. 시험: BFF 550개, front Website · 경계 시험 84개, typecheck · lint 통과. front 전체 실패 23개 파일은 부모 커밋에서도 같다.
- 2026-10-31 — 원칙 정리: 사용자 결정으로 규칙 2(원칙을 따르면 자동 진행) · 4 · 6(자동 커밋 · 푸시) · 7(화면 원칙 새로 둠), 공통 완료 기준, CLAUDE.md 작업 규칙을 고쳤다(결정 기록 '결정 · 커밋').
- 2026-10-31 — 중간점검: Global · Website 전 화면을 원본과 대조하고 규칙 5 · 7을 점검했다(코드 읽기 다섯 갈래, 큰 지적은 코드로 다시 확인). 메뉴에 보이는 페이지는 모두 있다. 원본 정보가 빠진 곳(언급 5 · 인용 2 · Overview 1)과 원칙 위반 후보가 나왔고, 가장 큰 결함은 범위 계정의 Website 403이다. 사용자 결정으로 고칠 일을 한 세션 순차 계획 `renewal-audit.md`(16단계)로 만들고 ⛔J · K · L을 더했다. 코드는 고치지 않았다.
- 2026-10-31 — 사용자 지시로 규칙 2를 넓혔다(원칙으로 정할 수 없으면 사용자 결정 추이를 따른다, 결정 기록 '선택 추이'). 그 기준으로 ⛔J · K · L을 추천안으로 정했다. 점검 후속 2 · 14 · 15단계는 건너뛰지 않는다.
- 2026-10-31 — 리뉴얼 점검 후속 16단계(마무리): 리뉴얼 · 원본을 같은 조건(필터 없음 · 미국)으로 Global 5화면 · Website 4화면씩 대조했다(값 모두 같음, 다른 것은 단계 메모의 의도한 변경뿐). 범위 계정 Website Overview도 원본과 같다. BFF 34개 모듈 643개, 프런트 관련 121개 파일 1,542개 · typecheck · lint 통과. 아키텍처 문서 '마지막 갱신'을 고쳤고, 업스트림 D1 · D3 · D7을 2~15단계 결과와 맞췄다. 보류 · 다음 일은 '점검 후속 뒤 남은 일' 절에 모았다. '지금 할 일'을 Admin 3단계 범위 확인으로 바꿨다. 점검 후속 1~16단계 끝, 사용자 확인 대기.
- 2026-10-31 — 사용자 요청으로 리뉴얼 화면 지표마다 Gold · HUB 데이터 출처를 정리했다(`docs/handoff/kpi-data-lineage.html`). 화면 20개 · 지표 424행이고, 화면 묶음 다섯 갈래를 하위 에이전트가 조사했다. 진행 세션이 코드 인용 1,210개와 대표 숫자를 Gold에서 다시 세어 확인했다. 기본 조건 대조 275건은 모두 일치했다. 필터 조건에서 Global Citation 자사 판정이 Gold 정의와 갈리는 결함 하나와, 정할 일 셋을 '점검 후속 뒤 남은 일'에 더했다. 코드는 고치지 않았다.
- 2026-10-31 — 사용자 요청으로 Global Citation 자사 판정 결함을 고쳤다(`9dbd27d`, '점검 후속 뒤 남은 일'). 재현 시험 6건(`test_gold_citations`)은 고치기 전에 실패했다. 고친 뒤에는 BFF 34개 모듈 648건과 실제 API 시험 8건이 통과했다. 고치기 전후를 국가 · 언어 조건 일곱 개로 대조했다. 필터 없음은 그대로이고, 미국은 공식(당사) 9.5% → 6.4%, 인용 · 미인용 프롬프트 349 · 446 → 238 · 557, 'HMG' 태그 도메인 8 → 3이다. 값은 모두 Gold `kpi_cell.cit_owned_c` · `citation_cell` 합과 같다. `kpi-data-lineage.html`의 해당 5행에서 '원칙 확인'을 풀었다(27행 남음).
- 2026-11-02 — 3단계(`53126de`): 사용자 지시('다음 단계 시작')로 시작했다(2단계 · 점검 후속 · Website 사용자 확인은 그대로 대기). 범위와 ⛔E를 규칙 2로 정했다(결정 기록 'E' · '3 범위'). 만든 것: `data-009.sql`(`catalog.interest_keyword` · `interest_source` · 이력 · 발행 함수 · `interest_term_norm`), `hmg_interest_editor`, `manage.py import-interest-keywords`(84개), `hub_stores/interest.py`, `/v1/hub/interest-keywords` · `-sources`, `/renewal/admin/standards/customer-interest`(탭 2개), `/api/hub/interest-*`, 메뉴 · 경로 정책, 아키텍처 문서 · ERD, README, 업스트림 C2. 만들며 찾은 결함: 저장소가 C 로케일이라 `lower('ÜBER')`가 `Über`였다. 키가 Gold `term_norm`과 달라지므로 ICU로 고치고 `verify`에 검사를 더했다. 시험: BFF 35개 모듈 전체 통과(새 `test_hub_interest` 11건, 실 DB 롤백 포함), 프런트 관련 18개 파일 388건, typecheck · lint 오류 0, `verify` 통과. e2e 두 번 통과: 키워드 추가(입력 오류 포함) · 수정 · 중지 · 재개 · 이력 · 필터 · 검색, 소스 Gold host 추가 · URL 정규화 · 중복 거부 · 수정 · 중지 · 재개 · 이력 · 필터 · 새로고침 복원, 외부 목록 정의. 끝 상태는 처음과 같다(시험 행은 지웠다).
- 2026-11-02 — 4단계(`bb34ac4`): 사용자 지시('다음')로 시작했다(3단계 사용자 확인은 그대로 대기). 범위와 ⛔F, 외부 API로 낼 값을 규칙 2 · 5로 정했다(결정 기록 'F' · '4 범위'). 만든 것: `data-010.sql`(`catalog.entity_role` · 이력 · 발행 함수), `hmg_entity_role_editor`, `manage.py import-entity-roles`(19건), `hub_stores/entity_roles.py`, `/v1/hub/entity-roles`, `/renewal/admin/standards/entities`, `/api/hub/entity-roles`, 메뉴 · 경로 정책, 아키텍처 문서 · ERD, README, 업스트림 C3. Mac 저장소의 `009` 체크섬이 3단계 ICU 수정 전 값으로 남아 `init`이 멈췄다. 푸시한 파일이 수정본이고 Mac만 옛 값이라 Mac 기록을 맞췄다(다른 저장소에는 적용된 적 없음). 시험: BFF 36개 모듈 전체 통과(새 `test_hub_entity_roles` 9건, 실 DB 롤백 포함), 프런트 관련 파일, typecheck · lint 오류 0, `verify` 통과. e2e 통과: 목록 1,927 · 자사 5 · 제외 14(Gold와 같음), 필터 · 검색 · 쪽, 표본 · 관측 표면, 제외 저장, 자사(브랜드 · 확인 필수) 저장, 경쟁사로 해제, 이력, 전체 최근 변경, 새로고침. 끝 상태는 처음과 같다(시험 행은 지웠다).
- 2026-11-02 — 사용자 요청으로 Global · Website를 대전제(규칙 5 · 7)에 대조했다. 코드는 고치지 않았다. 실화면 15개(1920×915) 모두 200 · 가로 넘침 0 · 깨진 값 0, BFF 시험 648건 + 실제 API 시험 8건, 프런트 35개 파일 317건 · typecheck 통과. 필터 조건 숫자 980건은 표시값 불일치 0(원자료 수만 다른 4건은 population 4 모수). Gold 역할은 쓰기 권한 0, 외부 API는 입력만이다. 큰 결함 하나: Website Overview가 Gold의 보고 유닛 모수와 ⑥ 정의를 따르지 않는다. 결과는 '점검 후속 뒤 남은 일'의 '2026-11-02 대전제 검수에서 나온 일'.
- 2026-11-02 — ⛔D 사용자 답을 적었다(결정 기록 'D'). 키 · 계정은 추후 받고, 호출 범위 · 비용 상한은 그 계정을 따른다. 5단계는 계정 인계까지, 6단계는 ⛔C 명세까지 기다린다. 코드는 고치지 않았다.
- 2026-11-02 — 사용자 요청으로 Admin 화면 10개를 1920×915에서 점검하고 고쳤다(`f41a002`). 수집 소스: 코퍼스 행의 채널이 모두 '—'이고 채널 필터가 0건이던 것을 Gold 출처 분류 열과 제안 채널로 고쳤다(결정 기록 '수집 소스 채널', 필터 뉴스 98건, 추가 폼 기본값). 채널 없는 행이 오름차순에서 앞에 오던 정렬도 고쳤다. 시드 추가 폼이 세 줄로 꺾이던 것(입력의 `w-full`이 폭 지정을 이김)을 한 줄로 고쳤다(카드 123 → 58px). 글로벌 프롬프트 개수에 천 단위 쉼표를 넣었다. 낡은 문구 둘을 고쳤다(교정 탭 '시드 · 소셜 목록은 Gold 값', 계정 범위 'Global 화면만'). 시험: 재현 시험은 고치기 전에 실패했다. BFF 35개 모듈 608건(건너뜀 4), 프런트 Admin · 사이드바 · 경로 27개 파일 549건, typecheck · lint 통과. `test_screens_mention_renewal`은 다른 세션이 트리맵을 고치는 중이라 돌리지 않았다. 실제 화면에서 네 항목을 확인했다. 계정 문구는 파일과 render 시험에는 있지만 떠 있는 로컬 front가 옛 값을 보였다(재시작하지 않았다). 남은 일은 '2026-11-02 Admin 화면 점검에서 나온 일'.
- 2026-11-02 — 사용자 결정으로 마스터 룰을 `CLAUDE.md`에 적용했다(결정 기록 '마스터 룰'). `CLAUDE.md`의 ACR 후속 · GA4 수집 시작 줄은 '점검 후속 뒤 남은 일'로 옮겼다. 문서만 바꿨다.
- 2026-11-02 — 사용자 요청으로 Global 화면 데이터 205행(AI 가시성 제외)에 점수를 매겼다(`docs/handoff/global-data-score.html`). 화면마다 하위 에이전트가 실제 값을 재고 Gold와 다시 대조했고, 진행 세션이 큰 주장을 실제 응답과 코드로 재확인했다. Gold 기반 174행 중 172행 일치, 불일치 2건(트리맵 묶음 Δ, ACR '가장 낮은' 발견). 나머지 31행은 HUB 또는 GA4 값이다. 평균은 유의미 4.4/5, 인사이트 2.6/5(AI Conversion 제외), 가장 낮은 기준은 행동 22%다. 코드는 고치지 않았다.
- 2026-11-02 — 사용자 요청으로 점수표 결함 15건을 고쳤다(`97da2a0` Overview 3건 · `38234bf` Mention 2건 · `b805c7b` Citation 3건 · `7a3875a` ACR 2건 · `1d0a041` Prompts 2건 · Conversion 1건 · Admin 1건, 결정 기록 '점수표 결함'). 결함은 모두 재현 시험이 고치기 전에 실패했다. 시험: BFF 36개 모듈 696건(실 DB 포함) 통과, 프런트 리뉴얼 45개 파일 423건 · typecheck · lint 통과, 골든 42건을 README에 적고 갱신했다. 전체 프런트 시험은 돌리지 않았고, `lib/scope` 실패는 기존과 같다. 실제 응답으로 확인했다: 시장 경쟁사 인용 58/58행, 학술 124개, 긍정 URL 130,284개, ACR 국가 51 · 회차 13 · 카탈로그 41, 경쟁 구도 '추이 미산출' 0행, 변경 이력 500건 묶음. VM에는 반영하지 않았다.
- 2026-11-02 — 사용자 요청으로 Overview 개선안을 적대적 검증했다(하위 에이전트 3갈래: 데이터 정의 · 시장 통계 · 규칙과 화면 비용, 주요 수치는 진행 세션이 재측정). 첫 안의 셋 모두 하지 않기로 보고했다. 결과는 '2026-11-02 Overview 개선안 적대적 검증'. 코드는 고치지 않았다.
- 2026-11-02 — 사용자 요청으로 두 번째 Overview 안(범위 칩 · 리스트 유형 카드)을 적대적 검증했다(3갈래: 지연 수정 실현성 · 칩과 카드의 의미 · 규칙과 화면, 순위 기준과 Strategic Model 구성은 진행 세션이 재측정). 칩과 카드는 하지 않고, 카탈로그 지연은 리더만으로 고칠 수 있음을 확인했다. 코드는 고치지 않았다.
- 2026-11-02 — 대전제 검수 후속(사용자 답 1~6). 3번 트리맵 부분합을 고치고 6번 레거시 표시 4개를 되살렸다(`b013b8b`). 재현 시험은 고치기 전 실패를 확인했다. BFF 671건 통과(건너뜀 8), 리뉴얼 프런트 35개 파일 319건 · typecheck · eslint 통과, 실제 화면 1920×915 Global · Website Mention 4개 보기에서 가로 넘침 0을 확인했다. 작은 표시 변경이라 e2e는 돌리지 않았다. 4번은 Prompts가 다른 화면에 맞춰야 한다고 결론 냈고(코드 그대로), 1 · 2번 운영 웹 대조는 로그인 계정이 없어 멈췄다. 5번은 고칠 방법을 답변으로 제안했고 사용자 결정을 기다린다.
- 2026-11-02 — 대전제 검수 후속 2(사용자 '수정 시작'). 4번 Website Prompts 국가와 5번 HUB 좋음 · 나쁨 표시를 고쳤다(`0e69ace`). 재현 시험 7건은 고치기 전 실패를 확인했다. 색 점검에서 Mention 순위표도 경쟁사 색이 남아 있는 것을 찾아 함께 고쳤다. BFF 673건 통과(건너뜀 8), 리뉴얼 프런트 35개 파일 324건 · typecheck · eslint 통과. 실제 API · 화면에서 사우디 세 도시 69 · 93 · 84개(리뉴얼 · 원본), Overview 경쟁사 Δ 중립, 1920×915 가로 넘침 0을 확인했다. 필터 · 표시 변경이라 e2e는 돌리지 않았다. 남은 첫 두 항목(Website Overview 모수 · ⑥ 정의)은 운영 웹 대조를 기다린다.
- 2026-11-02 — Website Prompts 정리(`86884ed`, 사용자 '권고대로 정리해'). 차트 13개를 실제 값으로 평가해(대화) 회차 막대 · 최근 회차 KPI · 시장 표 · 엔진 조합만 남겼고, 최근 회차 미측정 KPI(2,708개, `miss` 좁히기), 회차 없는 주 빈 칸(07-31), 시장 표 빈칸 순 정렬, Hyundai N 이름, 상세의 회차 띠, 행의 엔진 점을 만들었다. 재현 시험은 고치기 전 실패를 확인했다. BFF 677건 통과(건너뜀 8), 프런트 website · 공용 21개 파일 179건 · typecheck · eslint 통과. 프런트 전체 시험은 돌리지 않았다. Playwright로 실제 화면 흐름을 확인했다(미측정 2,708개 좁히기 · 해제, 엔진 조합 188개, 시장 정렬 전환, 국가 독일 288개, 상세 회차 띠, 가로 넘침 0, 콘솔 오류 0). 마지막 막대가 목록 수와 같을 때 '목록 N' 글자와 값이 겹치던 것도 고쳤다. `kpi-data-lineage.html`의 Website › Prompts 표를 고쳤다(21 → 16행, 합계 419행). `design-rules.html`과 대조해 어긋나는 곳이 없음을 확인했다.
- 2026-11-02 — Website Mention 개편(`3127b6b`, 사용자 '1. 제안대로 2. 제안대로'). 업스트림 D8과 개편 계획은 먼저 올렸다(`5478eee`). BFF 화면 `mention/rn-markets` · 리더 `mentions/market-gaps` · 미언급 목록 `?partial` · 타겟 URL, Website 전용 본문(요약 · KPI 칸 · 시장 표 · 엔진 표 · 당사 대 비교 · 주별 표)을 만들었다. 시험: BFF 전체 713건 통과(건너뜀 6), 실제 API 시험 8건, 리뉴얼 프런트 47개 파일 441건 · typecheck · eslint 통과, 커밋할 파일만 얹은 임시 작업 트리에서도 같다. 프런트 전체 시험은 돌리지 않았다. Gold 대조: 시장 표 59행(답변 · 언급 답변 · 증감 · 미언급 · 다른 브랜드 언급 · 브랜드 언급 없는 답변)이 사실 표 재집계와 모두 같고, 일부 엔진만 빠짐 612(싱가포르 22)는 `kpi_cell` 재집계와 같다. Playwright(1920×915, 임시 복사본 3344): KPI 전환 4개 · 정렬 4종 · 시장 미언급 서랍 · 일부 엔진만 빠짐 · 국가 필터 · 브랜드 상세 · 비교 브랜드 바꾸기 · `?kpi=` 링크 · 브랜드 Kia(열 숨김) · Global Mention 그대로, 가로 넘침 0, 콘솔 오류 0. `kpi-data-lineage.html` Website Mention 표를 고쳤다(43 → 49행, 원칙 확인 3 → 1, 합계 425행).
- 2026-11-02 — 계정 대기 화면(`3043512`, 사용자 요청). 메뉴 열쇠 표시(`ACCOUNT_PAGES`), 공용 막 `account-gate.tsx`, AI Conversion 샘플(`conv-sample.tsx`), 리뉴얼 키워드 도구 샘플 화면, BFF `_state` 수정(재현 시험은 고치기 전 실패 확인). 시험: BFF `test_screens_conversion` 30건 통과(전체 BFF는 돌리지 않음, ruff 2건은 기존 시험 코드), 프런트 관련 7개 파일 306건 · typecheck · eslint 통과. e2e 14단계 통과(1920×915: 열쇠 3 · 공사 4, inert · 초점 없음, 스크롤해도 안내 제자리, `?geography=US`도 막, 사이드바로 Website 전환 · 키워드 도구). 공유 개발 서버 3333은 Overview · GA4 연동을 바뀌기 전 사이드바로 SSR해 하이드레이션 오류가 나서, 작업 트리 사본을 새로 띄운 3334에서 다시 확인했다(오류 없음, 남은 속성 불일치 경고는 첫 방문 안내 모달의 aria-hidden). 뒤에 사용자 지시로 3333을 다시 띄우고 같은 확인을 3333에서 했다.
- 2026-11-02 — Overview 0번(`77f0ec6`, 사용자 '시작'). 카탈로그 축 지연과 시장 구역 빈 화면을 고쳤다. 리더 `Context.create`가 모든 카탈로그 선택에 맞는 프롬프트를 한 번 읽고, 술어는 `prompt_key=ANY`로 묶는다. `create` 없이 만든 Context는 선택을 버리지 않고 오류를 낸다. 재현 시험(단위 2건 · `overview/geo` 화면 1건 · 실제 API 2건)은 고치기 전 실패를 확인했다. 리더 19개 조건 전후: 12.6 → 1.6초, 13.4 → 1.5초, geo 24.4 → 1.0초, website branded 10.5 → 3.3초이고, 503이던 2개(미포함 + 리스트 유형, branded + 퍼널)는 약 1초다. 값은 19개 모두 같다(503 2개는 옛 코드를 제한 없이 돌려 48 · 79초에 같은 답). 화면 `overview/cards` · `geo`: 독일 + 미포함 0.58 · 1.13초. golden `overview/fix-g-geo-11`을 다시 고정했다(README). BFF 727건 통과(건너뜀 2, 실제 API 시험 9건 포함), 바뀐 파일에 새 ruff 지적 없음. 화면 코드는 바꾸지 않아 e2e는 돌리지 않았다.
- 2026-11-02 — 인사이트 · 정확도 마지막 검수(사용자 요청). 하위 에이전트 넷이 Website Overview(45항목) · Citation(50) · Mention(61) · Prompts(21)를 점수표 기준으로 매기고 Gold에서 따로 다시 셌다. Global은 점수표의 낮은 행 47개와 고친 구역(약 5,000칸)을 다시 봤다. 진행 세션이 Gold 설명(`url_prompt_cell` · `report_value` · `web_report_prompt` · `citation_fact`)을 직접 읽었고, 큰 주장 셋(Prompts 상세 이력 키 · 이력 500건 자르기 · Website Mention 엔진 표 머리)을 코드로 확인했다. 값 불일치는 이미 알려진 ⑥ 2건과 Mention 2건뿐이다. 정의 2건과 라벨 · 키 · 정렬 18건, 인사이트 낮음 52항목과 Global 47행이 나왔다('점검 후속 뒤 남은 일'). 코드는 고치지 않았다. 브라우저 화면과 범위 계정 화면은 보지 못했다.
- 2026-11-02 — 할 일 정리(사용자 'todo를 검수하고 다듬자'). 열린 항목을 코드로 다시 확인했고(모두 그대로), 맨 위 '할 일' 절 하나로 모았다: 결함 F1~F11 · 인사이트 개선 I1~I6 · 사용자 결정 D-1~D-7 · 업스트림 · 외부 U1~U7 · 확인 대기. 점검 · 검수 절은 근거로 두고 체크 상자를 뺐다. '지금 할 일' 줄을 고쳤다. 업스트림 초안에 없는 질문 둘(D6 덧붙임 · Overview 라벨 정의)을 U1에 적었다.
- 2026-11-02 — 마지막 검수 결함 F1~F4 18건(사용자 '고쳐', `e41ea10`). 재현 시험은 고치기 전 실패를 확인했다(BFF 12건 · 프런트 14건). Website Prompts 엔진 선택지 단언 하나는 고친 뒤에 더했다. Global: Prompts 상세 이력 키(HUB id) · 이력 탭 기간 먼저 · 묶음 전체 건수, Mention 요약 '변화'가 모든 브랜드 선, 경쟁 구도 표 · 경쟁사 표 정확값 정렬, Overview 기간 모드 안내 · '언급 1위 경쟁사', ACR 선택지 고른 회차 · 차종 발견 문구. Website: 기간 문구 회차 수(Gold 데이터 회차), ④ · ⑤ 문구, 추이 머리 회차 범위, 패널 엔진 선택지 Gold(Overview · Mention · Citation · Prompts), Mention 열 이름 · 엔진 표 머리 · 주별 문구 · Top 3 ⓘ · 브랜드별 사이트 시장 수, Citation 공식(당사) 문구 · 하위 화면 제목. 시험: BFF 37개 모듈 739건 통과(건너뜀 7), 프런트 관련 167개 파일 1,816건 통과 · 실패 2건은 기준선(period-delta-off-parity overviewKpiCards, 깨끗한 작업 트리에서 같은 실패 확인) · typecheck · eslint 통과. 프런트 전체 시험은 돌리지 않았다. 골든: ACR 8건 테이프 회차 이동 · Mention 16건 정확값 순서 · website 선택지 39건 engineOptions 추가(README, 그 밖 변화 없음 확인). 옛 Overview 바이트 골든의 '경쟁 순위의 합' 1줄씩 고침. 실데이터(API 재시작 뒤): 이력 24,460건 4묶음 0.37초 · 상세 2건, 미국 '변화' Mazda ▼0.4, Website 점유율 2위 Tata, ACR 08-17 9개국(EG 포함), Kia 답변 없는 시장 15, 미국 9월 직전 2회차, DeepSeek 노출률 31.0% · Prompts 렌즈 284개. 화면(3333, 1920×915): 새 문구 · 엔진 선택지 · 이력 묶음이 보인다, 오류는 기존 첫 방문 404 1건. 작은 표시 변경이라 e2e는 돌리지 않았다. `kpi-data-lineage.html` 15행과 집계(공통 4행 확인 안 함 → 일치)를 고쳤다.
- 2026-11-02 — 할 일 F5~F7(사용자 '고쳐', 추천 순서대로 F1~F4 다음, `9c69765`). F5: renewal ACR · Mention 문구 10곳에서 이름 뒤 고정 조사를 없앴고('2위 BMW 대비 +45.2pp'), Gold 대륙 권역 7개에 표시 이름을 붙였다. F6: en 회차 달력 key 중복은 브라우저에서 수정 전 경고 6건을 확인하고 고쳐 0건이 됐다(DOM 시험 환경이 없어 render 시험으로는 재현되지 않는다). 사이드바 · DashLayout hydration 불일치는 12개 화면에서 0건이라 손대지 않았다. F7: 인용 출처 분류(교정 · 시드) · 고객 관심(키워드 · 소스) · 엔티티 카탈로그에 저장한 필터를 붙였고(공용 훅, `saved_filters.PAGES` 5개, 마이그레이션 없음), Admin › Global prompts의 빈 측정 종류를 'single'로 보이지 않게 했다. 재현 시험은 고치기 전 실패를 확인했다(BFF 3건 · 프런트 5건). 시험: BFF 37개 모듈 742건 통과, typecheck · eslint 통과, 프런트 관련 폴더(lib 전체 포함) 실패 118건은 20개 파일 모두 작업 전 커밋 `6ee044f`의 깨끗한 작업 트리에서 같은 수로 실패한다(기준선). 화면(3333): Admin 다섯 목록에 '저장한 필터' 구역, Global Mention '2위 BMW 대비 +45.2pp', 페이지 오류 0. `kpi-data-lineage.html` 3행 · 각주 1곳을 고쳤다.
- 2026-11-02 — Admin 화면 하나씩 검수, 첫 화면 사용자 관리(사용자 요청, '근거'의 'Admin › 사용자 관리 검수'). 결함 F12~F19를 할 일에 적었고, 범위 교차는 사용자 결정(결정 기록 '범위 교차')이다. 사용자 지시로 심각도 순서대로 하나씩 고친다. 첫째, 임시 비밀번호 서랍이 Esc · 바깥 클릭 · X로 닫히던 것을 고쳤다(`d9792e9`). 공용 `RnDrawer`의 `onClose`를 선택으로 바꿨고(없으면 닫기 버튼 · Esc · 바깥 클릭 모두 없음), 사용자 관리는 비밀번호가 보이는 동안 닫기를 주지 않는다(`closeOf`). 재현 시험 2건은 고치기 전 실패를 확인했다. 리뉴얼 프런트 50개 파일 463건 · typecheck · eslint 통과. 실제 화면(재설정 요청은 브라우저에서 가짜 응답, DB 쓰기 없음): 비밀번호가 보이는 동안 닫기 버튼 0, Esc · 바깥 클릭 뒤에도 그대로, '확인'으로 계정 상세, 새 계정 서랍은 전처럼 Esc로 닫힘, 콘솔 오류 0.
- 2026-11-02 — 사용자 관리 F12(사용자 '다음 진행', `3a07e7d`). 상태 라벨을 '비밀번호 변경 필요'로, 머리 설명 · 임시 비밀번호 안내 · 상세 안내를 '다음 로그인 때'로 고쳤다(ko · en, 코드 주석 · `kpi-data-lineage.html`). 재현 시험 1건은 고치기 전 실패를 확인했다. Admin 프런트 7개 파일 68건 · typecheck · eslint 통과. 실제 화면(상세 응답만 브라우저에서 바꿈): 목록 칸 89px에 잘림 없음, 필터 선택지 · 상세 상태 · 안내 새 문구, 콘솔 오류 0. 문구 변경이라 e2e는 돌리지 않았다.
- 2026-11-02 — F12 다시 확인과 시험(사용자 '다시 확인해봐' · '테스트도 해봐', 코드 변경 없음). 실제 흐름(`audit2-region@local`, 실 DB): 사용 시작 → 재설정 → 임시 비밀번호 로그인 → 비밀번호 변경 → 사용 중지. 재설정 뒤와 임시 로그인 뒤(마지막 로그인 시각이 있어도) '비밀번호 변경 필요', 변경 뒤 '사용 중', en 'Password change required', `/ko/login/password` 강제 이동 정상. 계정은 사용 중지 · 알 수 없는 무작위 비밀번호로 끝났고 이력 4줄이 늘었다. 시험: 프런트 전체 8,254건 실패 121건은 직전 커밋 `45770c6`의 깨끗한 작업 트리와 목록까지 같다(새 실패 0, 기준선은 옛 `lib/scope` · `lib/db` 등). typecheck · lint 통과, BFF 전체 742건 통과(실 API · 실 DB 포함, 건너뜀 2). '비밀번호 바꾼 때' 표시는 F17에 더했다. 다음은 F13(사용자 지시 뒤).
- 2026-11-03 — Project 점검과 메뉴 목업(사용자 '확인하고 고민해보자' → '메뉴 구성부터 목업'). 레거시 Project: 목록 · 새 프로젝트 · 상세(Dashboard · Intent › Google Keyword · Social Scraping · Prompt · Analysis › Mention · Citation · AI Agent Funnel › AI Conversion · Setting › General · Member). 지금 (dash) 화면은 `fb88fe0`부터 Gold 읽기 전용이고, 쓰기는 원본 운영 API(`back/app`) · Scope로 가서 로컬에서는 모두 405다. Gold surface 3: 프로젝트 130개, 프롬프트가 있는 곳 98개(중앙값 8개), 회차가 있는 곳 73개(144회차, 10-05 ~ 10-12), 답변 8,128개. 이름 · 브랜드 · 국가는 Gold에 없다. 'KR · 프롬프트 3 · 답변 6' 프로젝트가 12개라 Gold 값만으로는 구별되지 않아, 목록은 첫 프롬프트 원문으로 구별한다. 목업 `docs/design/ui/project-menu-mockup.html`: 안 A(추천) · B · C를 바꿔 보고, 목록 · 프로젝트 안 · 범위 계정을 본다. A는 프로젝트를 열면 Global · Website 구역이 접힌다(다 펼치면 Analysis가 약 940px로 915 밖). 하위 메뉴는 레거시 순서 · 라벨 그대로이고, AI Visibility · ACR은 레거시처럼 두지 않는다. 범위 계정에는 Project 구역을 숨긴다(⛔J). 결함 F20(범위 계정의 Project 목록 노출)을 할 일에 적었다. 시험 대상 코드 변경 없음(목업은 Playwright로 1920×915 렌더 · 콘솔 오류 없음 확인).
- 2026-11-03 — 서비스 기준 주(`a3b28e7`, 사용자 '시작', 결정 기록 '발행 시점 판정' · '기준 주 세부' · '미적재 표면' · '서비스 기준 주 저장'). 만든 것: `data-011.sql`(`catalog.service_week` · `current_service_week`, `hmg_service_week_writer`), `back/hub_storage/service_week.py` · `manage.py sync-service-week`(VM `vm.sh service-week` 매시 10분, 로컬 `start-local.sh`), BFF 공급자(`hub_stores/service_week.py`) · `Context.create` 상한 · 리더(compare · catalog · acr · answers · cache · `cycles/week-notes`) · 화면 `shared/service-week` · 기간 되돌림, 프런트 칩 · 지연 안내 · 주별 안내 · '측정 없음' · 달력 · 기간 선택 상한(리뉴얼 · 원본), 아키텍처 문서 · ERD · 지표 출처 · README · 업스트림 D9 · D10. 적대적 검증 5회(관점 5개, 지적마다 반박 검증 2개, 재현 시험 먼저): 지적 20 · 13 · 12 · 12 · 11건, 고침 18 · 11 · 10 · 5 · 3건(4회차부터 상 · 중만, 사용자 결정), r2-1은 원칙으로 정해 고쳤고 하 9건은 0절에 남겼다. 시험: BFF 41개 모듈 전체 통과, 프런트 전체 실패 121건은 기준선과 이름까지 같다(새 실패 0), typecheck · eslint(경고 2건은 기존) 통과. 실제 확인: 기준 주 10월 2주차(10/5~10/11), 지연 23일, 주별 안내 2건(Website 7월 4주차 미발행 1 · 9월 3주차 숨김 1), 6/8~11/3 매일 판정을 옛 규칙과 대조해 차이 0일. VM에는 반영하지 않았다.
- 2026-11-03 — D-8 사용자 답을 적었다(결정 기록 'GA4 · SEO와 기준 주'). GA4 · SEO 화면은 서비스 기준 주와 따로 둔다. 지금 동작과 같아 코드는 고치지 않았고, 아키텍처 문서의 기준 주 설명에 한 줄을 더했다.
- 2026-11-03 — Project 메뉴 목업에 안 D를 더했다(사용자 '프로젝트는 다른 탭을 열어서 해결하면 어떨까'). 메인 사이드바의 Project 구역은 'Project list' 하나로 두고, 목록 행(새 탭 아이콘)을 누르면 이름 있는 프로젝트 탭 하나(`hgh-project`)를 열거나 다시 쓴다. 프로젝트 탭의 사이드바는 프로젝트 카드(⇅ 바꾸기, 그 탭 안에서) + 하위 메뉴이고, 맨 아래 'Project list'는 원래 탭에서 연다. 탭 제목은 '<프로젝트> · <메뉴> — HMG GEO'. 추천을 A에서 D로 바꿨다(메인 메뉴가 늘지 않고, Website Overview 카드의 새 탭(W1)이 선례). 목업은 행을 누르면 실제로 새 탭이 열린다. Playwright로 새 탭 열기 · 같은 탭 다시 쓰기(두 번째 행에도 탭 2개 그대로) · 탭 안 바꾸기 · 콘솔 오류 없음을 확인했다. 이미 열린 프로젝트 탭으로 브라우저가 화면을 옮겨 주는지는 확인하지 못했다.
- 2026-11-03 — Project 메뉴 D안 P0 · P1과 F20(사용자 'D안으로 진행하자', `a216eb3`). F20은 재현 시험(범위 계정의 `/v1/gold/projects` 200)이 고치기 전에 실패했고, `access.clamp`가 `gold/projects`를 project 표면으로 보게 해 403이 된다(`/v1/gold/projects/…` · `screens/projects/list` · `projects/detail` 모두). BFF `projects/list`에 Gold surface 3의 측정 국가 · 언어 · 엔진 · 회차 · 커스텀 태그 수 · 첫 프롬프트를 더했다(130행 · 답변 8,128 · 0.09초, 대조 값 같음). 프런트: 경로 정책 `/renewal/projects`(관리자, 숨김 행), 목록 `/renewal/projects`, 프로젝트 탭 `/renewal/projects/[id]/[[...sub]]`(원본 메뉴 경로, 상위는 첫 하위로, 그 밖은 404, 모두 미구현 안내), 사이드바 프로젝트 탭 모드 · 카드 · 바꾸기 창, 미구현 본문을 `_components/unimplemented.tsx`로 같이 씀. 시험: BFF 41개 모듈 869개 통과, 프런트 리뉴얼 · 경로 정책 · 내비 · dash 96개 파일 1,405개 중 실패 1건은 HEAD에도 있던 `page-title.test.ts`(renewal AI Conversion 제목) 기준선 실패, typecheck · lint 통과. Playwright e2e(실제 앱, 1920×915): 사이드바 Project list → 목록 130개 → 검색 → 행 클릭 새 탭(제목 'Dashboard · bb60f101 · …', 사이드바는 Project 구역만) → Mention → 바꾸기(같은 메뉴) → 메인 탭 둘째 행이 같은 프로젝트 탭을 다시 씀(탭 2개) → 탭의 Project list가 메인 탭으로, ACR · 없는 프로젝트는 404 화면, 상위 경로는 첫 하위로, 페이지 오류 없음. 로컬 API를 다시 띄웠다. 아키텍처 문서 접근 규칙 · 마지막 갱신을 고쳤다.
- 2026-11-03 — Project P2 Dashboard(사용자 'Project를 구현하는 거야', `431b440`). 범위: 원본(fb88fe0 이전) Dashboard의 필터 · KPI · 추이 · 구성비 · 타일 · 프롬프트 상태 · 최근 후보 · 최근 프롬프트 · 빠른 실행 중 Gold에 있는 것은 그대로, 없는 것은 '데이터 없음', 빠른 실행은 뺌(결정 기록 'Project 당사 · Dashboard 구성'). BFF `screens/project_dashboard.py`(Website Overview 읽기를 surface=project로, live만), `_filters.project_page_filters`, 저장 키 `project-*`(시험 먼저 실패 확인). 프런트: 공용 필터 모델에 surface "project"(커스텀 태그 축 `cf_*`, 결정 기록 'Project 필터 축'), `/renewal/projects/{id}` Dashboard(선택적 catch-all을 `[...sub]`로 옮김), Website KPI · 출처 카드에 같은 탭 링크 · 프로젝트 문구를 끼우는 자리. Gold 대조(35ae7ec0, 2026-10-09): 노출 91/192 = `kpi_cell` 관점 7(HMG) tracked · answers, ⑤ 46/3,973 = cit_m05 · cit_total, 태그 AI 7/24. 시험: BFF 42개 모듈 870개 통과(건너뜀 12), 프런트 리뉴얼 · 내비 · 경로 정책 66개 파일 910개 중 실패 1건은 기준선 `page-title.test.ts`, typecheck · eslint 통과. e2e(스크래치 프런트 3344, 1920×915): Dashboard 3.7초, KPI 8종, 국가 잠금, 태그 AI → 노출 47.4 → 29.2%, 타일 → 같은 탭 Mention, 페이지 오류 없음. 3333은 옮긴 경로를 못 읽어 404였다(Turbopack, 재시작은 사용자). 로컬 API를 다시 띄웠다.
- 2026-11-03 — Project P3 Analysis › Mention · Citation(`6b33377`). 범위: 원본 Mention(요약 · 맞대결 · 우호도 · 유형 · 주별 추이 · 브랜드 표)과 Citation(카테고리 → 도메인 → URL, 카테고리 칩)은 Global 리뉴얼 본문이 모두 담는다. 프로젝트 프롬프트는 경쟁 질문(35ae7ec0: Toyota 941 · HMG 611회)이라 Website(자사 페이지) 본문 대신 Global 본문을 썼다. BFF: `mention_data.surface_filters` project 분기, `mention/rn-page`는 기준 주를 읽지 않음, `citation/project` `ctx.variant=renewal` · `as-of` · `renewal-header` · `prompts` · `tone-urls`의 project 분기, 프로젝트 필터 `uncapped`(기간 창을 기준 주로 자르지 않음). 프런트: `/renewal/projects/{id}/analysis/mention` · `citation`(+ `prompts` · `tone-urls`), Citation 단계에 출처 축. Gold 대조(35ae7ec0, 10-09): Mention 노출 91/192 · Toyota 941회 1위, Citation 카테고리 `citation_cell`(관점 7 · 모수 2) 973 · 942 · 869 · 506 · 223(자사 loc_owned 46) = 3,973. 시험: BFF 42개 모듈 873개 통과, 프런트 리뉴얼 · 내비 · 경로 정책 911개 중 실패 1건은 기준선, typecheck · eslint 통과. e2e(3344): Mention 19개 화면 · 브랜드 상세 · 서랍(BMW, 태그 AI 프롬프트 7) · 답변 원문, Citation 본문(출처 축 있음, 경쟁사 없음) · 톤 URL(긍정 676 · 부정 17) · 자사 URL 프롬프트(13 / 83), 페이지 오류 없음(스크래치 서버 favicon 404만).
- 2026-11-03 — Project P4 Prompt(`e49aa05`). 범위: 원본 Prompt(후보 목록 · 수동 입력 · 목록(원문 · 상태 · 브랜드 · 카테고리 · 커스텀 태그 열 편집) · 일괄 태그 · 열 추가/삭제 · 실행 · 삭제 · 가져오기/내보내기) 중 Gold에 있는 읽기만 옮겼다. Gold 리더 `gold/projects/{id}?view=prompts`(프롬프트 · 태그 값 · 보관 안 된 필드(created_at 순) · 렌즈 안의 답변 · 엔진 · 회차 · 국가), BFF `projects/prompts`(태그는 행을 좁히고 렌즈는 행을 남김). 프런트 `/renewal/projects/{id}/prompt`: 검색(원문 · 태그 값) · 정렬(태그 열 포함) · 쪽 · 엑셀 · 상세, 원본 쓰기 · 상태는 운영 DB 몫이라고 알림. Gold 대조(35ae7ec0): 96개, 답변 합 384 = 프로젝트 답변, 태그 AI · Gemini · 10-09 → 12개 · 답변 12 = `kpi/summary` 분모 12 · 측정 프롬프트 12. 시험: BFF 42개 모듈 875개 통과, 프런트 916개 중 실패 1건은 기준선, typecheck · eslint 통과. e2e(3344): 3.2초, 태그 5열, 태그 열 정렬, 검색 'OTA' 4개, 상세(태그 · 엔진 · 국가 · 회차), 태그 AI + Gemini 12개, 엑셀 파일 이름, 페이지 오류 없음.
- 2026-11-03 — Project P5 AI Conversion(`9a20231`). 원본 project Conversion은 `sources/analytics`(projectId)였고, HUB 분석 리더는 프로젝트를 `ref.dim_project`의 사이트 브랜드 · 국가가 같은 GA4 속성에만 잇는다. Gold project 행은 그 값이 0이라 어느 속성과도 이어지지 않고, 로컬에는 등록된 속성이 없다(U4). 그래서 `conversion/renewal`에 `ctx.project_id`를 넘기는 길만 만들고(이어진 속성만 읽고 그 시장만 필터에), 화면은 다른 Conversion 화면처럼 샘플 막 · 사이드바 열쇠(`ACCOUNT_PROJECT_PAGES`). 시험: BFF 42개 모듈 877개 통과, 프런트 사이드바 · 프로젝트 55개 통과, typecheck · eslint 통과. e2e(3344): 샘플 막 · 열쇠 표시, 페이지 오류 없음.
- 2026-11-03 — Project Intent 범위 확인과 Setting › General · Member 읽기 부분(`54be973`). Intent: 원본(fb88fe0 이전)은 추적 키워드 탭 · 키워드 검색 시작(DataForSEO) · 후보 만들기, 지금 (dash)는 Gold `kw_*` · `ctx_*` 전체 수집 화면이다. Gold 두 계열에는 프로젝트 열이 없고, 리뉴얼 Admin 고객 관심(시드 · 소스 입력) · 키워드 도구(⛔D)와 겹친다 → D-6에 제 안을 적고 미구현으로 둠. Setting: 원본 절(일반 · AI 엔진 · 소유 URL · 추적 URL · 추적 대상 · scope 연결 · 위험 구역) 중 Gold 값만 보이고 나머지는 '데이터 없음', Member는 데이터 없음 → D-7에 제 안. 서버 컴포넌트가 클라이언트 모듈 상수(`ENGINE_LABEL`)를 읽어 엔진 코드가 그대로 나오던 것을 e2e에서 찾아 서버용 라벨(`aiEngineLabel`)로 바꿨다(Setting · Prompt 렌즈). 시험: BFF 42개 모듈 878개 통과, 프런트 917개 중 실패 1건은 기준선, typecheck · eslint 통과. e2e(3344, 9d01e408): 프로젝트 탭 메뉴 9개(Intent 2개 미구현 · Conversion 열쇠) 모두 200 · 2.7~5.0초, Setting · Member 내용, 페이지 오류 없음. 스크래치 서버 재시작 직후 첫 Mention 컴파일에서 사이드바 `useId` 불일치 경고가 두 번 보였고, 데운 서버에서 같은 순서 · 직접 열기로는 재현되지 않았다(추적만).
- 2026-11-03 — Project 입력 1단계: 프롬프트 · 커스텀 태그 편집(`41fa283`). 레거시 대조 판정('판정대로 진행')으로 D-6 · D-7을 정하고, 프로젝트 프롬프트 적재 방식을 정했다(결정 기록 3건). 새 표 없이 HUB 카탈로그가 정본이고(`data-012`, `hmg_project_editor`), Gold 가져오기는 HUB가 고친 항목의 HUB 키를 지킨다. 화면은 상태 탭 · 추가 · 태그 칸 · 일괄 · 태그 열 · 원문/언어(초안) · 유형 · 중지/재개 · 삭제/복원 · 이력, 측정 실행은 열쇠다. 값 대조: HUB 카탈로그 3,072개 · 태그 열 160개가 Gold와 모두 같다(반영됨), 35ae7ec0은 96개. 시험: BFF 43개 모듈 904개 통과(건너뜀 21은 모두 환경 변수 필요), 새 저장소 시험은 실제 데이터 DB에서 롤백(`HGH_PROJECT_PROMPTS_TEST_DB_URL`), `manage.py init`(012) · `verify` 통과, 가져오기 SQL은 가져오기 계정으로 실 DB에서 실행. 프런트 전체 24개 파일 122건 실패는 HEAD(`96202b3`) 깨끗한 작업 트리와 같다(기준선), 통과 6건 늘었다. typecheck · eslint 통과. 그중 `test/bff-boundary.test.ts`는 a216eb3이 `lib/scope/engines.ts`를 읽게 한 뒤로 실패하던 것이라 허용 목록에 넣어 고쳤다(`c0ead38`, 전 1 실패 → 후 4 통과). e2e(3344 스크래치, 35ae7ec0): 추가(1개 추가 · 1개 건너뜀 → 초안 탭) · 태그 칸 · 일괄 2개(측정 중 행 '반영 대기') · 중지/재개 · 이력 · 초안 원문 수정 · 삭제/복원(draft로) · 태그 열 추가(반영 대기)/보관 모두 동작, 예열 뒤 hydration 경고 0. e2e에서 태그 토스트의 `'{label}'`(ICU 따옴표 이스케이프) 문구 결함을 찾아 고쳤고 시험을 더했다. e2e가 남긴 로컬 카탈로그 기록은 지워 개수를 처음과 맞췄다(프롬프트 28,250 · 버전 56,066 · 프로젝트 버전 647). 로컬 API는 다시 띄웠고, 3333 프런트는 그대로다.
- 2026-11-03 — Project Intent 원형(`e2de277`, 사용자 '원형은 만들되 백드랍으로 막아두자'). Google Keyword: 추적 키워드 줄(선택 · 기간 · 국가) · 관련 검색어 · 관심도 추이와 평균 관심도 · 검색 결과 기반 프롬프트 생성. Social Scraping: 구매 맥락 지도 요약과 프롬프트 구성 · 구매 맥락 · 구매 조건 · 조합 패턴 표(첫 페이지와 페이지 이동) · 추천 프롬프트. 모두 원본 문구(`projectDetail.intent.googleKeyword` · `socialScraping.contextMap`)와 샘플 행이고 'DataForSEO · OpenRouter 계정 필요' 막(U3) 아래 inert다. 사이드바 두 항목은 미구현 대신 열쇠(`ACCOUNT_PROJECT_PAGES`). 시험: 관련 3개 파일 41건 통과(샘플 시험 2건 추가), 프런트 전체는 HEAD(`33db456`) 깨끗한 작업 트리 기준선과 실패 121건이 같은 목록(새 실패 0, 통과 2건 늘어남), typecheck · eslint 통과. e2e(3344 스크래치, e0011964): `intent` → google-keyword 이동, 두 화면 200 · 0.7~1.9초, 막 안내 보임, 표본 버튼에 포커스가 가지 않음(inert), 본문을 끝까지 내려도 안내 카드 제자리, 가로 스크롤 없음, 사이드바 열쇠 2개와 현재 항목 표시. 콘솔: 차트 크기 경고 2건은 Website Overview에도 있는 RnLineChart 첫 측정 경고(12건)이고, 404 한 건은 Project list에서 나와 이 변경과 무관. e2e에서 추천 프롬프트 '추가됨'이 좁은 열에서 세로로 꺾이던 것을 고쳤다.
- 2026-11-03 — 인용 출처 분류 입력 버전(`9c86b1d`, 사용자 '진행'). `data-013`: 버전 표 네 개와 트리거 `catalog.record_source_version()`. 그때까지의 기록은 이력 표에서 옮겼다(교정 5 · 시드 799 · 소셜 15 · 코드 25 버전 = 이력 행 수). 재현: 새 시험 `test_hub_source_versions` 3개가 마이그레이션 전 3개 모두 실패(표 없음) → 후 통과. 그중 하나는 발행 set 21개를 모두 그 시점의 버전으로 다시 만들어 같다. `manage.py init`(013) · `verify` 통과, verify는 현재 행과 최신 버전이 어긋나면 실패하는 것도 롤백 트랜잭션에서 확인했다. BFF 전체 907개 통과(기준선 904 + 새 3, 건너뜀 25 = 22 + 새 3은 DB 환경 변수 필요), 실 DB 시험(버전 · 시드 목록 · 교정) 25개 통과. ruff 지적 4건은 HEAD에도 있던 것(`manage.py` · `verify_connections.py`). 화면 · BFF 쓰기는 바꾸지 않아 e2e는 돌리지 않았다. 아키텍처 문서 · ERD · README를 고쳤다.
- 2026-11-05 — 서비스 팔레트 적용(`f58dbed`, 사용자 '확정안'). 토큰(`renewal-theme.css`), 차트 계열색(새 `components/renewal-ui/palette.ts`, 화면 25개 파일의 hex를 옮김), `design-rules.html`(토큰 · 색 역할 절). 셀 칠 위 글자 두 곳은 AA로 맞췄다(히트 3단계 위 파랑 글자 → `rn-navy-500`, 빨강 14% 칠 → 10%). 시험: 단위 전체 실패 121건이 손대기 전 기준선과 같다(새 실패 0, lib/scope 등 기존 실패). 색 값을 보던 시험 3개를 새 값으로 고쳤다. typecheck · lint 통과. Overview · Mention · ACR · Visibility · Website Overview를 1920×915로 찍어 확인했다(새 화면이 아니라 e2e는 돌리지 않았다).
- 2026-11-05 — 서비스 팔레트를 원본 (dash) 화면에 적용(`e88fce8`, 사용자 'global 화면에도'). `globals.css` 토큰, 원본 차트 hex 목록 6개 파일, 기준 주 칩 · 지연 안내의 (dash) 경고 아이콘, 차트 말풍선 글자색. 시험: 단위 전체 실패 121건이 기준선과 같다(새 실패 0). typecheck · lint 통과. 원본 Overview · Mention · Citation을 1920×915로 찍어 확인했다. 콘솔의 404는 `favicon.ico`(기존)이고, 한 번 보인 hydration 경고는 다시 열었을 때 나오지 않았다.
- 2026-11-05 — 그라데이션 · 글래스 제거(`d5c13c5`). 리뉴얼: 핵심 카드 · 당사 행 5곳 · 저장한 필터 · 인용 범례 · 계정 대기 막. 원본: 스파크라인 · 로딩 블록 · 블러 3곳 · 안 쓰던 그라데이션 유틸리티. `design-rules.html`(핵심 카드 단색, 팔레트 견본을 단계 칸으로, '하지 않는 것'에 그라데이션 · 글래스 면). 시험: 단위 전체 실패 121건이 기준선과 같다(새 실패 0), 로딩 블록 시험 1개를 pulse로 고쳤다, 영향받는 25개 파일 250개 통과. typecheck · lint 통과. 리뉴얼 Overview · Mention을 찍어 확인했다.
- 2026-11-05 — Global Mention 브랜드 상세 먼저(`ef6e672`, 사용자 'global mention에서 브랜드 상세가 맨 처음에'). `mention-input` `resolveMentionView`의 brands-first 판정과 `brandsFirst`, `mention-tabs` 탭 줄 순서 · 링크 쿼리, Global `page.tsx`만 켬. `design-rules.html` 화면 안 탭 절. 시험: Mention · Website Mention · Project 16개 파일 118개 통과(기준선 115 + 새 `mention-tabs.render.test.tsx` 3), typecheck · eslint 통과. 단위 · render 시험으로 확인되는 변경이라 e2e는 돌리지 않았고 화면도 찍지 않았다.
- 2026-11-05 — 팔레트 빠진 곳 수정(`0e3dd9f`). 프런트: 어두운 면 글자 리뉴얼 72곳 · 원본 34곳, 원본 기본 색 88곳(17개 파일), 토스트 색, ACR 표시선. BFF: `acr.py` 브랜드 색 · `mention_surfaces.py` 감정 칠, golden 84건(색 값만, 전수 확인). 시험: 프런트 단위 전체 실패 121건이 기준선과 같다(새 실패 0). 클래스를 보던 시험 3개와 `period-delta-off-parity` 고정본의 `summaryTiles` 두 키(차이는 `text-emerald-600 → text-positive`뿐)를 고쳤다. `overviewKpiCards`는 기준선 실패 그대로다. BFF 44개 모듈 907개 통과(25개 건너뜀). typecheck · lint 통과. Tailwind로 `globals.css`를 직접 컴파일해 새 클래스 19개가 생성되고 기본 색 클래스가 0개임을 확인했다. 3333 개발 서버는 `globals.css`의 새 토큰을 아직 반영하지 않았고(오래 떠 있던 Turbopack), 5555 API는 BFF 수정 뒤 다시 띄우지 않았다. 둘 다 재시작해야 로컬 화면에 보인다.
- 2026-11-05 — Admin 목록 페이지(`df8b105`, 사용자 '리스트 테이블에 페이지네이션'). 새 `useAdminListPage`를 사용자 관리 · GA4 · 고객 관심 키워드 · 소스 · 인용 출처 교정 · 시드에 붙이고, 엔티티 역할의 페이지 코드를 그 훅으로 옮겼다. `design-rules.html` 틀 절에 '목록 페이지'. 시험: Admin 8개 파일 72개 통과(새 `admin-list-page.render.test.tsx` 2, 시드 50행 1, 화면마다 페이저 확인 5줄), typecheck 통과, eslint 오류 0(경고 1 `EntityRow` 미사용은 기존). 실제 화면(3333, 1920×915)에서 시드 다음 페이지 · 페이지당 100 · 검색 시 1페이지, 엔티티 2페이지 → 정렬 → 1페이지를 확인했다. 단위 전체는 돌리지 않았다(바뀐 모듈은 Admin 안에서만 쓰인다).
