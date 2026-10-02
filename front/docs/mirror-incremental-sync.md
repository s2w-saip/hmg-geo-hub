# 미러 싱크 증분 읽기 · 하루 1회 전체 대조

2026-09-28. `/api/cron/sync-mirror`(20분, 예산 250s)가 루트 프로젝트에서 멈춘 문제의 수정과 운영 절차.

## 문제

루트 프로젝트 `be28fe15…`는 prompts 약 12,446개, measurement run 약 8,681개다. 크론은 매 틱 `listPrompts`와 `listMeasurementRuns`를 **처음부터** 읽었다. 둘 다 페이지 상한이 50(5,000건)이다. 2026-09-27 17:20Z 이후 루트의 모든 시도는 `PAGE CAP HIT — prompts` 다음 `Scope read deadline exceeded` 또는 `budget stop inside project read`로 끝났고, 쓰기 단계까지 가지 못했다. 그래서 루트의 신규 run(재측정·다음 회차)이 크론으로 들어오지 않았다.

## 동작

저장 위치는 `scope_sync_watermarks`(마이그레이션 0082, 프로젝트당 1행)다. 표가 없으면 크론은 종전 전량 읽기로 돌고, 워터마크를 읽지도 쓰지도 않는다. 판정 규칙의 정본은 `lib/scope/mirror/sync.ts` 주석이다.

### 프롬프트

Scope 목록은 `updated_from` 필터를 지원하고 created desc로 정렬된다.

- 워터마크(`prompts_synced_through`)가 있으면 `updated_from = 워터마크 − 10분`으로만 읽는다.
- 한 틱에 최대 **20페이지**(`MIRROR_PROMPT_TICK_MAX_PAGES`)까지만 읽는다. 창이 그보다 크면(일괄 편집 등) 커서를 저장하고 다음 틱이 같은 창을 **이어 읽는다**. 같은 `updated_at`으로 한꺼번에 찍힌 갱신은 시간 창으로 쪼갤 수 없어서, 시간 분할 대신 커서를 택했다. 이어 읽기는 절단이 아니므로 `pageCapHits`에 오르지 않고, 응답의 `perProject[].promptResumePending`으로 보인다.
- 워터마크는 창을 **끝까지** 읽고 upsert가 성공했을 때만 전진한다. 전진값은 그 창을 **처음 읽기 시작한 시각**이고, `GREATEST`로 단조다.
- 워터마크가 없으면(첫 실행) 하한 없는 창을 같은 방식으로 이어 읽는다. 루트(12,446개, 125페이지)는 7틱이면 첫 워터마크가 선다.
- 여유 10분의 전제: Scope 쓰기 트랜잭션이 `updated_at`을 찍고 커밋하기까지 10분을 넘기지 않는다. 넘기면 그 프롬프트는 창 밖으로 빠지고 전체 대조까지 누락된다.

### run

Scope 목록은 시간 필터가 없고 created desc로 정렬된다.

- 최신 run부터 읽다가 **floor 앵커**를 지나고, 그 아래에서 **정착 run이 연속 200개**(`MIRROR_RUN_SETTLED_STREAK`) 나오면 멈춘다. 페이지 상한 50은 안전망으로 남는다.
- **정착 run**은 다음 패스의 `shouldSkipMirroredRun`이 참이 될 run이다. terminal 상태로 미러돼 있고, status가 그대로이며, 재확인 대상(미완 답변 + 3일 창)이 아니어야 한다.
- **floor 불변식**: floor run보다 오래된 run은 전부 정착했다. 매 패스가 끝나면 floor를 다시 계산해 **붙잡는 run** 중 가장 오래된 것을 floor로 삼는다. 붙잡는 run이 없으면 맨 앞 run이 floor다.
- **앵커**: floor run과 그 바로 아래 run까지 최대 5개를 저장하고, 다음 패스는 앵커를 **하나라도** 만나면 floor를 지난 것으로 본다. floor run이 Scope에서 지워져도 경계를 잃지 않는다.
- **스냅샷**: floor에는 그 패스가 **목록을 읽기 시작한 시각**을 함께 저장한다. 저장된 것보다 더 새 스냅샷일 때만 덮어쓴다. 값이 같아도 매 패스 써서 스냅샷을 올린다. 그래서 목록을 먼저 읽고 늦게 끝난 긴 패스(전체 대조)는, 그 사이 크론이 붙잡아 둔 floor를 낡은 목록 기준으로 올리지 못한다.

