# 허브 서버 분리 범위표 (T13.1 · T14.5.1)

2026-11-06 코드 기준이다. 줄 번호는 `back/bff`를 옮기기 전(1a)의 값이고 뒤 단계에서 밀린다. 순서와 통과선은 `docs/handoff/architecture-rebuild.md`의 '개발 순서'를 따른다.

확인 방법: `back/bff/app.py`의 67개 경로를 호출 그래프로 따라갔고(AST), GET은 맥의 실제 DB에 호출해 어느 연결을 썼는지 기록했다. 쓰기(POST · PUT · PATCH · DELETE)는 실행하지 않고 코드로만 따라갔다. 이전 기록의 '따라가지 못한 15개'는 목록이 남아 있지 않아 67개를 모두 다시 따라갔고, 남은 미확인은 없다.

## 1. `/v1` 67개

허브 서버 55 · 데이터 서버 11 · 양쪽 1(`/healthz`는 서버마다 자기 것). 모든 경로의 `operations_db` 읽기는 계정 재확인이고, 허브 서버로 옮기면 데이터 서버에서 사라진다. 아래 'DB'는 그것을 뺀 나머지다.

| 경로 | 수 | DB | 옮길 곳 | 단계 |
|---|---|---|---|---|
| `POST /v1/auth/login` · `GET /v1/auth/me` · `POST /v1/auth/password` | 3 | `operations_db` 읽기 · 쓰기 | 허브 서버 | 1d |
| `/v1/hub/accounts` 목록 · 생성 · 상세 · 변경 · 동작 | 5 | `operations_db` 읽기 · 쓰기 | 허브 서버 | 1d |
| `/v1/hub/saved-filters` 목록 · 생성 · 가져오기 · 변경 · 삭제 | 5 | `operations_db` 읽기 · 쓰기 | 허브 서버 | 1e |
| `/v1/hub/ga4-properties` 목록 · 상세 | 2 | `input_db` 읽기 | 허브 서버 | 1f |
| `/v1/hub/ga4-properties` 생성 · 변경 · 동작(`app.py:217 · 230 · 243`) | 3 | `input_db` 쓰기 | 허브 서버 | 1f |
| `/v1/hub/global-prompts` 목록 · 옵션 · 상세 · 생성 · 변경 · 상태 | 6 | `input_db` 읽기 · 쓰기 | 허브 서버 | 1f |
| `/v1/hub/projects/{id}/measurement` 읽기 · 쓰기 | 2 | `input_db` 읽기 · 쓰기 | 허브 서버 | 1f |
| `/v1/hub/projects/{id}/prompts · prompt-tags · prompt-fields` 이력 1 · 쓰기 6 | 7 | `input_db` 읽기 · 쓰기 | 허브 서버 | 1f |
| `/v1/hub/{source-overrides · source-seeds · source-socials · source-codes · interest-keywords · interest-sources · entity-roles}/history` | 7 | `input_db` 읽기 | 허브 서버 | 1f |
| 위 7종의 쓰기 중 Gold 확인이 없는 것(출처 교정 해제, 시드 2, 소셜 2, 코드 2, 키워드 2, 출처 2) | 11 | `input_db` 쓰기 | 허브 서버 | 1f |
| 출처 교정 저장 · 엔티티 역할 저장 · 해제 | 3 | `input_db` 쓰기, `gold_db` 확인 읽기 | 허브 서버 → 데이터 서버 확인 요청 → 기록(D-26) | 1f |
| `/v1/hub/{kind}`(`projects` · `prompts`, 내부 목록) | 1 | `input_db` 읽기 | 허브 서버 | 1f |
| 위 7종의 목록 + 엔티티 언급 | 8 | `gold_db` + `input_db` 읽기 | 데이터 서버(D-26) | 1f |
| `/v1/hub/ga4-properties/{id}/events` | 1 | `gold_db`(`analytics`) + `input_db` 읽기 | 데이터 서버(D-26) | 1f |
| `/v1/screens/{path}` | 1 | `gold_db` · `input_db` · `cache_db` · 가상 OBT | 데이터 서버 | 그대로 |
| `/v1/{path}`(읽기 34종: 지표 · 드릴다운 · `gold/*` · `analytics/*`) | 1 | `gold_db`(`analytics` 포함) · `input_db` · 가상 OBT | 데이터 서버 | 그대로 |
| `/healthz` | 1 | 서버마다 자기 연결 | 양쪽 | 1c · 1f |

D-26의 '12개'(목록 8 · GA4 이벤트 1 · 저장 3)는 코드와 실행 기록으로 같은 12개임을 확인했다.

## 2. 데이터 서버에 남는 입력 DB 읽기

`hub_stores`의 모듈은 읽기와 쓰기가 한 파일에 있어 1f에서 나눈다. 화면이 부르는 읽기는 데이터 서버에 남는다.

