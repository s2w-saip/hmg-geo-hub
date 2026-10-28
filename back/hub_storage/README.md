# HUB 운영 DB / 데이터 DB 분리

두 개의 독립 PostgreSQL 컨테이너·볼륨·계정을 사용한다. 외부 Gold에는 쓰지 않는다.

[서비스 구조·DB ERD 정본](../../docs/architecture/hmg-geo-hub-architecture.html) (운영 DB ERD `#erd-ops`, 데이터 DB ERD `#erd-data`)

| 저장소 | 실제 DB / 로컬 포트 | 책임 |
|---|---|---|
| HUB 운영 DB | `hmg_operations` / `127.0.0.1:55437` | 사용자, 프로젝트 멤버십·권한, SW 설정 버전, 연동 설정, 감사 이력 |
| HUB 데이터 DB | `hmg_analytics` / `127.0.0.1:55436` | GA4·SEO, 프로젝트·프롬프트 정의/버전, 외부 공개 정책·뷰 |
| 외부 Gold DB | `gold` / 사내망 `10.0.20.126:8097` | GEO 측정·응답·멘션·인용 등 원천 데이터, 읽기 전용 |

기존 `hmg_analytics` 이름과 GA4·SEO 스키마를 유지했다. DB를 삭제하거나 재생성하지 않는다. 데이터 DB의 기존 `ops` 스키마는 SEO 빌드·발행 메타데이터이며, 사용자·권한을 담는 운영 DB와 별개다.

## 실행

저장소 루트 PowerShell에서:

```powershell
./scripts/start-hub-storage.ps1
# 개별 관리
python -X utf8 back/hub_storage/manage.py status
python -X utf8 back/hub_storage/manage.py sync-gold-catalog
python -X utf8 back/hub_storage/manage.py verify
python -X utf8 back/hub_storage/manage.py backup
```

macOS(Docker 없음)는 네이티브 모드로 같은 일을 한다: `HGH_PYTHON=~/micromamba/envs/hgh-bff/bin/python bash scripts/start-hub-storage.sh`. 두 저장소를 `.local/pg/` 아래 로컬 PostgreSQL(127.0.0.1:55436·55437, 관리 소켓은 소유자 전용)로 띄우고 init·가져오기·검증까지 실행한다. 재부팅 뒤에는 `scripts/start-local.sh`가 저장소를 함께 띄우고 연결 정보를 API에 넘긴다. 관리 명령을 직접 실행할 때는 `HGH_HUB_NATIVE=1`을 붙인다(예: `HGH_HUB_NATIVE=1 python back/hub_storage/manage.py set-admin`).

시작 스크립트는 기존 analytics 마이그레이션을 확인하고 새 DB/증분 마이그레이션을 적용한 뒤 API를 재시작한다. 실제 Gold 프로젝트·프롬프트만 가져온다. 기존 Next 프로세스는 유지한다. 반복 실행은 변경 없는 정의에 새 버전을 만들지 않는다. 적용된 SQL의 체크섬이 바뀌면 중단하므로 변경은 새 마이그레이션으로 추가한다.

로컬 비밀 파일은 git에서 제외하고 Windows에서는 현재 사용자와 SYSTEM에만 ACL을 부여한다. API에는 각 DB의 **조회 계정**과, 글로벌 프롬프트 편집용 **INSERT 전용 편집 계정**(`hmg_catalog_editor`, 아래 절)만 전달한다. 카탈로그 쓰기 계정과 운영 쓰기 계정은 관리 명령이 일시적으로 사용하며 Next나 API 이미지에 넣지 않는다. 초기화 전 기존 데이터 DB 백업을 만들었으며, 이후 두 DB 백업은 위 명령으로 실행한다. 백업 복원 시 두 DB와 비밀 파일을 함께 복원하고 프로젝트 참조를 검사한다.

## 프로젝트·프롬프트의 기준

