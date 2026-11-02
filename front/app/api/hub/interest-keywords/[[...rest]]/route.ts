import { sourceListProxy } from "../../source-list-proxy";

// Admin › 고객 관심 데이터 관리 › 키워드 (2026-11-02): HUB-owned seed keywords (back/bff/hub_stores/interest.py).
//
//   GET  /api/hub/interest-keywords                -> the HUB's keywords next to Gold's seed rows
//   GET  /api/hub/interest-keywords/history?term=  -> one keyword's history (no term: the latest changes)
//   POST /api/hub/interest-keywords                -> add / change {term, conditions, sourceTypes, brands, note}
//   POST /api/hub/interest-keywords/stop|resume    -> {term}
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, POST } = sourceListProxy(
  "/v1/hub/interest-keywords",
  [
    ["GET", ""],
    ["GET", "history"],
    ["POST", ""],
    ["POST", "stop"],
    ["POST", "resume"],
  ],
  ["term"],
);