floor를 **붙잡는** run:

| run | 붙잡는가 | 이유 |
| --- | --- | --- |
| 이번 패스가 **처리하지 못한** 비정착 run(예산 중단·`maxRuns`·재확인 건수 상한·잡 피드 절단), **나이와 무관** | 예 | 연속 N만으로 멈추면 앞쪽 정착 run 뒤에 묻힌다. 7일 규칙보다 먼저 판정한다(미러에 없는 8일짜리 running run이 run 상한에 밀려도 놓치지 않는다) |
| 재확인 대상(terminal + 미완 답변, 3일 창 안) | 예 | 회수를 끝까지 따라간다 |
| **completed가 아닌 terminal run, 3일 창 안(정착했어도)** | 예 | ACR 반복의 숨은 실패는 대표 답변 접기로 가려져 정착으로 보인다. 이후 `partial_failed → completed` 전이는 목록에서 status를 비교해야만 보인다 |
| 이번 패스에 처리한 비종결 run, 7일 이내 | 예 | 끝날 때까지 다시 당긴다 |
| 이번 패스에 처리했는데도 여전히 비종결인 run, 7일 초과(좀비) | 아니오 | 좀비 하나가 루트를 전량 읽기로 되돌리지 않게 한다. 놓아준 수는 `openRunsReleased`로 센다 |
| 오버사이즈 run(잡 10,000개 초과) | 아니오 | 크론은 미러할 수 없고, 대량 경로는 러너의 bulk discovery가 목록을 따로 읽는다 |

⚠️ **처리가 매 패스 실패하는 run**(잡 피드가 늘 상한에서 잘리는 run, 재확인 건수 상한에 계속 밀리는 run)은 나이와 무관하게 floor를 계속 붙잡는다. 그동안 목록 깊이가 그 run까지 유지된다. 이 상태는 `truncatedRuns`·`recheckCapHits`로 이미 표면화된다.

**늦은 커밋 방어 폭**: floor 아래 **최소 N(200)개**를 본다. 페이지 단위로 읽으므로 실제 폭은 N ~ N+99개다. 그보다 깊이 끼어든 run은 크론이 보지 못한다(아래 사각 ⑤).

**종전 동작 유지**: `force`·`resyncBefore`·`runsSince/Until`(= `mirror:local-resync`)과 `promptsUpdatedFrom/To`는 증분·이어 읽기·조기 종료를 쓰지 않는다.

크론 응답의 `perProject[]`에는 `promptRead`(incremental/resume/full/window), `promptPages`, `promptResumePending`, `runPages`, `runScanStoppedEarly`, `pulledBelowFloor`, `openRunsReleased`가 실린다.

## 목록 왕복 수 (루트, 코드 경로 기준)

| | prompts | runs | 합계 | 결과 |
| --- | --- | --- | --- | --- |
| 종전 | 50 (절단) | 50 (절단) | **100** | 데드라인에 걸려 쓰기에 도달하지 못함 |
| 증분, 평시(모의 최선 사례) | 1 | 3 | **4** | 모의 조건: 최근 갱신 40개, floor = 직전 최신 run, 신규 5개, 붙잡는 run 없음 |
| 일괄 편집 6,000건 직후 | 20 × 3틱 | 평시와 같음 | 틱당 23 | 3틱 뒤 평시로 돌아온다 |

모의 측정은 `lib/scope/mirror/sync.incremental.test.ts`의 "API 호출 수"와 "V4" 테스트에 있다. run jobs 왕복(run당 ⌈잡/200⌉)은 전후가 같다.

