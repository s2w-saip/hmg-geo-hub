# HMG-GEO-HUB

현재 로컬 서비스는 외부 Gold, HUB 데이터 DB, HUB 운영 DB를 읽습니다. DB 접속 계정은 서버에서만 사용하며,
`127.0.0.1:3333`에서 읽기 전용으로 실행합니다. 모든 화면은 HUB 로그인(최상위 관리자, `manage.py set-admin`)이 필요합니다.

HUB 데이터 DB `hmg_analytics`는 GA4·SEO와 프로젝트·프롬프트 버전을 관리하고,
별도 운영 DB `hmg_operations`는 사용자·권한·SW 설정·감사 이력을 관리합니다.
[운영/데이터 DB 분리와 실행 안내](back/hub_storage/README.md), [GA4·SEO 스키마·ERD](back/analytics/README.md)를 참고하십시오.
GA4·SEO 화면은 데이터 DB로 연결했고, 실제 수집기는 아직 연결하지 않았습니다.

1. `.env.gold.example`을 `.env.gold.local`로 복사하고 제공받은 실제 접속 정보를 입력합니다.
2. `front/.env.example`을 `front/.env.local`로 복사합니다. 최초 설치 시 `front`에서 `npm ci`를 실행합니다.
3. 저장소 루트에서 `powershell -File scripts/start-hub-storage.ps1`을 실행합니다. 두 HUB DB 구성·검증, API 시작, 실제 Gold 카탈로그 가져오기를 수행합니다.
4. 이후 API만 재시작하려면 `powershell -File scripts/start-gold.ps1`을 실행합니다. 각 DB의 조회 계정만 API에 전달합니다.

포트는 프론트 `3333`, API `5555`로 고정합니다. Docker 없는 macOS·Linux에서는 `HGH_PYTHON=<Python 3.12 경로> bash scripts/start-local.sh`로
Gold만 연결해 API와 프론트를 시작합니다. 이 Python에는 `back/bff/requirements.txt`가 설치되어 있어야 하며, HUB 두 DB는 연결하지 않습니다.

현재 FastAPI BFF/API는 `back/bff/`에 있습니다(화면 계층 `screens/`, 외부 Gold DB 읽기 `gold_reader/`, HUB 자체 저장소 읽기 `hub_stores/`). Gold는 `active_release`와 검증 완료된 빌드를 고정해서 조회합니다.
서비스의 DB 조회는 읽기 전용 트랜잭션입니다. 관리 명령은 별도 쓰기 계정으로 실제 카탈로그 정의와 UUID 참조를 등록합니다.
합성 DB·시드·가상 계정·측정값 생성기는 사용하지 않습니다.
시장별 현황은 기존 GeoJSON 지도에 Gold 국가별 KPI를 연결합니다. 원천에서 제공되지 않는 값은 채우지 않습니다.

| 화면·지표 | 현재 데이터 원천 | 미제공·미수집 시 표시 |
| --- | --- | --- |
| 국가별 GEO·언급·인용·답변·프롬프트·ACR | 외부 Gold의 발행된 활성 빌드 | 데이터 없음 |
| 키워드 검색량·검색 결과·관련 키워드 | Gold `kw_volume_monthly`·`kw_serp`·`kw_suggestion` | 데이터 없음 |
| 소셜 맥락·요구·조합·관계·근거 발화 | Gold의 활성 `ctx_snapshot` 및 연관 데이터 | 데이터 없음 |
| GA4 세션·기간 사용자·전환·이벤트·페이지 | HUB `hmg_analytics.analytics.ga4_*` | 현재 미수집: 데이터 없음 |
| SEO 노출·크롤러·기기·페이지 우선순위 | HUB의 게시된 `analytics.current_page_*` 뷰 | 현재 미수집: 데이터 없음 |
| 프로젝트 이름·멤버·생성 이력·생성 프롬프트 | Gold에 제공되지 않음 | 데이터 없음 |
| HUB 프로젝트·프롬프트 버전 카탈로그 | 데이터 DB `catalog.*` / 내부 `/v1/hub/*` API | 원천에 없는 이름은 null |
| 사용자·멤버십·SW 설정·감사 이력 | 운영 DB `system.*` | 실제 사용자/설정 등록 전 빈 상태 |

