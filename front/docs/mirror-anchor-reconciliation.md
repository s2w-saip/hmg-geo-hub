# Mirror anchor reconciliation (read-only P0 plan)

이 도구는 Scope 원장과 HMG 미러의 메타데이터 snapshot을 읽어 부모 앵커 변경 계획만 만든다. DB·HTTP 연결, 레지스트리 INSERT, `UPDATE`, 재싱크 호출은 없다. 원문 답변·mention·citation과 credential은 snapshot에 넣지 않는다.

구현 파일은 `scripts/scope/anchor-audit.ts`(순수 planner + JSON/CSV CLI)와 `scripts/scope/anchor-audit.test.ts`(결정 규칙)이다. CLI는 `--run-id`, `--project-id`, `--observed-after`, `--observed-before`, `--format json|csv`를 받으며 `--format`은 출력 형식이다. 입력 snapshot은 JSON/CSV 내용을 자동 감지한다. 입력 snapshot에는 top-level `workspaceId`, `snapshotConsistencyId`와 각 parent/child/mirror/cycle row의 `snapshotId`가 필수다.

## 판정 계약

`MATCH`는 parent와 child의 canonical millisecond anchor가 같다는 뜻이다. `RECOMMEND_PARENT_ANCHOR`는 다음 조건을 모두 만족할 때만 허용되는 제안이다. parent가 NULL이 아니고 `expected_child_count`가 존재하며 child row 수와 정확히 같고, child ID가 모두 존재·유일하며, child가 하나 이상이고 모든 child anchor가 NULL이 아니고 하나의 값으로 수렴하고, parent `started_at`과 모든 child/cycle/mirror status가 관측되고, 각 anchor가 `started_at`보다 늦지 않으며, child가 mutable 상태가 아니고 열린 ticket이 없고, workspace/project 경계가 일치하고, cycle membership이 정확히 하나이며 그 cycle의 anchor도 candidate와 같아야 한다. 네 snapshot이 동일한 `snapshot_consistency_id`를 가져야 한다. cycle status 허용 목록은 실제 `0059_summary_tables.sql` CHECK와 동일한 `open`, `closed`, `generating`, `published`, `stale`뿐이다. 이 판정은 계획일 뿐 자동 수정하지 않는다.

다음은 즉시 `BLOCK`이다.

- child row가 없거나 child anchor에 NULL이 있거나 둘 이상의 canonical millisecond 값이 섞임
- parent anchor NULL, invalid timestamp, parent/child anchor가 `started_at` 이후, parent 또는 소유 project가 archived/deleted
- workspace/project mismatch, snapshot consistency identifier 누락 또는 mismatch
- parent `started_at`, child `status`, child `ticket_status`, cycle `status`, cycle generation 관측 필드 등 필수 관측값 누락 또는 알 수 없는 값. nullable 필드는 명시적 `null`이어야 하며 필드 자체가 생략되면 BLOCK이다.
- queued/running child, `ticket_status='submitted'`, archived/deleted parent 또는 child
- cycle membership 없음/복수, cycle anchor conflict, published/closed/stale/generating cycle, active generation 또는 view anchor 존재
- mirror row 누락/중복, 비종료 mirror status, mirror anchor NULL/invalid, mirror project mismatch, mirror conflict, truncated/oversized marker, completeness verification 또는 diagnostic evidence ID 누락

Parent와 child의 raw timestamp가 microsecond 단위로 다르더라도 API 관측 정밀도인 UTC millisecond로 canonicalize하여 비교한다. raw 값을 덮어쓰거나 날짜(`::date`)로 축약하지 않는다. sub-ms drift는 출력의 canonical 값으로만 판단하며, 실제 write 계획에서는 원본 timestamp를 별도 보존해야 한다.

`sourceRevision`은 선택적인 행 버전 또는 추출본 식별자다. 서로 다른 테이블에서 같은 값을 기대하지 않는다. planner가 비교하는 값은 모든 입력 추출물이 같은 관측 묶음에서 나왔음을 나타내는 `snapshotConsistencyId`(row에서는 `snapshotId`)이며, 누락·불일치는 BLOCK이다.

ACR은 child 수와 mirror answer 수를 단순히 같다고 검사하면 안 된다. 미러는 `dedupeAcrIterationJobs`로 prompt-run iteration 대표만 `scope_answers`에 저장하고 전체 job은 ACR rollup에 사용하므로, raw child completeness와 ACR 대표 completeness를 별도 지표로 추출해야 한다. tombstone/drop registry와 anchor registry도 별도 snapshot으로 보존한다.

## CLI 사용

```sh
npm run mirror:anchor-audit -- --help
npm run --silent mirror:anchor-audit -- snapshot.json --run-id run-1 --format csv
```

