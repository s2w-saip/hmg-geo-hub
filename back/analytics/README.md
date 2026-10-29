# HUB GA4·SEO 데이터베이스

이 DB는 현재 HUB **데이터 DB** 역할을 맡으며 프로젝트·프롬프트 버전도 별도 `catalog` 스키마에서 관리합니다.
사용자·권한·SW 설정은 별도 `hmg_operations` DB에 있습니다. 최신 구성·통합 시작 명령은 [DB 분리 안내](../hub_storage/README.md)를 참고하십시오.

Gold ERD의 `07_ga4.js`, `08_vis.js`와 실제 Gold PostgreSQL 컬럼·PK를 대조해 추출한 별도 저장소입니다.
현재 3333 서비스가 실행 중인 HUB 호스트의 PostgreSQL 컨테이너에서 관리합니다.
외부 Gold의 테이블·데이터·릴리스는 수정하지 않았습니다. GA4·SEO 사실을 복제하는 FDW나 자동 동기화 작업은 없습니다.
프로젝트·프롬프트 정의와 외부 API용 기준값은 별도의 명시적 카탈로그 가져오기 명령과, 최상위 관리자의 글로벌 프롬프트 편집([HUB 저장소 안내](../hub_storage/README.md))으로만 버전 기록합니다.

| 구분 | 구성 |
| --- | --- |
| DB | `hmg_analytics` / PostgreSQL 17 |
| 컨테이너 | `hgh-analytics-db` |
| 호스트 접속 | `127.0.0.1:55436` |
| 컨테이너 간 접속 | `hgh-analytics-network` → `hgh-analytics-db:5432` |
| 영구 볼륨 | `hgh-analytics-pgdata` |
| 조회 계정 | `hmg_analytics_reader` / 읽기 전용, DDL·DML 불가 |
| 적재 계정 | `hmg_analytics_writer` / 허용 테이블 DML·SEO 발행 함수, DDL 불가 |
| 소유 계정 | `hmg_analytics_owner` / 로그인 불가 |

## 분리한 데이터

핵심 테이블은 원본 이름과 64개 컬럼·타입·NULL 허용 여부·9개 복합 PK를 유지합니다.

| 원본 ERD | 새 테이블 | 내용 |
| --- | --- | --- |
| GA4 | `analytics.ga4_property` | 속성·브랜드·국가·전환 기준 |
| GA4 | `analytics.ga4_value` | 채널·소스·기기·방문자 유형·페이지·이벤트 사전 |
| GA4 | `analytics.ga4_row` | 보고서 5종의 일별 측정 행 |
| GA4 | `analytics.ga4_users_window` | 기간·코호트·필터별 중복 제거 사용자 수 |
| SEO/AI Visibility | `analytics.dim_crawl_bot` | AI 크롤러와 엔진 연결 |
| SEO/AI Visibility | `analytics.page_visibility_daily` | 페이지별 검색 노출·AI 크롤 합계 |
| SEO/AI Visibility | `analytics.page_crawl_daily` | 봇별 일별 크롤 수 |
| SEO/AI Visibility | `analytics.page_seo_device_daily` | 기기별 검색 노출 수 |
| SEO/AI Visibility | `analytics.page_priority` | 페이지 우선순위와 산정 버전 |

참조 무결성을 위해 `ref`에 국가·대륙·엔진·프로젝트/사이트·브랜드·출처 분류·출처·자사 URL 기준·URL의 9개 차원만 포함했습니다.
원본의 답변·프롬프트·인용 사실·ACR·키워드·소셜 테이블은 포함하지 않았습니다.
여기서 SEO는 `08_vis`의 GSC 검색 노출과 AI 크롤 계열입니다. `09_kw`의 DataForSEO 키워드·SERP 계열은 이번 범위에 포함하지 않았습니다.

`ops`의 4개 테이블은 이 DB의 빌드·현재 SEO 공개 포인터·데이터 변경 버전·마이그레이션 기록입니다.
전체는 핵심 9개 + 공통 차원 9개 + 운영 메타데이터 4개 = 22개 테이블이며, 별도로 현재 SEO 조회 뷰 4개가 있습니다.

## 원본과 달라진 운영 부분