| 읽기 | 부르는 곳 |
|---|---|
| `measurement.read` | `screens/project_dashboard.py:266` |
| `project_prompts.catalog` | `screens/project_dashboard.py:222` |
| `catalog_editor.history_rows`(작성자 이름 포함) | `screens/standard_prompts.py:331 · 352` |
| `service_week` · `analytics_reader` · `metrics_db` · `cache_db` · `silver_db` · `input_db` | 화면 · 지표 전반 |
| D-26 목록 8 · GA4 이벤트 · 저장 확인 | 1 절 |

## 3. React가 부르는 Next `/api/*`

`rg -n '/api/' front-react/src`로 뽑았다. 아래 12묶음, Next 라우트 파일 30개다. 1c~1g 동안 Next의 이 라우트는 그대로 있고 `HGH_API_BASE_URL`만 허브 서버를 가리킨다. 표의 '2b 뒤'는 React가 허브 서버로 바로 올 때의 자리다.

| 경로 | 지금 Next가 하는 권한 · 파라미터 처리 | 2b 뒤 | 응답 |
|---|---|---|---|
| `/api/hub/session` GET · POST · DELETE | Origin 확인, 쿠키 ↔ 토큰, 로컬 모드 확인 | 허브 서버(쿠키 발급 · 삭제) | 토큰을 뺀 `{user}`. 허브 서버 자기 일 |
| `/api/hub/password` | Origin, 쿠키 재발급 | 허브 서버 | 같음 |
| `/api/hub/{accounts · saved-filters · global-prompts · ga4-properties · source-overrides · source-seeds · source-socials · source-codes · interest-keywords · interest-sources · entity-roles}`, `/api/hub/projects/{id}/…` (12개) | 경로 허용 목록(정규식), 쓰기 Origin, 쿠키 → Bearer, 생성 201 | 허브 서버. 허용 목록은 허브 서버 라우트가 대신함. 목록 GET은 1 절대로 데이터 서버로 | 그대로 |
| `/api/screens/{name}` (다른 세션의 미커밋 코드) | 화면 이름 허용 목록, 비밀번호 변경 강제, 표면 판정, 메뉴 권한, `ctx.*` 허용 목록, `ctx.role` · `ctx.admin`을 계정에서 결정(`front/lib/hub/screen-read.ts`) | 허브 서버 | 그대로 |
| `/api/service-week` | 세션, 사이트 선택 4개만 전달 | 허브 서버 | 그대로 |
| `/api/filters/options` | `area` · `surface` · `project_id` 검증, 세션, 메뉴 권한(`:64`), 프로젝트 게이트, 전달 파라미터 3개 | 허브 서버 | **`{options}`로 감쌈(`:76`). 13.2와 충돌** |
| `/api/scope/{answer · brand-citations · brand-mention-prompts · market-evidence · missing-prompts · signal-prompts}` (6개) | 세션, 쿼리 전체를 JSON `ctx.params`로(`_drill/proxy.ts:25`) | 허브 서버 | **`reply.body` · `reply.status`를 풀어 HTTP 상태로(`:26`). 13.2와 충돌** |
| `/api/scope/mention-compare` | 세션, `surface` · `projectId` · `admin`을 `ctx.*`로, `admin`은 관리자만 | 허브 서버 | 그대로 |
| `/api/standard/acr/sheet` | 메뉴 권한, 브라우저의 `ctx.*` 제거 | 허브 서버 | 그대로 |
| `/api/standard/prompts/{page · export · history · timeline}` | 이름 → 화면 대응, 메뉴 권한, `ctx.*` 제거 | 허브 서버 | 그대로 |
| `/api/website/prompts/{page · rows · insights}` | 이름 → 화면 대응, 메뉴 권한, `ctx.*` 제거, `ctx.admin`은 계정에서 | 허브 서버 | 그대로 |
| `/api/citations/domains`, `/[skey]`, `/export` | 정렬 · 건수 · 검색어 검증, `skey` base64url 해석, 세션, 메뉴 권한, 프로젝트 게이트, 소스 스위치, `ctx.*` 지정 | 허브 서버 | 그대로, `export`는 다운로드 헤더 추가 |

React가 부르지 않아 Next에 남는 것: `website/prompts/export`, `context-map`, `cron/*`, `internal/summary`, `keyword/*`, `qa/*`. 레거시 `hghGet` · `hghPost`를 쓰는 파일은 클라이언트 포함 13개다. `front/lib/hgh/client.ts:99`가 `HGH_API_BASE_URL`을 직접 읽으므로 프록시는 `/v1/*` 전체를 넘겨야 한다. 로컬 모드의 쓰기는 `client.ts:647`이 네트워크 전에 막는다.

허브 서버가 2b에서 새로 가져야 하는 판정: 메뉴 권한(`front/lib/auth/route-policy.ts` 557줄의 표. 계정 역할 4개만 쓰므로 화면 묶음 → 역할 표로 줄어든다), `ctx.*` 허용 목록, 파라미터 검증. 데이터 범위 좁히기는 지금처럼 데이터 서버(`access.clamp`)가 한다.