입력 JSON은 아래 예제의 camelCase 필드명을 사용한다. CSV는 `kind`(`parent`, `child`, `mirror`, `cycle`)와 snake_case 필드명을 사용하며, 필수 nullable 열의 빈 셀은 NULL 관측을 뜻한다. 열 자체가 없거나 행 길이가 맞지 않으면 입력 오류다. timestamp는 `T`와 timezone을 포함해야 한다. PostgreSQL 추출값은 예를 들어 `to_char(cycle_anchor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`로 원래 microsecond를 보존해 표현한다. SQL 집계 결과만으로 CLI 입력을 만들 수 없으며, 개별 child 행과 별도 검증 manifest를 함께 구성해야 한다.

종료코드 0은 **대조 보고서 생성 성공**이다. BLOCK이 있는 보고서도 출력하므로 적용 가능 여부는 각 행의 `decision`으로 확인한다. 입력 오류·빈 대상·지정 run 누락은 비정상 종료한다.

## 읽기 전용 SQL 추출 최소 범위

아래 SELECT는 추출용 템플릿이다. 읽기 전용 연결에서 `:workspace_id`, `:project_id`, `:run_id`(여러 대상이면 반복 실행 또는 `ANY(:run_ids::uuid[])`로 확장), `:started_from`, `:started_until`을 바인딩해 snapshot을 만든다. 모든 Scope 문장은 workspace와 run ID를 함께 제한하고, timestamp 비교는 `date_trunc('milliseconds', timestamptz)`를 사용한다. `expectedChildCount`는 이 repeatable-read Scope snapshot에서 status/anchor 필터 없이 별도로 센 raw `query_runs` 수이고, child export row 수를 세어 만든 값이면 안 된다.

### Scope parent/child snapshot

```sql
WITH child AS (
  SELECT q.measurement_run_id AS run_id,
         count(*) AS child_count,
         count(*) AS expected_child_count,
         count(*) FILTER (WHERE q.cycle_anchor_at IS NULL) AS child_null_anchor_count,
         count(DISTINCT date_trunc('milliseconds', q.cycle_anchor_at))
           FILTER (WHERE q.cycle_anchor_at IS NOT NULL) AS child_anchor_distinct_ms,
         array_agg(DISTINCT date_trunc('milliseconds', q.cycle_anchor_at))
           FILTER (WHERE q.cycle_anchor_at IS NOT NULL) AS child_anchor_values_ms,
         count(*) FILTER (WHERE q.status IN ('queued','running')) AS mutable_child_count,
         count(*) FILTER (WHERE q.ticket_status = 'submitted') AS open_ticket_count
    FROM query_runs q
   WHERE q.workspace_id = :workspace_id::uuid
     AND q.measurement_run_id = :run_id::uuid
   GROUP BY q.measurement_run_id
)
SELECT mr.id AS run_id, mr.workspace_id, mr.project_id,
       mr.cycle_anchor_at AS parent_anchor_at, mr.started_at,
       child.*
  FROM measurement_runs mr
  LEFT JOIN child ON child.run_id = mr.id
 WHERE mr.workspace_id = :workspace_id::uuid
   AND mr.id = :run_id::uuid
   AND (:project_id::uuid IS NULL OR mr.project_id = :project_id::uuid)
   AND mr.started_at >= :started_from::timestamptz
   AND mr.started_at < :started_until::timestamptz;
```

별도 Scope snapshot으로 각 child의 `cycle_anchor_at`, `status`, `ticket_status`를 보존해야 `MIXED_CHILD_ANCHORS`를 판정할 수 있다. 집계만으로는 mixed 값을 복원할 수 없다. `sourceRevision`은 실제 Scope row 컬럼으로 가정하지 말고, 추출 manifest의 checksum/관측 식별자로 별도 제공한다.

### HMG mirror와 cycle membership snapshot

```sql
SELECT r.run_id, r.project_id, r.cycle_anchor_at AS mirror_anchor_at,
       r.status, r.synced_at, r.total_jobs,
       count(a.job_id) AS answer_count,
       count(DISTINCT aa.job_id) AS anchor_registry_count,
       count(DISTINCT ad.job_id) AS drop_registry_count
  FROM scope_runs r
  LEFT JOIN scope_answers a ON a.run_id = r.run_id
  LEFT JOIN scope_answer_anchors aa ON aa.job_id = a.job_id
  LEFT JOIN scope_answer_drops ad ON ad.job_id = a.job_id
 WHERE r.run_id = :run_id::uuid
 GROUP BY r.run_id, r.project_id, r.cycle_anchor_at, r.status, r.synced_at, r.total_jobs;

SELECT cr.run_id, cr.cycle_id, c.project_id, c.cycle_anchor_at,
       c.status, c.view_anchor_at, c.active_generation_id,
       g.status AS generation_status, g.checksum
  FROM summary_cycle_runs cr
  JOIN summary_cycles c ON c.cycle_id = cr.cycle_id
  LEFT JOIN summary_generations g ON g.generation_id = c.active_generation_id
 WHERE cr.run_id = :run_id::uuid;
```

