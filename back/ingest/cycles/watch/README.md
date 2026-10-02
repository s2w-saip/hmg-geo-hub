# ingest.cycles.watch · 적재 파이프라인(워커) / 회차·큐·아웃박스 / 감시 태스크

설계 단위: IG-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| TASK | `hmg.ingest.watch (6시간, 별도 스케줄)` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- (화면 없음: 운영·워커)

## 구현

`service.watch(now)` 점검 9종(등급 0 PASS · 1 주의 · 2 긴급), 목적지 = 알림 라우팅(live = Slack, code = 로그: 이슈 트래커 배선 전),
전송은 `AlertSink`(`ingest.common.alerts`: 주입 > HGH_ALERT_SLACK_WEBHOOK 이면 Slack > 로그):
heartbeat(pull 커서 최근 시도 60분 초과, live 2) · ingest_backlog(blocked·창 닫힌 미해소·분석 대기, live 1/2) · view_lag(원장 회차 노출 예정 + 48h 초과 미노출,
live 1/2) · publish_backlog(닫힌 뒤 6시간 넘게 미발행, code 1) · load_failures(6시간 실패 3건 이상, code 1) · queue(실패·이관, 1시간 넘은 대기, code·live 1) ·
projection_gap(동기화 S1 BE-10: 완료·비드롭 ing.answer 인데 rd.answer 없음, 적재 뒤 1시간 초과, live 1/2 = 현행 #327 감시 ④ 등급, 자동 채움 =
판정 입력 큐 'scope_prompt' 재투영 요청 1건·예상 5,000 답변 상한·같은 출처 대기 중이면 겹쳐 넣지 않음. 판정식·근거는 service.py 머리 주석) ·
publish_gate(발행 게이트 DB-v2.14: 닫혔는데 blocked 인 회차 → 회차별 빠진 유닛 수·엔진×국가 분포·표본 10개 + 운영자 선택지(재측정·봉인·강제 발행),
live 글로벌 포함 2 · 웹사이트만 1, 회차당 1회 = ing.cycle_gate.alerted_at, quiet(이관 당시 닫힌 이관 회차) 제외. publish_backlog 는 게이트 blocked·quiet 를,
view_lag 는 quiet 를 뺀다) ·
review_fill(엔티티 버전 관리 E8, 제품 결정 28: 새 엔티티(rd.dim_entity 최근 첫 관측·아직 미분류)·기존 엔티티의 새 표면(ing.mention.surfaces
최근 관측·아직 app.ecat_surface_def 에 없음)을 app.ecat_review 에 upsert. 자사(app.brand is_hmg_own·canonical_entity_id ∪ app.entity_alias)
또는 감시 창 언급 50행 이상이면 live 1(9/20 Hyundai 표면 `N` 22,714턴 반사실). 재알림 억제는 다른 점검과 달리 **행 단위**
(app.ecat_review.alerted_at, 카운트는 계속 누적해도 한 번 울린 표면은 재경보 없음). 새 엔티티는 경보 없이 큐만(E6 관리 화면이 검토 대상으로
보여준다)).
워커와 다른 스케줄(`python -m ingest.cli watch`, 6시간)이라 워커가 죽어도 돈다(현행 cycle-chain-watch route.ts:21-27 전례). 스케줄 자체가 스로틀(상태 표 없음),
한 실행에 점검마다 경보 1건. 판정 불가(문장 오류)는 경보 없이 보고(info)에만. 돌릴 점검 = HGH_WATCH_CHECKS(빈 값 = 전부), 자동 채움 끄기 = HGH_WATCH_FILL=0.

## 테스트

- `tests/test_watch.py`: 조건 6종 발화·등급·목적지·경보 수(등급이 싱크까지), 정상 상태 무경보.
- `tests/test_projection_gap.py`: 순수 판정(등급 격자·묶음·가장 오래된 회차)·채움 계획(상한·순서·건너뜀), 일회 DB: 공백 없음(running·드롭 경계),
  글로벌·웹사이트 공백 → 긴급 1건·요청 1건·다음 실행 겹침 없음·큐 처리 뒤 rd.answer 원상(행 대조)·무경보, 유예 경계(59분·60분·61분·24시간),
  채움 끔·판정 불가 무경보, 점검 선택.
- `tests/test_publish_gate_watch.py`(일회 DB): 틱이 닫은 회차 2개 blocked → 알림 1건(긴급, 빠진 유닛 분포·표본)·발행 대기와 겹침 없음 → 두 번째 실행 무알림 →
  큐 force_publish(사유 없음 failed·있음 발행, 감사 열) · seal(pass 인데 분석 비율 미달이라 미발행) · project 는 닫히자 발행.
- `tests/test_alert_sink.py`: Slack 페이로드(등급 색·이스케이프·자르기), code 미발송, 실패 격리·로그에 웹훅 없음, 설정 선택(형식 검사), 설정 비노출. 실제 발송 없음.
- `tests/test_review_fill.py`(일회 DB): 강제 픽스처 3종(새 엔티티·비자사 저볼륨 새 표면·자사 새 표면 60행) → 큐 upsert 전부·등급 1 경보는
  자사 표면 1건만 가짜 전송기(MemoryAlertSink)에 도달 → 재실행은 카운트만 누적, 재알림 없음(행 단위 alerted_at). 정상 상태 무경보.
  `merge_surface_candidates` 순수 함수 단위시험(대소문자만 다른 원문 두 표면이 정규형 하나로 합쳐짐).
