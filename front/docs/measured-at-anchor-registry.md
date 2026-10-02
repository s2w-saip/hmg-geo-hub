# measured_at 회차 앵커 레지스트리 (`scope_answer_anchors`)

미러의 `scope_answers.measured_at` 이 **소속 회차의 앵커 날짜**를 가리키게 유지하는 구조.
사고 경위·앵커 산정 규칙의 정본은 내부 운영 문서
`internal-kb/hmg-website-measured-at-anchor-normalization-2026-08-25.md` 이고,
이 문서는 **이 리포에서 무엇이 어떻게 동작하는가**만 다룬다.

## 모델

한 답변의 `measured_at` 은 벽시계 완료 시각이 아니라 소속 회차의 앵커 날짜다(시각은 보존).
회차가 자정을 넘겨 걸치면 주간 버킷이 갈라지고, 꼬리 쪽이 n=1~수십짜리 저표본 버킷이 되어
KPI 가 0%·100% 로 튄다 — 고객 화면에서 그게 "급락"으로 보인다.

## 왜 테이블인가 (2026-08-31 사고)

접기를 **미러 행 위의 일회성 UPDATE** 로만 하면, `scope-mirror.ts::replaceRun`
(run 단위 delete + insert)이 그 run 을 다시 훑는 순간 scope 원본값으로 덮인다.
2026-08-31 04:12Z 의 회수 재싱크가 — `force` 가 아니라 **정규 경로**에서 —
8/25 접기 중 **18,890행**을 되돌렸고, 주간 추이에 7/20 주와 7/27 캠페인 분절이 되살아났다.
두 번째 재발이라 저장 구조를 바꿨다: **접기는 재싱크가 소비하는 입력 데이터**다.

| 구성 요소 | 위치 |
| --- | --- |
| 레지스트리 테이블 | `scope_answer_anchors` (`lib/db/schema.ts`, migration 0053) |
| 접기 산술의 정본 | SQL 함수 `scope_anchor_fold(timestamptz, date)` (migration 0053) |
| 재싱크 재적용 | `lib/db/repositories/scope-mirror.ts::anchorReapplySql` — `replaceRun` 트랜잭션 안, answers 삽입 직후 |
| 원본 백업 | `_bak_anchor_fold` (**삭제 금지**) + `scope_answer_anchors.source_measured_at` |

`source_measured_at` 이 있어야 "앵커 모델을 폐기하고 scope 원본으로 되돌린다"가 가능하다.

## 새 회차를 접을 때 (현재 수동)

접기 UPDATE 를 직접 쓰지 말고 **레지스트리에 등록한 뒤 재적용**한다. 그래야 다음 재싱크가
다시 풀지 않는다. 실행 경로는 Supabase SQL Editor(사용자 실행) — 문 단위로 실행되므로
TEMP 테이블·`BEGIN…COMMIT` 을 쓰지 않는다.

```sql
-- ① 등록 (원본 보존)
INSERT INTO scope_answer_anchors (job_id, anchor, source_measured_at, reason)
SELECT a.job_id, DATE '<앵커>', a.measured_at, 'fold:<YYYY-MM-DD> <사유>'
  FROM scope_answers a
 WHERE <회차 조건>
ON CONFLICT (job_id) DO NOTHING;

-- ② 재적용 (멱등 — 이미 앵커인 행은 잡히지 않는다)
UPDATE scope_answers a SET measured_at = scope_anchor_fold(a.measured_at, r.anchor)
  FROM scope_answer_anchors r
 WHERE a.job_id = r.job_id
   AND a.measured_at IS NOT NULL
   AND (a.measured_at AT TIME ZONE 'UTC')::date IS DISTINCT FROM r.anchor;

-- ③ 검증 — 0 이어야 한다
SELECT count(*) FROM scope_answer_anchors r JOIN scope_answers a USING (job_id)
 WHERE a.measured_at IS NOT NULL
   AND (a.measured_at AT TIME ZONE 'UTC')::date IS DISTINCT FROM r.anchor;
```

**앵커 산정 규칙** (2026-09-01 개정):

1. 클러스터 경계 = **측정 공백**. `gap≤2` 는 쓰지 않는다 — 8/19 소규모 측정일이 8/21 정규
   회차를 삼킨 과병합 사고의 직접 원인이다.
2. 앵커 = 클러스터 내 **최다 측정일**. "첫날"을 쓰면 앞에 붙은 44건짜리 조각이 6만 건 본체의
   회차 날짜를 결정한다.
3. 양쪽이 **둘 다 회차급 규모**면 병합하지 않는다.

## 자동화 (설계 메모 — 미구현)

