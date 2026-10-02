# projects.prompts.io · 프로젝트 / 프로젝트 프롬프트 / 가져오기·내보내기

설계 단위: PJ-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/projects/{project_id}/prompts/export` | low |
| POST | `/v1/projects/{project_id}/prompts/import` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/prompt`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- export(member): xlsx 바이너리(봉투 없음), 열 = id·text·보관 안 된 태그. 접근 감사 download. 무시 필터는 X-HGH-Ignored-Filters 헤더.
- import(Owner): multipart/form-data 의 file(현행 FormData) 또는 xlsx 본문(하위 호환). 권한 판정 뒤 `core.upload.read_upload_request` 로 읽는다. 5MB(413)·데이터 5,000행·200열 상한(422). xlsx 는 공용 스트리밍 파서 `app.core.xlsx` 로 읽고 이 기능의 예산(`xlsx.budget`: 부분 파일 16MB·셀 4,001자·공유 문자열 (행+1)×200개·공유/누적 문자 1,600만·XML 원소 200만·경고 200건 64KB)을 파싱 중에 적용한다(검증 D3·D3-R). 공유 문자열은 한 번만 정규화해 셀이 참조하고, 경고 속 원문은 40자로 자른다. 파싱은 스레드 풀에서 돌며, 조각(64KB)마다 GIL 을 놓아 이벤트 루프가 멈추지 않는다: 5,000행×20열 정상 파일 파싱 중 5ms 티커 최대 간격 11ms, 증폭 폭탄들 6ms(테스트가 100ms 미만을 단언). 태그 헤더·값은 fields API 규칙(이름 100자·값 500자·제어 문자 금지·대소문자 무시 매칭, 보관 포함)을 따르고 위반은 경고 후 건너뜀(검증 D5). 현행 importPromptsXlsx 규칙 그대로(한 트랜잭션·배치 문장).
- 6라운드 처분(pj-prompts §1): multipart = python-multipart(`core.upload`), xlsx 읽기 = `core.xlsx.XlsxReader`(이 기능 예산), 쓰기 = `core.xlsx.write_workbook(SheetSpec)`(열 너비 38·60·18 유지, 빈 값 셀은 쓰지 않는다). openpyxl 은 들이지 않는다(메인 결정).
- 테스트 수집 충돌(표준 라이브러리 io 와 `io.tests` 이름 충돌, 요청 §5): 처분: 우회 유지(메인 2026-09-28, import-mode 변경 없음). app/ 부터 tests/ 까지 `__init__.py` 로 이어져 모듈 이름이 `app.features...` 로 잡히고, 테스트 파일 이름을 `test_prompts_io.py` 로 유일하게 두며 conftest 대신 env 픽스처를 직접 가져온다.