- `catalog.project` / `catalog.prompt`: 삭제되지 않는 UUID, 원천(`gold` 또는 `hub`), 원천 UUID.
- `catalog.*_version`: 정의가 달라질 때 추가되는 버전. 서비스 계정은 수정·삭제할 수 없다. `current_*` 뷰는 최신 버전을 읽는다.
- Gold 가져오기는 현재 원천 정의의 버전 기록이다. Gold 측정 사실 전체를 복제하지 않는다. 원천에 없는 프로젝트 이름은 `null`이다. `registered_at`, `recorded_at`은 HUB 등록/관측 시각이며 원천 생성 시각이 아니다.
- `origin=gold`는 Gold 동기화가 관리한다. `origin=hub` 정의는 가져오기가 덮어쓰지 않는다. 글로벌 프롬프트는 최상위 관리자가 HUB에서 만들고 고칠 수 있다(아래 절). 프로젝트 프롬프트 편집과 Gold 측정 파이프라인으로의 전달은 아직 구현하지 않았다.
- 운영 DB는 `system.project_reference`에 **같은 UUID만** 보관한다. 관리 명령이 데이터 DB 존재를 확인한 뒤 등록한다. 데이터 커밋 후 운영 등록이 실패해도 재실행으로 복구된다. 두 DB 사이 FK나 원자적 트랜잭션은 없다.
- 향후 프로젝트 생성/설정 변경 서비스도 이 검증·등록 경로를 사용해야 한다. 프로젝트 제거는 새 정의의 보관 상태로 처리하고 정체성 행을 지우지 않는다. 설정·측정 실행은 프롬프트 버전과 설정 버전을 고정해서 기록해야 한다. 기존 Gold 측정에는 과거 HUB 버전 대응을 임의로 붙이지 않는다.
- `system.integration.credential_ref`에는 비밀 저장소 참조만 보관한다. 실제 키·토큰은 설정 JSON에 저장하지 않는다. 사용자/설정/권한에는 가상 초기 행을 넣지 않았다. 로컬 모드는 조회와 쓰기(글로벌 프롬프트 편집) 모두 HUB 로그인을 요구한다(2026-10-28부터 조회도).

## 글로벌 프롬프트 편집과 HUB 로그인 (2026-10-27)

리뉴얼 화면 Admin › Global prompts(`/renewal/admin/standards/prompts`)에서 **최상위 관리자만** HUB 카탈로그의 글로벌 프롬프트를 만들고, 고치고, 보관하고, 복원한다. 2026-10-28부터 로컬 모드의 모든 화면이 이 로그인을 요구한다. 쿠키가 없으면 화면은 `/login?next=…`로, `/api/*`는 401로 막힌다(`front/middleware.ts`).

- **대상:** Gold 루트 프로젝트(`definition.surface=1`, `is_root=true`)에 속한 프롬프트. `origin=hub`만 편집한다. `origin=gold`는 읽기 전용으로 보여 준다. HUB에서 고쳐도 다음 `sync-gold-catalog`가 Gold 정의를 새 버전으로 다시 기록하기 때문이다.
- **기록 방식:** 모든 변경은 `catalog.prompt_version`에 새 버전을 추가한다. 삭제는 `definition.status='archived'`인 버전이고, 복원도 버전 하나다. 정체성 행과 이력은 지우지 않는다. 버전마다 `recorded_by`(운영 DB `user_account.user_id`)를 남긴다. Gold 가져오기 버전은 `NULL`이다.
- **동시 편집:** 쓰기 요청은 보고 있던 버전(`expectedVersion`)을 보낸다. 최신이 아니면 409 `version_conflict`로 거부한다. 쓰기는 Gold 가져오기와 같은 advisory lock을 잡아 한 번에 하나씩만 기록한다.
- **검증:** 본문은 한 줄, 2000자 이하다. 퍼널·브랜드 언급·목록 유형·분류 코드는 Gold 분류 사전(`gold.dim_taxon`)의 값만, 언어·시장은 글로벌 카탈로그가 이미 쓰는 값만 받는다. Gold는 글로벌 프롬프트의 분류를 `catalog_entry`에 두므로 가져온 정의에는 퍼널만 있다. Gold를 읽을 수 없을 때는 카탈로그가 이미 쓰는 코드만 받는다. 같은 본문·언어의 사용 중 프롬프트가 있으면 409 `duplicate`로 거부한다.
- **계정과 권한:** API는 `HGH_CATALOG_EDITOR_DB_URL`(`hmg_catalog_editor`: `catalog.prompt`·`prompt_version` INSERT, catalog SELECT만)로 쓴다. UPDATE·DELETE·프로젝트 정의·공개 정책에는 권한이 없다.
- **로그인:** 운영 DB `002_hub_login`의 `system.global_role`(admin)과 `system.user_credential`(scrypt)을 쓴다. `POST /v1/auth/login`이 `HGH_AUTH_SECRET`으로 서명한 토큰(기본 8시간)을 주고, Next는 이를 httpOnly·SameSite=Strict 쿠키에 담아 HUB 요청에 Bearer로 붙이고, 화면마다 `GET /v1/auth/me`로 세션을 확인한다. 요청마다 계정 상태·역할·비밀번호 변경 시각을 다시 확인하므로, 비활성화·역할 회수·비밀번호 변경은 즉시 기존 세션을 끝낸다. 같은 아이디로 15분에 5번 틀리면 잠시 막는다(API 프로세스 메모리 기준).
- **측정:** HUB 프롬프트는 아직 측정에 전달되지 않는다. 전달 방식(측정 요청에 프롬프트를 담아 보내기, 또는 수집 서버가 HUB에서 받아 가기)이 정해지면 `prompt_id`와 버전을 고정해 넘긴다. 받아 가는 방식이면 수집 서버용 인증을 따로 둔다.