## 4. 정한 것 (`CLAUDE.md` 4절)

| 항목 | 고른 안 | 다른 안 | 근거 |
|---|---|---|---|
| `RHQ_REGION_COUNTRIES`(`accounts.py:36`이 `screens/_query.py`를 읽음) | `back/shared/regions.py`로 옮기고 두 서버가 읽는다. 내부 토큰 서명 · 검증도 `back/shared/`에 둔다. DB · FastAPI 의존 없음 | 허브 서버에 복사(정의 두 벌), 데이터 서버에 묻기(계정 편집이 데이터 서버에 묶임), 입력 DB 코드표(요청마다 DB 읽기, 스키마 변경) | 두 서버가 다른 컨테이너여도 같은 코드표를 쓴다. `accounts`가 화면 패키지 전체를 읽지 않게 된다 |
| 프록시 HTTP 클라이언트 | `httpx==0.28.1`(`back/requirements.lock`과 같은 버전), 허브 서버 전용 `requirements.txt` | `h11`로 직접 작성, `urllib` 스레드 | 지금 `hgh-bff` 환경에 없어 1c에서 설치한다. 스트리밍 · 연결 풀을 새로 만들지 않는다 |
| 포트 | 허브 서버 :5556, 데이터 서버 :5555 유지 | 허브 서버가 :5555를 쓰고 데이터 서버를 옮기기 | 'HGH_API_BASE_URL 값만 바꾼다'는 지시 그대로. `start-local.sh`의 상태 확인도 그대로 |
| 내부 토큰 | 요청마다 서명, 수명 60초, 로그인 토큰과 다른 키 `HGH_INTERNAL_TOKEN_SECRET`. 내용: 계정 범위, 1f까지 계정 ID · 역할 | 수명 길게 해 재사용 | 결정 기록 '내부 토큰', 이번 지시 1d |
| 13.7 | `sync_catalog.py:558`의 쓰기만 뺀다. 등록 코드는 만들지 않는다 | 허브 서버에 등록 코드 추가 | `system.project_reference`를 참조하는 `project_member` · `project_setting_version` · `integration`은 0행이고 쓰는 코드가 없다(실측). 붙일 곳이 없다. 258행은 그대로 둔다 |
| 작성자 이름 | 입력 DB에 기록 시점의 로그인 · 이름을 저장한다. 기존 행은 `operations_db`에서 한 번 채운다. 행이 있는 테이블: `prompt_version` 2, `source_code_*` 6, `source_override_*` 3, `source_seed_*` 4, `source_social_*` 6 | 조회 시점에 허브 서버가 합치기(`catalog/prompts-history`는 화면이라 데이터 서버에서 읽는다) | 이번 지시 1f. 계정 이름을 나중에 바꿔도 지난 이력의 이름은 그대로 남는다 |

## 5. 기준선 (1a, `.local/rebuild-baseline-2026-11-06/t13-before/`)

| 항목 | 값 |
|---|---|
| 값 · 상태 · 헤더 | HTTP 171건(첫 화면 빌더 127 + 반복 쿼리 키 · 상태 코드 · 다운로드 · Admin 읽기 · 이력 44). 2회 측정 차이는 `lastSignInAt` 1건(로그인 때문) |
| 응답 시간(캐시 찬 두 번째 회) | 합계 23.1초, p50 13ms, p95 569ms, 최대 6.3초(필터 건 `/v1/kpi/summary`) |
| 테스트 | 데이터 서버 1,019개 통과(건너뜀 34), React 단위 12개 통과, 프런트 8,695개 중 121개 실패(23개 파일, 오류 1건, 이전과 같은 건수, 목록 `tests/front-failed.txt`) |
| 실행하지 않음 | 쓰기 경로, 브라우저 e2e, 첫 호출 시간 비교, 공유 VM · Docker |

캡처 도구: `capture.py --http BASE OUT PROJECT`로 데이터 서버 · 허브 서버 어느 쪽이든 찍고, `compare_capture.py BEFORE AFTER --ignore lastSignInAt`으로 값 · 상태 · 헤더 · 다운로드 · 시간을 비교한다.

## 6. 발견 (T13 전부터 있던 것)

- `website/prompts/export`의 `.xlsx`는 실제 xlsx가 아니다. `gold_reader/catalog.py`가 `format=xlsx`를 읽지 않아 JSON이 나오고, Next가 그 몸체에 `.xlsx` 파일 이름을 붙인다(기준선: `application/json` 70,978바이트).
- `citation/domains-export`는 Gold 소스에서 404다(코드 주석대로, 화면은 실패 안내).
- 그래서 1c의 'xlsx 다운로드 동일'은 실제 파일로 확인할 수 없다. 전후 동일 비교에 바이너리 스트림 스텁 테스트를 더한다.
- `catalog.project`를 만드는 코드는 `sync_catalog.py:508`뿐이다. T10.1 뒤에는 새 프로젝트가 생기지 않으므로, 2a 범위표에서 Website · Global 입력과 함께 물어야 한다.
