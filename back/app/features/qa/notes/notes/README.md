# qa.notes.notes · 검수 콘솔 / 노트 / 노트 작성·조회·내보내기

설계 단위: QA-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/qa/answers/{job_id}/notes` | low |
| POST | `/v1/qa/answers/{job_id}/notes` | low |
| GET | `/v1/qa/notes` | low |
| GET | `/v1/qa/notes/counts` | low |
| GET | `/v1/qa/notes/export` | low |
| PATCH | `/v1/qa/notes/{note_id}` | low |
| DELETE | `/v1/qa/notes/{note_id}` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/raw-data-qa/answers/[jobId]`
- `/raw-data-qa/notes`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 인증: 검수 게이트(Q17). 작성자 = 쿠키 세션 이름. 본문·severity 수정과 삭제는 작성자만(403 not_author), resolved 토글은 누구나(resolved_by 기록).
- export: core.export CSV(BOM + CRLF, 수식 주입 방지 접두 작은따옴표, Cache-Control no-store), 상한 10,000행(X-Row-Count, 넘으면
  잘라서 `X-Export-Truncated: true`). 봉투가 없으므로 목록 meta 를 헤더로 알린다: `X-Ignored-Filters`(쉼표 목록),
  `X-Dropped-Filters`·`X-Suppressed`(ASCII JSON 객체, 있을 때만).
- 접근 감사(Q4): export 성공마다 core.write.access_audit_qa(kind download, action qa.notes.export, detail rows·truncated).
  actor_id = 검수 세션 id, actor_role = 'vendor'(외부 검수자), detail.actor_kind = 'qa_reviewer'·reviewer_name.
- 목록 정렬 (created_at DESC, note_id DESC) 와 qa_note_cursor_idx(note_id ASC)의 방향 차이는 소량이라 보류(메인 결정, qa R5).