실측 0은 0으로 유지하고, 관측 행/필드가 없으면 null과 `데이터 없음`을 사용합니다. GA4 사용자 수는
일별 행을 더하지 않고 정확한 기간 창을 읽습니다. 서로 다른 GA4 보고서를 합산하지 않습니다.
프로젝트 화면의 키워드·소셜 코퍼스는 공통 수집 데이터이며 프로젝트별 데이터로 가장하지 않습니다.

서비스 구조와 HUB DB ERD의 정본(SSOT): [docs/architecture/hmg-geo-hub-architecture.html](docs/architecture/hmg-geo-hub-architecture.html). 구조·스키마를 바꾸면 이 문서를 함께 고칩니다.
Next.js는 화면 렌더링과 API 호출을 담당하고, FastAPI가 BFF와 데이터 조회를 담당합니다.
FastAPI는 세 DB에 독립된 읽기 전용 연결을 사용합니다. 외부 호출자에게는 별도의 외부 API(`back/ext`, 로컬 :5560)가 현재 저장된 프롬프트와 그 수집·가공에 필요한 값을 API 키별 범위로 읽기 전용 제공합니다(정본 문서 `#ext`, 운영 명령은 [HUB 저장소 안내](back/hub_storage/README.md)).

검증: `front`에서 `npm run typecheck`. API 실행 후 저장소 루트에서
`$env:HGH_GOLD_TEST_BASE_URL='http://127.0.0.1:5555'; python -X utf8 -m unittest discover -s back/bff/tests -v`.
API 계약 검사에는 개발 환경의 `jsonschema`가 필요합니다.
집계 규칙 단위 검증은 `Get-Content -Raw back/bff/tests/test_analytics.py | docker exec -i hgh-gold-api python -`로 실행합니다.

아래 내용은 이전 재설계 스냅샷의 기록입니다. 현재 로컬 서비스의 실행 방법은 위 안내를 사용합니다.

## 외부 검토용 스냅샷 기록

> 이 레포는 **2026-10-02 기준 외부 검토·자문용 스냅샷**입니다. 개발 레포의 통합 브랜치
> 리비전 `72c260a3` 트리를 단일 커밋으로 옮긴 것이며, 커밋 이력은 포함하지 않습니다.
> 열람 권한은 읽기 전용입니다.

## 검토 범위

허브는 기존 HMG GEO 대시보드(Next.js 단일 앱)의 데이터 계층을 **DB(PostgreSQL 17) / Back(FastAPI) /
Front(Next.js)** 3층으로 다시 짜는 재설계입니다. 아래를 중심으로 봐 주시면 됩니다.

| 경로 | 내용 |
| --- | --- |
| `back/app/` | 기능 모듈(라우터·스키마·서비스·쿼리·시험)과 공통 계층 `core/` |
| `back/ingest/` | 적재 워커(측정 원천 pull, 판정, 읽기 투영, 회차·큐) |
| `back/db/` | 확정 DDL 사슬(`DB-v2.N.sql` = 직전 합본 + `DB-v2.N-patch.sql`)과 스모크 |
| `back/migration/` | 현행 미러에서 새 스키마로의 이관 도구(데이터는 레포에 없음) |
| `back/CORE-REQUESTS/` | 기능 모듈이 공통 계층(`core/`)에 낸 요청과 처분 기록 |
| `docs/design/`, `docs/spec/` | 설계 계약, DB·API 결정 기록, 기능·API 명세(HTML) |
| `docs/catalog/global-renewal-catalog.html` | Global 리뉴얼 변경 정리(내부 개발·사업팀 공유) — 레거시 대비 변경점과 근거 커밋, 고객 어필 포인트·주의, 화면별 전후 캡처. 요약본 4쪽 · 상세본 10쪽 토글(`#short` · `#long`) |
| `front/` | 현행 대시보드. 화면은 유지하고 서버 데이터 함수만 back API 호출로 교체하는 중 |
| `infra/` | AWS CLI 구성 스크립트(상태·비밀 파일은 원본에도 커밋되지 않음) |
| `ANALYSIS-ENGINE-DESIGN.md` | 분석 엔진 Python 통합·분석 버전 관리 **설계 초안**(검토 중, 미구현) |
| `docs/interfaces/scope-measurement-interface-v0.1.md` | Scope 측정 연동 인터페이스 **v0.1 협의안**(측정 대상 관리·수동 측정·원문 조회 API, OpenSpec 변경안 포함) |

