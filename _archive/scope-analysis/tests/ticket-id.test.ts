import assert from "node:assert/strict";
import { test } from "node:test";

import { NS_ANALYSIS, deterministicAnalysisTicketId, uuid5 } from "../contracts/ticket-id.ts";

// 측정 lane 의 네임스페이스. 겹치면 안 된다는 것을 테스트가 못박는다.
const NS_MEASUREMENT = "5c0e2a5e-3b5b-4f3a-9f0c-7d3f0c2c1a10";

test("uuid5 matches the RFC vector (same formula as python uuid.uuid5)", () => {
  // RFC 4122 DNS namespace + "python.org" — 표준 벡터
  const NS_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  assert.equal(uuid5(NS_DNS, "python.org"), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
});

test("ticket id is deterministic and version-5 shaped", () => {
  const a = deterministicAnalysisTicketId("ws", "turn", "2026-09-01", 1);
  const b = deterministicAnalysisTicketId("ws", "turn", "2026-09-01", 1);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("attempt is part of the name — otherwise 재분석이 같은 티켓으로 접힌다", () => {
  const a1 = deterministicAnalysisTicketId("ws", "turn", "v1", 1);
  const a2 = deterministicAnalysisTicketId("ws", "turn", "v1", 2);
  assert.notEqual(a1, a2);
});

test("analysisVersion is part of the name — 재분석은 다른 티켓·다른 원장 행이어야 한다", () => {
  assert.notEqual(
    deterministicAnalysisTicketId("ws", "turn", "2026-09-01", 1),
    deterministicAnalysisTicketId("ws", "turn", "2026-09-02", 1),
  );
});

test("analysis namespace does not collide with the measurement lane", () => {
  assert.notEqual(NS_ANALYSIS, NS_MEASUREMENT);
  // 같은 이름을 두 네임스페이스로 돌리면 다른 id 가 나와야 한다 — 이것이 충돌 회피의 본질이다.
  assert.notEqual(uuid5(NS_ANALYSIS, "a:b:c:1"), uuid5(NS_MEASUREMENT, "a:b:c:1"));
});

test("ambiguous separators are rejected rather than silently colliding", () => {
  assert.throws(() => deterministicAnalysisTicketId("ws", "turn", "2026:09:01", 1), /must not contain/);
  assert.throws(() => deterministicAnalysisTicketId("ws", "turn", "v1", 0), /positive integer/);
});
