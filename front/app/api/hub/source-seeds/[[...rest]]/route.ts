import { sourceListProxy } from "../../source-list-proxy";

// Admin › 인용 출처 분류 › 시드 (2026-10-30): HUB-owned seed list (back/bff/hub_stores/source_lists.py).
//
//   GET  /api/hub/source-seeds                 -> the HUB's seeds next to Gold's seed layer
//   GET  /api/hub/source-seeds/history?skey=   -> one seed's history (no skey: the latest changes)
//   POST /api/hub/source-seeds                 -> add / change / restore {skey, category}
//   POST /api/hub/source-seeds/remove          -> remove {skey}
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, POST } = sourceListProxy(
  "/v1/hub/source-seeds",
  [
    ["GET", ""],
    ["GET", "history"],
    ["POST", ""],
    ["POST", "remove"],
  ],
  ["skey"],
);