읽는 순서 제안: 이 문서 → 아래 원본 README → `docs/design/DESIGN-CONTRACT.md` →
`back/FEATURES.md` → `docs/design/db/DECISIONS.md` → `docs/design/api/DECISIONS-API.md` →
`front/docs/qa/qa-matrix.md`(보안 경계 QA) → `ANALYSIS-ENGINE-DESIGN.md`.

## 스냅샷에서 제외하거나 바꾼 것

공유 범위를 맞추기 위해 아래를 정리했습니다. 실행 코드에 닿는 변경은 검수 콘솔 기본 비밀번호 문자열 치환(시험도 같은 값으로
일관 치환)과 CI 참고본 경로 변경(이를 읽는 시험 1건의 경로 포함)뿐입니다.

- **제외**: 사내 운영 문서(내부 회의록·인수인계 메모·비용 산정 자료), 고객사 협업 도구 연동 스크립트,
  고객 산출물(성과 리포트·발행 템플릿)과 고객 배포용 매뉴얼 PDF, 운영 배포 워크플로, 사내 개발 도구 설정 파일.
- **CI 정의**: `ci/github-workflows/` 에 참고본으로 옮겼습니다. 이 경로는 GitHub Actions 가 읽지 않으므로
  이 레포에서는 실행되지 않으며, 러너 관련 서술만 일반 표기로 바꿨습니다.
- **이름 변경**: 개발 도구용 안내 파일은 `front/docs/development-guide.md` 로 옮겼고, 설계 노트는
  `front/docs/specs/`·`front/docs/records/` 로 옮겼습니다.
- **치환**: 담당자 실명·사내 메일·고객 담당자 메일, 클라우드 리소스 식별자(배포 도메인·인스턴스 ID·DB 프로젝트 ID),
  사내 알림 채널명, 시험용 기본 비밀번호 문자열을 일반 표기로 바꿨습니다.
- **참조만 남은 경로**: 주석의 `notes/…` 와 `internal-kb/…` 는 이 스냅샷에 포함되지 않은 내부 작업 노트·내부 문서를
  가리킵니다. 근거의 출처를 보여 주려는 표기이며, 필요하면 해당 내용을 별도로 제공하겠습니다.
- **비밀값**: 실제 접속 자격증명은 원본에도 커밋되어 있지 않습니다. 접속 정보는 실행 시 환경변수·비밀 관리 서비스에서
  읽으며, `front/.env.example` 에는 키 이름과 설명만 있습니다. 시험 코드의 비밀번호·토큰은 시험 전용 상수입니다.

## 실행·검증

- back: Python 3.12, `back/requirements-dev.lock`(해시 고정). 시험은 PostgreSQL 17 위에 `back/db/DB-v2.32.sql`
  과 합성 픽스처(`back/tests/fixtures/`)로 개발 DB 를 만든 뒤 `bash back/tests/run-areas.sh` 로 돕니다.
  로컬 개발 DB 는 `back/db/dev-db.sh` 를 참고해 주십시오.
- front: `cd front && npm ci && npm run lint && npm run typecheck && npm test`.
- 원본 레포의 CI 는 back(ruff + pytest)·front(lint·타입 검사·vitest·계약 드리프트)를 돕니다. 정의는 `ci/github-workflows/` 참고.

---

## 원본 README

hmg-geo 재설계: 성능 우회 배관(요약 사실표·캐시·게이트)을 걷어내고, **DB(RDS PostgreSQL 17) / Back(EC2 + FastAPI) / Front(Next.js)** 로 다시 짠다. 목표는 데이터가 커져도 조회 1초 이내, 필터는 모든 기능에 같은 규칙으로.

## 구조

