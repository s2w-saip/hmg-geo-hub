import { sourceListProxy } from "../../source-list-proxy";

// Admin › 엔티티 카탈로그 (2026-11-02): HUB-owned entity roles (back/bff/hub_stores/entity_roles.py).
//
//   GET  /api/hub/entity-roles                   -> Gold's entities with the HUB's roles
//   GET  /api/hub/entity-roles/history?entity=   -> one entity's history (no entity: the latest changes)
//   GET  /api/hub/entity-roles/mentions?entity=  -> Gold's observed surfaces and mention samples
//   POST /api/hub/entity-roles                   -> set {entityId, role, brand, note}
//   POST /api/hub/entity-roles/clear             -> back to competitor {entityId}
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, POST } = sourceListProxy(
  "/v1/hub/entity-roles",
  [
    ["GET", ""],
    ["GET", "history"],
    ["GET", "mentions"],
    ["POST", ""],
    ["POST", "clear"],
  ],
  ["entity"],
);
