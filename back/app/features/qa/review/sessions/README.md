# qa.review.sessions · 검수 콘솔 / 판정 / 검수 세션

설계 단위: QA-2 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| POST | `/v1/qa/sessions` | low |
| PATCH | `/v1/qa/sessions/{session_id}` | low |
| GET | `/v1/qa/sessions/current` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/raw-data-qa`
- `/raw-data-qa/answers`
- `/raw-data-qa/answers/[jobId]`
- `/raw-data-qa/notes`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- POST 는 게이트 입장(이름 + 공유 비밀번호 HGH_QA_PASSWORD → 세션 행 + 서명 쿠키). 꺼짐 404, 비밀번호 401, 이름 422, 시도 초과 429.
- 시도 상한: 클라이언트 IP 당 분당 10회 + 전역 분당 60회. 클라이언트 IP 는 core.auth.client_ip(X-Forwarded-For 의 오른쪽에서
  core.config.trusted_proxy_hops 번째 원소 = 신뢰 프록시가 붙인 값, 기본 0 = XFF 무시·소켓 주소)다. 홉 수 환경 변수는
  `HGH_TRUSTED_PROXY_HOPS`(옛 이름 `HGH_QA_TRUSTED_PROXY_HOPS` 도 읽음), 배포(CloudFront → ALB → 앱) 값 2 는 배포 문서가 정본. 왼쪽 원소는 뷰어가 위조할 수 있다.
  IP 당 버킷 키는 core.auth.rate_key_ip(IPv6 /64 접두, 재검증 N1: /64 안 주소 회전 우회 차단, CloudFront IPv6 켜짐). IPv4·IPv4 사상 주소는
  그대로, 세션 행 ip_hash 는 원래 주소.
- **남은 위험(전역 상한 봉쇄)**: 전역 60회/분은 모든 뷰어가 공유한다. IP 여섯 개(IPv6 는 /64 여섯 개)로 채우면 그 1분 동안 정상 검수자의
  신규 입장도 429 다(발급된 세션은 영향 없음). 상한은 프로세스 메모리 버킷이고 인스턴스 간 공유 상한(qa R4)은 보류(메인 결정: 현재 EC2 1대).
  공유 저장소 상한·WAF 속도 규칙·CAPTCHA 도 R4 와 함께 보류.
- 신뢰 중계 IP(프론트 어댑터 결정 D2): 입장이 BFF(Vercel route)를 거치면 XFF 자리가 Vercel 출구 IP 라 검수자들이 한 버킷을 나눠 쓴다.
  `HGH_RELAY_SECRET`(16자 이상)을 설정하면 `X-HGH-Relay-Secret` 이 그 값과 상수 시간 비교로 같을 때만 `X-HGH-Client-IP` 를 클라이언트 IP 로
  쓴다(core.auth.relay_client_ip → client_ip). 미설정·불일치·헤더 중복·주소 형식 오류면 헤더를 무시하고 위 규칙 그대로다. BFF 는 뷰어가
  보낸 두 헤더를 지우고 자기 값을 붙여야 한다(비밀은 BFF 서버 환경 변수, 브라우저에 두지 않는다).
- GET `/v1/qa/sessions/current`(BG-45): 부작용 없는 현재 세션 조회. 쿠키 서명·만료 + 세션 행 존재(core.auth.assert_qa_session)를 확인하고
  QaSessionOut 을 돌려준다(last_seen_at 갱신 없음, Cache-Control no-store). 쿠키 없음·만료·행 삭제(로그아웃·운영 폐기)·킬 스위치 꺼짐은
  401 qa_unauthorized. 검수 게이트 레이아웃·입장 페이지가 매 렌더에 부른다(200 = 입장 상태, 401 = 게이트 폼).
- PATCH 는 본인 세션만(403 session_forbidden). 본문 없음(또는 `{"logout": false}`) = 활동 갱신, 행이 없으면 401.
  세션 행을 지우면 서버 측 폐기(이후 다른 QA 경로 읽기·쓰기 모두 401, core.auth.QaLiveConn).
- PATCH 본문 `{"logout": true}` = 로그아웃(Q17 현행 DELETE /api/qa/session 이식, qa-header 나가기 버튼): 한 트랜잭션에서 세션 행 잠금 →
  이 세션의 락 해제 → 판정·노트의 session_id 를 NULL 로 끊기 → 세션 행 삭제 + 쿠키 max-age=0(재검증 N2). 판정·노트를 남긴 세션도 로그아웃
  즉시 복사해 둔 쿠키가 읽기·쓰기 모두 401 이다(예전: 행이 남아 최대 12시간 유효). 작성자 이름(reviewer_name)·이력은 남는다.
  응답 data 는 QaLogoutOut(session_id·locks_released·session_deleted·references_detached·session_kept_reason). 세션 확인(core.auth.assert_qa_session)은
  FOR KEY SHARE 라 겹친 쓰기는 로그아웃보다 먼저 끝나 함께 끊기거나, 뒤에 와서 401 이다.
  revoked_at 열(qa R7)·전용 DELETE 엔드포인트(qa R8)는 기각(메인 결정, 이유: DDL 없이 같은 결과·경로 계약 고정). 현행(PATCH {"logout": true}) 유지.
