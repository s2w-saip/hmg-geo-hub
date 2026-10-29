-- 0004 분석 컨텍스트 스냅샷 캐시 — 키는 `contextVersion`.
--
-- 스냅샷 내용 = `{catalog, rels, grouping, trackedAugmentTargets}` — 코어 `loadSharedAnalysisContext`
-- 가 돌려주는 5종에서 **`entityNames` 만 뺀 것**이다. `entityNames` 는 persist 전용이라 lane 에
-- 갈 이유가 없다(스펙 §5.2 실측). 경계가 정확히 떨어진다.
--
-- ── 왜 DB 테이블인가 (스펙 §4.5 는 "lane 이 LRU 캐시한다" 까지만 말한다)
--
--   프로세스 LRU 만 두면 **워커 태스크마다 자기 사본**을 받아야 한다. 오토스케일 0→16 구간에서
--   새 태스크가 뜰 때마다 코어 `/api/internal/analysis-context` 를 치므로, 확대 순간에 코어로
--   가는 요청이 태스크 수만큼 곱해진다. 이 테이블이 **2차 캐시**다:
--     프로세스 LRU(1차) → lane PG(2차) → 코어 GET(3차)
--   1차는 `worker/context-cache.ts` 가 소유하고 이 테이블은 태스크 교체에도 살아남는다.
--
-- ── 무효화
--
--   **TTL 이 없다.** 버전이 내용 해시라 내용이 바뀌면 키가 바뀐다(스펙 §4.5 — 구 P2 의 TTL·
--   60초 3문장 프로브가 통째로 불필요해진 이유). 여기서 지우는 것은 **용량 회수**일 뿐이므로
--   `last_used_at` 기준 LRU 로 자른다. 지워도 다음 미스가 코어에서 다시 가져온다 =
--   **안전한 실패 방향**(정확성이 아니라 적중률만 떨어진다).
--
-- ⚠️ 스냅샷 **원본 바이트는 미측정**이다(스펙 §14-1). `payload_bytes` 를 행에 남기는 이유가
--    그것이다 — LRU 상한의 근거를 라이브가 만들게 한다. 그 전까지 상한은 보수적 기본값이다.

CREATE TABLE IF NOT EXISTS analysis_contexts (
  context_version text PRIMARY KEY,      -- '<projectId>:<sha256(canonical JSON)[:16]>'
  project_id      uuid NOT NULL,         -- 캐시 네임스페이스(디버깅·프로젝트별 회수용). 정확성 근거 아님
  payload         jsonb NOT NULL,        -- {catalog, rels, grouping, trackedAugmentTargets}
  payload_bytes   bigint NOT NULL CHECK (payload_bytes >= 0),
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  use_count       bigint NOT NULL DEFAULT 0
);

-- LRU 절단의 접근 경로.
CREATE INDEX IF NOT EXISTS analysis_contexts_lru_idx ON analysis_contexts (last_used_at);
CREATE INDEX IF NOT EXISTS analysis_contexts_project_idx ON analysis_contexts (project_id, fetched_at DESC);
