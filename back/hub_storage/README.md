# HUB 운영 DB / 데이터 DB 분리

두 개의 독립 PostgreSQL 컨테이너·볼륨·계정을 사용한다. 외부 Gold에는 쓰지 않는다.

[분리 ERD](ERD.md) · [현재 서비스 아키텍처](../../docs/architecture/hmg-geo-hub-current.png)

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

시작 스크립트는 기존 analytics 마이그레이션을 확인하고 새 DB/증분 마이그레이션을 적용한 뒤 API를 재시작한다. 실제 Gold 프로젝트·프롬프트만 가져온다. 기존 Next 프로세스는 유지한다. 반복 실행은 변경 없는 정의에 새 버전을 만들지 않는다. 적용된 SQL의 체크섬이 바뀌면 중단하므로 변경은 새 마이그레이션으로 추가한다.

로컬 비밀 파일은 git에서 제외하고 Windows에서는 현재 사용자와 SYSTEM에만 ACL을 부여한다. API에는 각 DB의 **조회 계정만** 전달한다. 카탈로그 쓰기 계정과 운영 쓰기 계정은 관리 명령이 일시적으로 사용하며 Next나 API 이미지에 넣지 않는다. 초기화 전 기존 데이터 DB 백업을 만들었으며, 이후 두 DB 백업은 위 명령으로 실행한다. 백업 복원 시 두 DB와 비밀 파일을 함께 복원하고 프로젝트 참조를 검사한다.

## 프로젝트·프롬프트의 기준

- `catalog.project` / `catalog.prompt`: 삭제되지 않는 UUID, 원천(`gold` 또는 `hub`), 원천 UUID.
- `catalog.*_version`: 정의가 달라질 때 추가되는 버전. 서비스 계정은 수정·삭제할 수 없다. `current_*` 뷰는 최신 버전을 읽는다.
- Gold 가져오기는 현재 원천 정의의 버전 기록이다. Gold 측정 사실 전체를 복제하지 않는다. 원천에 없는 프로젝트 이름은 `null`이다. `registered_at`, `recorded_at`은 HUB 등록/관측 시각이며 원천 생성 시각이 아니다.
- `origin=gold`는 Gold 동기화가 관리한다. `origin=hub` 정의는 가져오기가 덮어쓰지 않는다. HUB 편집 기능과 Gold 측정 파이프라인으로의 전달은 별도 구현 대상이다. 현재 쓰기 UI는 열지 않았다.
- 운영 DB는 `system.project_reference`에 **같은 UUID만** 보관한다. 관리 명령이 데이터 DB 존재를 확인한 뒤 등록한다. 데이터 커밋 후 운영 등록이 실패해도 재실행으로 복구된다. 두 DB 사이 FK나 원자적 트랜잭션은 없다.
- 향후 프로젝트 생성/설정 변경 서비스도 이 검증·등록 경로를 사용해야 한다. 프로젝트 제거는 새 정의의 보관 상태로 처리하고 정체성 행을 지우지 않는다. 설정·측정 실행은 프롬프트 버전과 설정 버전을 고정해서 기록해야 한다. 기존 Gold 측정에는 과거 HUB 버전 대응을 임의로 붙이지 않는다.
- `system.integration.credential_ref`에는 비밀 저장소 참조만 보관한다. 실제 키·토큰은 설정 JSON에 저장하지 않는다. 사용자/설정/권한에는 가상 초기 행을 넣지 않았다. 로그인 없는 로컬 조회 모드를 유지한다.

## 외부 조회 경계

`hmg_data_external` 계정은 `published` 스키마의 SELECT만 가능하다. 내부 카탈로그, GA4·SEO 원본 테이블, 공개 정책, 운영 DB에는 접근할 수 없다. 모든 프로젝트는 기본 비공개다. 외부 네트워크 공개나 계정 전달은 하지 않았다.

관리자는 데이터 DB에서 `publication.project_access`의 `projects`, `prompts`, `ga4`, `seo`를 **각각** 승인한다. 프로젝트 승인만으로 프롬프트나 측정 데이터가 공개되지 않는다. 승인한 범위의 최신 버전만 공개한다. 특정 소비자별 다른 범위가 필요하면 소비자별 역할/정책을 추가해야 한다. 현재 계정은 하나의 공통 승인 범위를 위한 계정이다.

GA4와 프로젝트의 관계는 `catalog.project_ga4_property`에 실제 연동이 확인된 경우에만 등록한다. 자동 추측하지 않는다. GA4와 SEO에는 아직 수집된 실측 행이 없으므로 공개 뷰도 비어 있다. GA4 `users_day`는 기간 합산하지 않고 정확한 기간 사용자는 `ga4_users_window`를 사용한다. SEO 공개 뷰는 검증 후 발행된 빌드만 사용한다.

내부 API `GET /v1/hub/projects`, `/v1/hub/prompts`는 HUB 카탈로그 조회 계약이다(`limit=1..1000`, `offset>=0`, 선택적 `project_id=UUID`). 로컬 서비스용이며 외부 공개 정책을 적용하는 엔드포인트는 아니다. 외부 소비자는 `published.*` 뷰를 사용한다. 기존 BFF `/v1/screens/*`와 Gold 조회 계약은 보존한다. 현재 GEO 화면의 측정 및 원천 카탈로그는 계속 Gold에서 읽는다.

`/healthz`는 Gold, 데이터 DB(`analytics`), 운영 DB(`operations`)의 실제 연결과 읽기 전용 여부를 보여준다. Next는 DB 자격 증명을 받지 않고 FastAPI만 호출한다.

## 검증

`verify`는 롤백되는 트랜잭션에서 비공개/선택 공개, 외부 계정의 기본 테이블 접근 차단, 버전 불변성, 운영 설정 이력·감사 이력 보존, 잘못된 참조 차단을 확인한다. API 통합 검증은 `back/bff/tests/test_hub_storage.py`를 사용한다. 영구 테스트 사용자나 가상 측정치를 생성하지 않는다.

마이그레이션: 데이터 DB `002_data_catalog_publication`, `003_published_dimensions`, 운영 DB `001_operations`. 기존 데이터 DB `001_gold_ga4_seo`는 변경하지 않았다.
