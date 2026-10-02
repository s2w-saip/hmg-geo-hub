# admin.catalog.bulk · 운영 관리 / 표준 카탈로그 / 일괄 편집·가져오기·내보내기

설계 단위: AD-1 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| POST | `/v1/admin/catalog/prompts/bulk/regions` | low |
| POST | `/v1/admin/catalog/prompts/import/preview` | low |
| POST | `/v1/admin/catalog/prompts/bulk/apply` | low |
| GET | `/v1/admin/catalog/prompts/export` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/admin/standards/prompts`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모(2026-09-28, ad-content)
- bulk/regions·bulk/apply: 행마다 `prompts.service.apply_patch`(상태 가드·diff·트리거 감사·outbox). 공통 batch_id 는 트랜잭션 로컬 GUC
  `app.batch_id`. 부분 성공 = 행마다 SAVEPOINT(`core.write.savepoint`). 행 검증 실패·없음·상태 불일치는 그 행만 `failed`(기능 코드),
  사전 검증을 통과했지만 DB 에서 실패한 행(검증 뒤 사라진 FK 대상·CHECK 위반 등)은 그 행만 되돌려 `failed`(코드 =
  `core.errors.from_db_error`: `constraint_violation`·`conflict`·`invalid_value`, 해당 없으면 `db_error`). 나머지 행은 반영된다.
  DB 오류가 아닌 예기치 않은 예외(코드 결함)는 요청 전체 롤백(500).
- apply 결과: applied(실제 변경)·unchanged(이미 같음)·failed·change_ids·outbox_ids. 요청당 200건.
- import/preview: multipart/form-data 의 `file`(현행 FormData) 또는 하위 호환 본문 = xlsx 원본 바이트. `core.upload.read_upload_request`
  (5MB 초과 413, 빈 파일·file 필드 없음 422 `invalid_upload`, 그 밖 Content-Type 415).
  열 계약은 현행 lib/standards/excel.ts 와 같다(kind 는 무시, 빈 text 는 경고 후 불변, id 없는 행 경고). 라벨 값(FK·CHECK)이 틀리면 그 라벨만 빼고 경고.
  라벨은 한 줄(apply 스키마 `PgLine`)이라 줄바꿈·제어 문자가 든 새 라벨 값도 경고 후 뺀다(기존 값 그대로면 조용히 뺀다: 변경 없음).
- export: xlsx(`core.xlsx` 작성기 `SheetSpec`, 첫 행 굵게·틀 고정·열 너비, `core.export.xlsx_response` 스트리밍·no-store) + 접근 감사(download).
  왕복(export → preview) diff 0 을 테스트로 단언. `xlsx.build` 는 같은 core 작성기의 시트 1장 포장(테스트·손작성용).
- preview 경고는 200건·64KB 상한(넘치면 끝에 '경고 N건 더 있음'), 경고·unmatched_ids 에 싣는 파일 원문은 자른다(40·80자).
- 깨진 파일 방어(검증 D1·D2·D2-R, 2026-09-28): 파서는 공용 스트리밍 파서 `app.core.xlsx` 이고 어떤 입력이든 `XlsxError` 하나로만
  실패한다(zip·zlib 손상, 정수 아닌 행 번호·공유 문자열 번호, DTD, UTF-8 아닌 XML). 이 기능의 예산은 `xlsx.BUDGET`: 업로드 5MB·
  읽는 부분 파일 50MB·압축비 200:1·XML 원소 300만·깊이 64·태그/텍스트 하나 1MB·행 번호 r 1..20,000(증가, 빈 행 채우기로 우회 불가)·
  열 64(밖은 버림, 같은 행 열 참조 증가)·셀 5,001자(넘으면 잘라서 위치 경고)·공유/누적 문자 2,400만·경고 200건 64KB(원문 40자).
  예전 구현은 ET.fromstring 으로 부분 파일 전체를 DOM 으로 만들고 GIL 을 쥔 채 파싱해, 작업 스레드여도 이벤트 루프가 멈췄다
  ('<c/>' 20MB 폭탄: 피크 455MB·루프 최대 간격 560ms, 정상 20,000행×20열: 455MB·441ms). 지금은 64KB 조각마다 GIL 을 놓으므로
  `anyio.to_thread.run_sync` 작업 스레드에서 도는 동안 루프가 계속 돈다(같은 파일: 7.7MB·15ms, 38MB·16ms. 5ms 티커 최대 간격 실측,
  `tests/` 가 100ms 미만을 단언). 정상 20,000행×20열 파싱 시간은 약 1초로 예전과 같다.
  읽을 수 없는·예산을 넘는 파일은 현행(excel.ts `파일을 읽을 수 없습니다`)처럼 200 + warnings 로 돌려준다(422 아님, 테스트 고정).
