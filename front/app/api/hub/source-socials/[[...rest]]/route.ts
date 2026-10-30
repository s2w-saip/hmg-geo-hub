import { sourceListProxy } from "../../source-list-proxy";

// Admin › 인용 출처 분류 › 공식 소셜 (2026-10-30): HUB-owned official social accounts (back/bff/hub_stores/source_lists.py).
//
//   GET  /api/hub/source-socials               -> the HUB's accounts next to Gold's social layer
//   GET  /api/hub/source-socials/history?key=  -> one account's history (no key: the latest changes)
//   POST /api/hub/source-socials               -> add an account or replace its matchers {key, matchers}
//   POST /api/hub/source-socials/stop          -> stop {key}
//   POST /api/hub/source-socials/resume        -> resume {key}
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, POST } = sourceListProxy(
  "/v1/hub/source-socials",
  [
    ["GET", ""],
    ["GET", "history"],
    ["POST", ""],
    ["POST", "stop"],
    ["POST", "resume"],
  ],
  ["key"],
);