지금은 회차마다 사람이 ①②를 돌린다. 자동화한다면:

- **어디에**: 미러 싱크 크론(`/api/cron/sync-mirror`)의 뒤가 아니라 **별도 잡**. 싱크는
  프로젝트 단위로 예산 안에서 도는데, 앵커 산정은 프로젝트의 측정일 분포 전체를 봐야 한다.
- **무엇을**: 프로젝트별로 `scope_answers` 의 UTC 측정일을 뽑아 공백으로 클러스터링 →
  각 클러스터의 최다 측정일을 앵커로 → 앵커 밖 행을 레지스트리에 등록. 재적용은 기존
  `anchorReapplySql` 이 다음 재싱크에서 자동으로 한다(또는 등록 직후 한 번).
- **안전장치 (이게 본체다)**: 규칙 3 위반 — 클러스터 안에 회차급 규모의 날이 둘 이상이면
  **등록하지 말고 사람에게 올린다.** 8/25 과병합이 정확히 이 판정에서 실패했다. 자동 등록은
  "조각을 본체에 붙이는" 명백한 경우로 한정한다(예: 꼬리 비중 < 10%).
- **가역성**: 자동 등록분은 `reason` 을 `auto:<날짜>` 로 남겨 사후에 사람 등록분과 분리
  롤백할 수 있어야 한다.
- **미해결**: 여전히 미러 쪽 사후 보정이다. 근본적으로는 scope 원본이 회차 앵커를 스탬프해
  주는 편이 낫다(그러면 미러는 그 값을 그대로 받는다) — Scope 계약 변경이라 별건.

## 드롭 레지스트리 (`scope_answer_drops`, migration 0054)

앵커의 쌍둥이. 앵커가 "날짜를 옮긴다"면 드롭은 "미러에서 뺀다".

**언제 접지 않고 드롭하나** — 같은 사이트가 **같은 주 버킷(월요일 시작)** 에 회차를 둘 가지면.
2026-08-17~19 소규모 측정(37사이트 7,130건)은 전부 8/21 정규 회차에도 측정된 사이트의 것이라,
8/21 로 접으면 그 주에 같은 사이트 답변이 두 배가 되어 KPI 가중이 왜곡된다. Kia/IT 7/20 도
7/13 자체 회차가 있어 같은 형태다. 접기는 회차의 꼬리·조각용이고, **회차 자체가 둘이면 드롭**이다
(2026-09-03 제품 결정 — GGMD "7월 1주~9월 1주 기준선 9개" 요청).

미러 행을 그냥 DELETE 하면 `replaceRun` 이 그 run 을 다시 훑을 때 되살아난다(앵커의 8/31 사고와
동형). 그래서 드롭도 **재싱크가 소비하는 입력**이다.

| 구성 요소 | 위치 |
| --- | --- |
| 레지스트리 테이블 | `scope_answer_drops(job_id PK, source_measured_at, dropped_at, reason NOT NULL)` |
| 삭제 범위·순서의 정본 | SQL 함수 `scope_answer_drop_apply(run_id)` — citations → mentions → answers, run 으로 좁힘, 지운 answers 수 반환 |
| 재싱크 재적용 | `scope-mirror.ts::dropReapplySql` — `replaceRun` 트랜잭션 안, **모든 삽입이 끝난 뒤** (앞당기면 뒤에 들어오는 mentions·citations 가 고아) |
| 원복 | 레지스트리 행 삭제 + 그 run 재싱크(scope 원본은 무변경) |

```sql
-- ① 등록 (사유 필수 — 배치 롤백의 키)
INSERT INTO scope_answer_drops (job_id, source_measured_at, reason)
SELECT a.job_id, a.measured_at, 'drop:<YYYY-MM-DD> <사유>'
  FROM scope_answers a WHERE <드롭 조건>
ON CONFLICT (job_id) DO NOTHING;

-- ② 적용 (멱등 — 이미 없는 job 은 0행)
SELECT sum(scope_answer_drop_apply(run_id)) FROM (
  SELECT DISTINCT a.run_id FROM scope_answers a JOIN scope_answer_drops d USING (job_id)
) r;

-- ③ 검증 — 둘 다 0 이어야 한다
SELECT count(*) FROM scope_answer_drops d JOIN scope_answers a USING (job_id);
SELECT count(*) FROM scope_mentions m LEFT JOIN scope_answers a USING (job_id) WHERE a.job_id IS NULL;
```

ACR 롤업(`scope_acr_rollups`)은 prompt-run 키라 드롭 대상이 아니다 — website KPI 추이는
answers·mentions·citations 만 읽는다.