`scope_runs.synced_at`은 쓰기/재싱크 시각이지 anchor correctness watermark가 아니다. Scope anchor가 NULL 또는 응답에 없을 때 HMG sync의 upsert는 기존 mirror anchor를 유지하므로, mirror `synced_at`이 최신이어도 mirror anchor가 stale일 수 있다. Summary cycle의 membership 또는 active generation과 candidate가 충돌하면 parent 수정 전에 해당 세대의 재생성/명시적 운영 결정을 거쳐야 한다.

HMG의 `truncated`, `oversized`, `completenessVerified`, `diagnosticEvidenceId`는 `scope_runs` 스키마 컬럼이 아니다. 이는 mirror pass diagnostics manifest 입력이다. planner는 `completenessVerified=true`와 `diagnosticEvidenceId` 중 하나라도 빠지면 completeness를 UNKNOWN으로 보고 BLOCK한다. `snapshotConsistencyId`는 manifest 식별자일 뿐, Scope와 HMG 두 DB의 cross-DB 원자성을 증명하지 않는다.

최소 JSON 입력 예시는 다음과 같다. `expectedChildCount`는 child 배열에서 계산해 넣지 말고 Scope raw count snapshot의 별도 결과를 넣는다.

```json
{
  "workspaceId": "workspace-snapshot",
  "snapshotConsistencyId": "manifest-2026-09-15T16:00:00Z",
  "parents": [{
    "runId": "run-1", "workspaceId": "workspace-snapshot", "projectId": "project-1",
    "cycleAnchorAt": "2026-09-14T00:00:44.507Z", "startedAt": "2026-09-14T01:50:57.504Z",
    "expectedChildCount": 1, "snapshotId": "manifest-2026-09-15T16:00:00Z"
  }],
  "children": [{
    "runId": "run-1", "childId": "job-1", "workspaceId": "workspace-snapshot", "projectId": "project-1",
    "cycleAnchorAt": "2026-09-14T00:00:44.507Z", "status": "completed",
    "ticketStatus": null,
    "snapshotId": "manifest-2026-09-15T16:00:00Z"
  }],
  "mirrors": [{
    "runId": "run-1", "projectId": "project-1", "cycleAnchorAt": "2026-09-14T00:00:44.507Z",
    "status": "completed",
    "completenessVerified": true, "diagnosticEvidenceId": "diag-1",
    "snapshotId": "manifest-2026-09-15T16:00:00Z"
  }],
  "cycles": [{
    "runId": "run-1", "cycleId": "cycle-1", "projectId": "project-1",
    "cycleAnchorAt": "2026-09-14T00:00:44.507Z", "status": "open",
    "viewAnchorAt": null, "activeGenerationId": null, "generationStatus": null,
    "snapshotId": "manifest-2026-09-15T16:00:00Z"
  }]
}
```

`summary_cycles`의 `cycle_anchor_at`, `status`, `view_anchor_at`, `active_generation_id`와 `summary_generations`의 `status`/`checksum`은 실제 `lib/db/migrations/0059_summary_tables.sql` 스키마에서 읽는다. `summary_cycle_runs.run_id`는 UNIQUE이므로 복수 membership은 정상 상태가 아니며 BLOCK이다. 생성 세대가 있으면 parent anchor 변경이 이미 생성된 세부/추이 사실표를 무효화할 수 있으므로 자동 추천하지 않는다.

## 검증과 rollback

실행 전 snapshot checksum, row counts, 대상 run ID 목록, source revisions를 저장한다. planner 결과는 run별로 `MATCH`, `RECOMMEND_PARENT_ANCHOR`, `BLOCK` 판정과 사유를 출력하고, BLOCK이 하나라도 있는 run은 write plan에 포함하지 않는다. 추천을 실제 적용하는 별도 단계가 생기면 parent/child/mirror/cycle를 같은 run ID로 재조회하고 canonical millisecond·revision·membership을 재검증한 뒤에만 명시적 plan ID를 승인한다.

적용 후에는 parent/child anchor 일치, mirror resync 결과, cycle membership anchor, generated row checksum을 다시 읽어 pre-snapshot과 대조한다. rollback은 원본 parent anchor와 candidate, plan ID를 가진 명시적 역변경으로만 허용하며, cycle membership·generation이 이미 생성된 경우 자동 rollback하지 않고 BLOCK/운영 승인으로 남긴다. 이 PR 범위에는 그 write/rollback 호출을 포함하지 않는다.
