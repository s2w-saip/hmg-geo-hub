-- GA4 추적 이벤트 선택 (WBS 1.2.x, 2026-07-28)
--
-- property_id 별로 "전환으로 셀 이벤트"를 admin이 골라 저장한다. 전환 KPI
-- (lib/ga4/conversion.ts)는 해당 property에 이 표의 행이 하나라도 있으면 그
-- eventName 집합을 전환 분자(eventCount)의 정의로 쓰고, 한 행도 없으면 기존대로
-- GA4 key events 를 그대로 쓴다(fallback → 라이브 Kia/IT 무중단).
--
-- property_id 로 키를 잡아 레지스트리 매핑(ga4_properties)과 프로젝트 오버라이드
-- (projects.ga4_property_id)가 같은 선택을 공유한다.
-- created_by = profiles.id (no FK — schema 이식성 방침).
-- 멱등: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS ga4_tracked_events (
  property_id  text NOT NULL,          -- GA4 Data API 속성ID
  event_name   text NOT NULL,          -- GA4 eventName (전환으로 집계할 이벤트)
  created_by   uuid NOT NULL,          -- = profiles.id
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, event_name)
);

CREATE INDEX IF NOT EXISTS ga4_tracked_events_property_idx
  ON ga4_tracked_events (property_id);
