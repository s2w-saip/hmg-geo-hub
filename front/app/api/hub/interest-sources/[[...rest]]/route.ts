import { sourceListProxy } from "../../source-list-proxy";

// Admin › 고객 관심 데이터 관리 › 수집 소스 (2026-11-02): HUB-owned community sources (back/bff/hub_stores/interest.py).
//
//   GET  /api/hub/interest-sources               -> the HUB's sources next to Gold's corpus hosts
//   GET  /api/hub/interest-sources/history?url=  -> one source's history (no url: the latest changes)
//   POST /api/hub/interest-sources               -> add / change {url, channel, brands, note}
//   POST /api/hub/interest-sources/stop|resume   -> {url}
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, POST } = sourceListProxy(
  "/v1/hub/interest-sources",
  [
    ["GET", ""],
    ["GET", "history"],
    ["POST", ""],
    ["POST", "stop"],
    ["POST", "resume"],
  ],
  ["url"],
);