⚠️ 위 "4왕복"은 floor를 붙잡는 run이 하나도 없는 **최선 사례**다. 실제 run 목록 깊이는 floor를 붙잡는 run 중 가장 오래된 것이 정한다. 주로 **3일 창 안의 미완·비완료 terminal run**과 **7일 이내의 비종결 run**이다. 대형 회차 직후에는 대략 ⌈(floor 위 run 수 + 200) / 100⌉페이지를 읽는다(3일 창이면 3일 내 run 수, 진행 중인 회차가 있으면 그 회차 시작 이후 run 수). 종전 50페이지보다는 작지만 평시 3페이지보다는 크다.

## 적용 순서 (승인 배치)

1. `npm run db:apply -- 0082`로 표를 만든다. 멱등이고 기존 표에 락을 잡지 않는다. 적용 후 `has_table_privilege('anon','public.scope_sync_watermarks','SELECT')`가 false인지 확인한다.
2. 배포한다. 표가 없어도 종전처럼 돌기 때문에 1과 2의 순서가 뒤바뀌어도 안전하다. 다만 효과는 1 이후에 난다.
3. **루트의 run floor를 세운다.** 프롬프트 워터마크는 크론의 이어 읽기로 약 7틱 안에 선다. 그러나 run floor는 목록을 한 번에 끝까지 읽어야 선다(루트 8,681개 > 크론 상한 5,000). 러너 박스에서 한 번 실행한다.
   ```bash
   npm run mirror:reconcile -- be28fe15-c743-4a88-abb8-182b25602812
   ```
   이 명령은 쓰기 작업이다(미러 upsert·replaceRun·워터마크).
   - ⚠️ **루트는 종료 코드가 3으로 고정된다.** 목록에 오버사이즈 run(회차 8, 66,144잡)이 있는데, 이 스크립트는 오버사이즈 run을 **큐에 넣지 않기** 때문이다(대량 경로는 `hmg-mirror.service`의 discovery 소관). **재실행으로 풀리지 않으므로 다시 돌리지 않는다.**
   - 판정은 출력 JSON의 `incompleteOnlyOversized`로 한다. `true`면 오버사이즈 외에는 완결이다.
   - `false`면 미완결 사유를 전부 본다: `pageCapHits`·`budgetStoppedProjects`·`perProjectErrors`·**`recheckCapHits`**(재확인 건수 상한 25/패스)·**`deferred`**·**`runLimitHits`**·**`truncatedRuns`**.
   - ⚠️ **오버사이즈 run과 `recheckCapHits`가 겹치면 종료 코드 3이면서 `incompleteOnlyOversized=false`가 된다.** 루트는 회차 직후 미완 답변이 남은 run이 25건을 넘기 쉬워 이 조합이 흔하다. 이 경우 재확인 상한 초과분은 다음 크론 틱이 이어서 처리하므로(3일 창 안이면 floor가 붙잡는다) 결함이 아니다. `recheckCapHits` 외 사유가 없는지로 판정한다.
4. 확인: 다음 크론 응답에서 루트 `perProject`가 `runScanStoppedEarly:true`이고, `pageCapHits`에 `runs`가 없어야 한다. 프롬프트는 `promptRead`가 `resume`에서 `incremental`로 넘어가면 끝난 것이다.

## 하루 1회 전체 대조 (`mirror:reconcile`)

**안전망이 없으면 아래 사각은 영구다.** 전체 대조는 목록을 전량 읽어 회수할 수 있는 것을 회수하고, 두 워터마크를 새로 세운다.