| 경로 | 내용 |
| --- | --- |
| `front/` | 현행 hmg-geo(통합 프리뷰 `7639b9e`) 그대로. **화면·컴포넌트는 유지**하고, 화면이 부르던 서버 데이터 함수만 back API 호출로 교체한다(교체 대상 = 각 기능 README 의 "화면"과 설계 단위의 current_refs). |
| `back/app/features/<대분류>/<도메인>/<기능>/` | 최소 기능 모듈(72개). 기능마다 `router.py`·`schemas.py`·`service.py`·`queries.py`·`tests/`·`README.md`. 분류표 [`back/FEATURES.md`](back/FEATURES.md), 정본 `back/taxonomy.json` |
| `back/app/core/` | 공통 계층(필터 모델·스코프·회차 창·지표 빌더·응답 봉투·키셋·오류·DB 풀·쓰기 큐) |
| `back/app/views/` | 화면별 색인(프론트 경로 → 기능). 프론트 어댑터 작업의 기준 |
| `back/ingest/` | 적재 워커(Scope pull → 쓰기 스키마 ing → 판정·읽기 투영 rd, 회차·큐·아웃박스) |
| `back/db/` | 확정 DDL `DB-v2.20.sql`(합본 사슬: `DB-v2.10.sql`(= `DB-v2.1.sql` + `DB-v2.2-patch.sql`~`DB-v2.10-patch.sql`) 위에 `DB-v2.11-patch.sql`~`DB-v2.20-patch.sql` 을 차례로 더한 것, 각 `DB-v2.N.sql` = 직전 합본 + 그 패치. 복제본 사슬 = `back/tests/dbforward.py` PATCHES, 로컬 템플릿·CI = `DB-v2.20.sql`. ing·rd·app·ext·mig·롤), 스모크(`smoke.sql`·`smoke-v21.sql`), 로컬 개발 DB(`dev-db.sh`), RDS 전처리 |
| `back/migration/` | 현행 미러 → 새 스키마 이관 도구(읽기 전용 추출, mig_src 적재). 데이터는 레포에 없다 |
| `infra/` | AWS CLI 스크립트(`ENV=stg|prod bash up.sh`). 상태·비밀 파일은 커밋하지 않는다 |
| `docs/` | 설계(계약·DB·API·결정·분류), 명세 HTML, 조사 자료 |

## 환경과 브랜치

| 환경 | 브랜치 | 인프라(서울 ap-northeast-2, scope 계정) |
| --- | --- | --- |
| **stg** | `stg` | VPC 10.40/16, 이름 `HMG-GEO-HUB_stg_*` / `hmg-geo-hub-stg-*` |
| **prod** | `main` | VPC 10.41/16, 이름 `HMG-GEO-HUB_prod_*` / `hmg-geo-hub-prod-*` (개설 후 정지 상태) |

- 작업 흐름: 기능 브랜치 → PR → `stg`(stg 배포·검증) → PR → `main`(prod 배포).
- 경로 공통: CloudFront(캐시 끔, D8) → ALB(비밀 헤더 일치 시만 전달) → 프라이빗 EC2(FastAPI, SSM 관리) → 비공개 RDS.
- 백엔드 기동(EC2): `cd back && uvicorn app.main:app --host 0.0.0.0 --port 8000 --log-config logging.json`. 로그 형식·요청 ID(`rid=`)·
  접근 로그(`hgh.access`, uvicorn 자체 접근 로그는 끔)는 `back/logging.json` 이 정한다. `--forwarded-allow-ips='*'` 는 쓰지 않는다(`HGH_TRUSTED_PROXY_HOPS=2`).

## 결정 기록

- 기능 명세·결정 D1~D8, A1~A17: `docs/spec/functional-spec.html`, 설계 계약 `docs/design/DESIGN-CONTRACT.md`
- DB: `docs/design/db/DECISIONS.md`(G-01~G-26), 검증 `docs/design/db/DDL-VERIFY.md`
- API: `docs/design/api/DECISIONS-API.md`(Q1~Q19), 통합 설계 `docs/design/api/전체-통합.md`, 명세 HTML `docs/spec/api/`

