# HMG-GEO-HUB

AI 답변에 현대 · 기아 · 제네시스가 어떻게 언급되고 인용되는지 보여 주는 서비스입니다. 프로젝트 규칙의 기준은 [CLAUDE.md](CLAUDE.md), 구조와 ERD의 기준은 [docs/architecture/hmg-geo-hub-architecture.html](docs/architecture/hmg-geo-hub-architecture.html)입니다. 정의가 다르면 상위 폴더 `hmg-geo-hub-ssot`를 따릅니다.

## 구조

호출은 한 방향입니다: 브라우저 → Next → 허브 서버 → 데이터 서버 → DB.

| 경로 | 포트 | 하는 일 |
|---|---|---|
| `front/` | 3333 | 화면(Next.js). 레거시 `(dash)`와 리뉴얼 `(renewal)` |
| `front-react/` | 3334 | Next를 대체할 React 준비본. 기본은 미연결([docs/handoff/react-standby.md](docs/handoff/react-standby.md)) |
| `back/hub_server/` | 5556 | 서비스의 입구. 로그인 · 계정 재확인 · 계정 · 저장 필터 · 입력 편집, 브라우저 계약 `/api/*` |
| `back/data_server/` | 5555 | 내부 서버. 화면 조립 · 지표 계산(`metrics/`) · 조회용 테이블 적재 잡 |
| `back/shared/` | | 두 서버가 함께 쓰는 코드 |
| `back/ext/` | 5560 | 수집 · 분석이 읽는 프롬프트·기준정보 API |
| `back/analytics/` | | GA4 · SEO 스키마와 수집기 |
| `back/hub_storage/` | | DB 마이그레이션과 관리 명령 `manage.py`([README](back/hub_storage/README.md)) |

| DB | 포트 | 내용 |
|---|---|---|
| `input_db` | 55438 | 프롬프트 · 측정 설정 · 기준정보 · GA4 속성 |
| `operations_db` | 55437 | 계정 · 권한 · 저장 필터 · 감사 이력. 허브 서버만 접속 |
| `gold_db` | 55439 | 조회용 테이블 · 사전 집계 · GA4 · SEO. 허브 서버는 접속하지 않음 |
| `cache_db` | 55439 | 필터 조회 결과. 정본이 아님 |

답변 데이터의 원천은 파이프라인의 Silver OBT이고, 데이터 서버가 운영 스냅샷만 읽어 `gold_db`에 적재합니다. 접속 정보를 받기 전까지 맥에서는 가상 OBT `geohub_silver_db`가 대신합니다.

## 실행

macOS는 Docker 없이 네이티브로 돌립니다. Python은 `back/data_server/requirements.txt`가 설치된 3.12입니다.

```sh
HGH_PYTHON=<python> bash scripts/start-hub-storage.sh   # 처음 한 번: DB 구성
HGH_PYTHON=<python> bash scripts/start-local.sh         # 이후: 서버 시작, 재계산은 백그라운드
```

`http://127.0.0.1:3333/ko/renewal/dashboard`로 들어갑니다. 모든 화면은 로그인이 필요합니다(`HGH_HUB_NATIVE=1 <python> back/hub_storage/manage.py set-admin`). 키 · 비밀번호는 git에서 제외된 `.env.*.local`에만 둡니다.

## 테스트

```sh
cd back && <python> -X utf8 -m unittest data_server.tests.test_metrics   # 모듈 하나씩, 서버 없이 돈다
cd front && npm run typecheck && npx vitest run
```

## 지운 코드

이전 재설계(`back/app` · `ingest` · `db` · `migration`과 그 시험, `ci/github-workflows/back-ci.yml`)와 Gold 가져오기는 2026-11-07에 지웠습니다(T12). 레거시 규칙을 찾을 때는 커밋 `d77f278`에서 봅니다(`git show d77f278:back/ingest/project/apply/queries.py`). 코드 주석에 남은 그 경로는 이 커밋 기준입니다. 이전 README의 스냅샷 기록도 같은 커밋에 있습니다.