| # | 증분의 사각 | 전체 대조가 잡는가 |
| --- | --- | --- |
| ① | `updated_at`을 바꾸지 않은 프롬프트 변경(직접 SQL 백필 등) | 잡는다(프롬프트 전량 re-upsert) |
| ② | 커밋 지연이 10분을 넘은 프롬프트 갱신 | 잡는다 |
| ③ | floor 아래 run의 status 전이: 3일 창을 지난 non-completed terminal run의 늦은 회수, 7일을 넘긴 좀비의 종료 | 잡는다(목록 전량 + status 비교). 3일 창 안의 전이(ACR 숨은 실패 포함)는 floor가 붙잡으므로 크론이 1틱 안에 잡는다 |
| ④ | floor 앵커가 전부 지워짐 → 크론이 매 틱 상한까지 읽고 절단(`pageCapHits: runs`) | 잡는다(floor 재설정) |
| ⑤ | floor 아래 N(200)개보다 깊이 끼어든 늦은 커밋 run | 잡는다. 출력의 `pulledBelowFloor`로 센다. 단, 전체 대조의 floor 쓰기는 크론이 더 새 스냅샷을 계속 쓰므로 **사실상 거절된다.** 그래서 대조가 회수한 run이 아직 비종결이면 크론의 floor 위로 올라오지 않고, 그 run의 **최종 상태는 다음 전체 대조(최대 24시간 뒤)에야** 들어온다 |
| ⑥ | floor 아래 오버사이즈 run | **못 잡는다**(큐에 넣지 않는다). 러너의 bulk discovery(`hmg-mirror.service --discover`)가 맡는다 |
| ⑦ | 코어 재분석(run status 불변, 답변 분석만 교체) | **못 잡는다.** 종전 크론도 못 잡았다. `mirror:local-resync`(force + 기간 창)를 쓴다 |
| ⑧ | 프롬프트 삭제·비활성 | **못 잡는다.** Scope 목록이 삭제분을 내주지 않고 미러는 upsert만 한다. 종전과 같다 |

- **`pulledBelowFloor`**: 크론 floor 아래(증분이 보지 않는 구간)였는데 대조가 다시 당긴 run 수다. **0이 아니라고 곧 증분 누락은 아니다.** 7일 넘은 비종결 run(좀비)은 미러 워터마크에 없어 대조가 **매일 다시 당기므로** 여기에 계속 잡힌다. 크론의 `openRunsReleased`(놓아준 좀비 수)와 run id를 대조해 좀비를 빼고 남는 수가 증분 누락이다. 그 수가 반복되면 위 표의 어느 사각인지 조사한다.
- force가 **아니다.** 정착 run은 다시 당기지 않으므로 비용의 대부분은 목록 왕복이다. 루트 기준 prompts 약 125 + runs 약 87 = 약 212 왕복이다. 기본 상한은 1,000페이지, 예산은 6시간(`MIRROR_LOCAL_BUDGET_MS`)이다. 인자는 `npm run mirror:reconcile -- --help`로 본다.
- **동시 실행**: 크론과 겹쳐 돌아도 된다.
  - run 쓰기는 run 단위 트랜잭션이다.
  - 프롬프트 워터마크는 `GREATEST`로 단조이고, 창을 끝까지 읽은 쪽이 이어 읽기 상태를 비운다.
  - floor는 **목록 스냅샷이 더 새 쪽만** 쓴다. 전체 대조가 목록을 읽은 뒤에 끝난 크론 패스가 하나라도 있으면, 전체 대조의 floor 쓰기는 거절된다(로그 `run-floor not written`). 이것은 정상이다.

러너 박스(뭄바이 EC2 `i-0123456789abcdef0`, `hmg-mirror.service`와 같은 release·env)에 둘 타이머 예시는 아래와 같다. **이 PR은 설치하지 않는다.** 전체 프로젝트를 돌리므로 루트의 종료 코드 3은 위 3번 항목과 같이 판정한다. 타이머의 실패 알림을 종료 코드에 걸면 매일 울린다. `SuccessExitStatus=3`으로 뭉개면 진짜 미완결까지 가려지므로, 출력 JSON의 `incompleteOnlyOversized`를 보는 래퍼를 둔다.

```ini
# /etc/systemd/system/hmg-mirror-reconcile.service
[Service]
Type=oneshot
WorkingDirectory=<release dir>
EnvironmentFile=<hmg-mirror.service 와 같은 env 파일>
ExecStart=/usr/bin/npm run -s mirror:reconcile
# /etc/systemd/system/hmg-mirror-reconcile.timer
[Timer]
OnCalendar=*-*-* 18:30:00 UTC
Persistent=true
```

## 남은 위험

- 위 사각 ⑥·⑦·⑧은 전체 대조로도 회수되지 않는다.
- 마이그레이션 번호 0082는 통합 프리뷰(0081, 저널 idx 70)와 미머지 `feat/core-view-anchor`(0074·0076)를 피해 정했다. 머지 순서가 바뀌면 다시 확인한다.