```powershell
python -X utf8 back/hub_storage/manage.py init           # 002_hub_login, 004_hub_prompt_editing, 편집 계정, .env.hub-edit.local
python -X utf8 back/hub_storage/manage.py set-admin      # 최상위 관리자 등록 또는 비밀번호 재설정(입력은 프롬프트로)
python -X utf8 back/hub_storage/manage.py revoke-admin   # 최상위 역할 회수
./scripts/start-gold.ps1                                 # .env.hub-edit.local 이 있으면 API에 전달
```

로그인은 사이드바 계정 영역의 로그인 아이콘이나 `/ko/login`에서 한다. API: `POST /v1/auth/login`, `GET /v1/auth/me`, `GET|POST /v1/hub/global-prompts`, `GET /v1/hub/global-prompts/options`, `GET|PUT /v1/hub/global-prompts/{id}`, `POST /v1/hub/global-prompts/{id}/archive|restore`. 브라우저는 BFF를 직접 부르지 않고 Next의 `/api/hub/*`를 거친다. 로컬 모드에서 GET이 아닌 요청이 통과하는 곳은 여기뿐이다.

## 외부 조회 경계

`hmg_data_external` 계정은 `published` 스키마의 SELECT만 가능하다. 내부 카탈로그, GA4·SEO 원본 테이블, 공개 정책, 운영 DB에는 접근할 수 없다. 모든 프로젝트는 기본 비공개다. 외부 네트워크 공개나 계정 전달은 하지 않았다.

관리자는 데이터 DB에서 `publication.project_access`의 `projects`, `prompts`, `ga4`, `seo`를 **각각** 승인한다. 프로젝트 승인만으로 프롬프트나 측정 데이터가 공개되지 않는다. 승인한 범위의 최신 버전만 공개한다. 특정 소비자별 다른 범위가 필요하면 소비자별 역할/정책을 추가해야 한다. 현재 계정은 하나의 공통 승인 범위를 위한 계정이다.

GA4와 프로젝트의 관계는 `catalog.project_ga4_property`에 실제 연동이 확인된 경우에만 등록한다. 자동 추측하지 않는다. GA4와 SEO에는 아직 수집된 실측 행이 없으므로 공개 뷰도 비어 있다. GA4 `users_day`는 기간 합산하지 않고 정확한 기간 사용자는 `ga4_users_window`를 사용한다. SEO 공개 뷰는 검증 후 발행된 빌드만 사용한다.

내부 API `GET /v1/hub/projects`, `/v1/hub/prompts`는 HUB 카탈로그 조회 계약이다(`limit=1..1000`, `offset>=0`, 선택적 `project_id=UUID`). 로컬 서비스용이며 외부 공개 정책을 적용하는 엔드포인트는 아니다. 외부 소비자는 `published.*` 뷰를 사용한다. 기존 BFF `/v1/screens/*`와 Gold 조회 계약은 보존한다. 현재 GEO 화면의 측정 및 원천 카탈로그는 계속 Gold에서 읽는다.

`/healthz`는 Gold, 데이터 DB(`analytics`), 운영 DB(`operations`)의 실제 연결과 읽기 전용 여부를 보여준다. Next는 DB 자격 증명을 받지 않고 FastAPI만 호출한다.

## 검증

`verify`는 롤백되는 트랜잭션에서 비공개/선택 공개, 외부 계정의 기본 테이블 접근 차단, 버전 불변성, 운영 설정 이력·감사 이력 보존, 잘못된 참조 차단을 확인한다. API 통합 검증은 `back/bff/tests/test_hub_storage.py`를 사용한다. 영구 테스트 사용자나 가상 측정치를 생성하지 않는다.

마이그레이션: 데이터 DB `002_data_catalog_publication`, `003_published_dimensions`, `004_hub_prompt_editing`, 운영 DB `001_operations`, `002_hub_login`. 기존 데이터 DB `001_gold_ga4_seo`는 변경하지 않았다.