- 새 키는 이 DB에서 identity로 발급합니다. 원본 키를 명시해 등록할 수도 있지만, 다른 DB와 **정수 키만으로 조인하지 않습니다**. 국가/엔진 코드, 프로젝트 UUID, `url_norm`으로 매핑합니다.
- 원본 ERD의 논리 관계를 실제 FK로 적용했습니다. `ga4_value`는 `(kind,value_key)`가 PK이므로, 관련 테이블에 읽기 전용 generated `*_kind` 열 8개를 더해 기기 키와 이벤트 키가 섞이지 않게 했습니다.
- 음수 측정값, 잘못된 보고서·코호트·전환 기준을 거부합니다. NULL은 원천의 미제공 상태로 유지하며 0으로 채우지 않습니다.
- GA4는 자연키로 upsert하고 `ops.data_version`을 같은 트랜잭션에서 증가시킵니다. `users_day`는 날짜·차원 간 합산하지 않고 기간 사용자는 `ga4_users_window`의 정확한 측정값을 씁니다.
- SEO는 HUB 자체 `ops.build`로 관리합니다. `running` 빌드에만 측정 행을 쓸 수 있고, 검증 완료 빌드는 수정할 수 없습니다. 수정 시 새 빌드를 만듭니다.
- 공개는 `ops.publish_seo_build(project_key,date,build_id,expected_previous_build_id)`로 처리합니다. 봇별 크롤 합·기기별 노출 합과 부모 합계가 일치해야 하며, 이전 포인터가 바뀌었으면 발행을 거부합니다. 최초 발행의 이전 빌드는 `NULL`입니다.
- 화면 조회에는 `analytics.current_page_*` 뷰를 사용해 과거 빌드가 중복 합산되지 않게 합니다.

## 시작·검증

저장소 루트에서 실행합니다.

```powershell
powershell -File scripts/start-analytics.ps1
python -X utf8 back/analytics/manage.py status
```

초기화는 같은 SQL 체크섬이면 재적용하지 않으며, 기존 행과 비밀번호를 유지합니다.
설치된 마이그레이션과 SQL이 다르면 자동 덮어쓰기를 거부하므로 변경은 후속 마이그레이션으로 관리합니다.
첫 시작 이후에는 Docker 재시작 시 자동으로 실행됩니다. 컨테이너를 재생성해도 명명된 볼륨에 데이터가 남습니다.

자격증명은 무작위 생성 후 현재 Windows 사용자·SYSTEM만 접근할 수 있도록 다음 git 제외 파일에 보관합니다.

| 파일 | 용도 |
| --- | --- |
| `.env.analytics-db.local` | DB 관리자와 reader/writer의 초기 자격증명·호스트 포트 |
| `.env.analytics.local` | 내부 Docker 네트워크의 서버용 조회 URL (`HGH_ANALYTICS_DB_URL`) |
| `.env.analytics-ingest.local` | HUB 호스트에서 실행할 수집기용 적재 URL (`HGH_ANALYTICS_WRITER_DB_URL`) |

DB 접속 정보는 프런트의 `NEXT_PUBLIC_*`에 넣지 않습니다. `scripts/start-gold.ps1`이 API 컨테이너를 같은 Docker 네트워크에 연결하고 조회 URL만 전달합니다. writer·관리자 자격증명은 서비스에 전달하지 않습니다.

## 데이터 수집과 화면 전환

표준·웹사이트·프로젝트의 GA4 전환과 SEO 화면은 이 DB를 조회합니다. API는 `/v1/analytics/conversion`, `/v1/analytics/visibility`이며, 조회 코드는 `back/bff/hub_stores/analytics_reader.py`입니다.
Gold의 GA4/SEO 측정값을 복사하거나 가상 계정·샘플 데이터를 적재하지 않았습니다.

### GA4 수집기 (`ga4_collect.py`, 2026-10-29)

GA4 Data API(runReport)를 직접 읽어 `analytics.ga4_*`에 저장합니다. 화면(BFF)과 브라우저는 GA4를 부르지 않고 저장된 행만 읽습니다.
GA4 자격 증명을 인계받기 전이라 아직 실행하지 않았고, 지금은 속성 행도 측정 행도 없습니다(화면은 `연결된 GA4 속성이 없습니다`).

| 항목 | 내용 |
| --- | --- |
| 실행 | 저장소 루트에서 `python -X utf8 back/analytics/ga4_collect.py` — 최근 3일(속성 시간대의 어제까지)을 다시 받아 바꿔 씁니다. 처음은 `--backfill 180`, GA4만 읽고 쓰지 않으려면 `--dry-run`, 기간 지정은 `--from`·`--to`, 속성 하나만은 `--property` |
| 주기 | 하루 한 번. GA4 값은 며칠 동안 확정되므로 매번 최근 3일을 다시 받습니다 |
| VM (taeho-dev) | production · dev build가 HUB 데이터 DB 하나를 같이 써서 수집도 하나입니다. 정기 실행은 cron `15 9 * * * bash /home/taeho/hmg-geo-hub/scripts/vm.sh ga4-cron >>/home/taeho/hmg-geo-hub/.local/vm-cron.log 2>&1`(09:15 UTC — 모든 시간대의 어제가 끝난 뒤, 로그에 속성별 한 줄), 수동 실행은 `bash scripts/vm.sh ga4 --dry-run` · `bash scripts/vm.sh ga4 --backfill 180`처럼 수집기 인자를 그대로 넘깁니다. BFF 이미지(`hgh-gold-api:local`)의 일회용 컨테이너가 호스트 네트워크에서 돕니다. 서비스 계정 키는 이미지에 `google-auth`가 없어 아직 쓸 수 없습니다 |
| 쓰기 계정 | `.env.analytics-ingest.local`의 `HGH_ANALYTICS_WRITER_DB_URL` (`hmg_analytics_writer`). 한 번에 하나만 실행됩니다(advisory lock) |
| GA4 자격 증명 | `.env.ga4.local`: OAuth `GA4_OAUTH_CLIENT_ID`·`GA4_OAUTH_CLIENT_SECRET`·`GA4_OAUTH_REFRESH_TOKEN`(예전 웹과 같은 이름), 또는 서비스 계정 `GA4_SERVICE_ACCOUNT_FILE`(JSON 키 경로, 서명에 `google-auth` 패키지 필요). 범위는 `analytics.readonly` |
| 속성 목록 | `.local/ga4-properties.json` (`HGH_GA4_PROPERTIES`로 바꿈, 형식은 `ga4-properties.example.json`): 속성 ID · 브랜드 · 국가 · 전환 기준(`key_events` = GA4 주요 이벤트, `events` = 적은 이벤트만) · `status: unmapped`(등록만, 수집 안 함) |
| 속성 상태 | 수집하면 `active`, GA4가 거부(403)하면 `pending_grant`로 두고 그 속성의 기존 행은 그대로 둡니다 |

저장하는 것(속성 · 날짜마다, 모든 보고서에 기기 · 신규/재방문을 둬 화면 필터가 똑같이 걸립니다):

| report | 내용 |
| --- | --- |
| 1 traffic_total | 채널 그룹별 세션 · 사용자(일) · 주요 이벤트 · 조회 (`is_ai` = AI Assistant 채널) |
| 2 traffic_ai | AI Assistant 세션을 `sessionSource`별로(→ 엔진: chatgpt · gemini · perplexity · claude · copilot, 그 밖은 엔진 없음) |
| 3 events | 이벤트별 발생 수 · 주요 이벤트. AI는 `sessionSource`별, 그 밖은 비AI 채널 합. `is_conv` = 전환 기준의 이벤트 |
| 4 landing | AI 입구 페이지(`sessionSource`별)와, 마지막 적재일까지 90일 안에 AI 유입이 있었던 페이지의 비AI 세션(같은 페이지 기준) |
| 5 totals | 전체 세션 · 조회 |
| `ga4_users_window` | GA4가 중복을 뺀 사용자 수: 코호트 ai · general · total을 날마다, 그리고 마지막 적재일과 그 직전 같은 길이 기간의 끝에서 7 · 28 · 90일. 필터 조합(마스크)은 아직 없음 |

수집한 날은 일별 `total` 창이 사용자 0명이라도 남습니다. 리더는 그 날에 행이 없는 값을 0으로 읽습니다(GA4는 모두 0인 행을 보내지 않음). 수집하지 않은 날은 `null`입니다.
시험: `bff.tests.test_ga4_collect` — GA4 Data API 모사기로 수집한 행을 실제 리더에 넣어, 화면 숫자가 세션 원자료에서 직접 센 값과 같은지 봅니다. `HGH_GA4_TEST_DB_URL`(버려도 되는 DB)을 주면 PostgreSQL에 쓰고 리더 SQL로 다시 읽습니다.

GSC와 서버 크롤 로그(SEO) 수집기는 아직 없습니다.
프로젝트 매핑은 로컬 참조의 UUID와 국가·브랜드로 해석합니다. 원격 Gold의 정수 키를 이 DB의 키로 사용하지 않습니다.
엔진·기기·방문자 필터 비트의 정의가 제공되지 않았으므로 정확한 기간 사용자 수는 필터 없음(마스크 0) 창만 읽고, 해석할 수 없는 조합은 null입니다.
SEO는 현재 게시 뷰만 조회하며, 기기 필터는 검색 노출, 엔진 필터는 크롤링 수에 각각 적용합니다.

## 검증 및 백업

```powershell
python -X utf8 back/analytics/manage.py verify
python -X utf8 back/analytics/manage.py backup
```

검증은 실제 PostgreSQL에서 컬럼·PK 일치, reader의 쓰기 거부, writer의 DDL 거부,
GA4 사전의 종류별 FK, SEO 합계 검증·빌드 불변성·이전 포인터 검사·중복 없는 현재 뷰를 확인합니다.
검증용 행은 한 트랜잭션에서 롤백하며 앱에 노출하거나 저장하지 않습니다. identity 번호는 롤백으로 되돌아가지 않으므로 중간 번호가 비는 것은 정상입니다.

백업은 `.local/analytics-backups/`에 PostgreSQL custom-format으로 생성합니다. 별도 서버 보관·정기 백업 스케줄은 아직 구성하지 않았습니다.
복원은 관리자 역할과 스키마 owner 역할을 먼저 준비한 별도 DB에서 `pg_restore`로 수행합니다. 실행 중인 DB를 자동 삭제하거나 덮어쓰는 명령은 제공하지 않습니다.

정본 SQL: [schema.sql](schema.sql), 추출기: [generate_schema.py](generate_schema.py), ERD: [구조·ERD 정본](../../docs/architecture/hmg-geo-hub-architecture.html#erd-data).
