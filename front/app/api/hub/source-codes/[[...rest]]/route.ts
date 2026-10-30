import { sourceListProxy } from "../../source-list-proxy";

// Admin › 인용 출처 분류 › 코드표 (2026-10-30): the HUB-owned source code table (back/bff/hub_stores/source_lists.py).
//
//   GET  /api/hub/source-codes                          -> categories and layers next to Gold's dim_category
//   GET  /api/hub/source-codes/history?kind=&code=      -> one code's history (no code: the latest changes)
//   POST /api/hub/source-codes                          -> names and description {kind, code, nameEn, nameKo, description}
//   POST /api/hub/source-codes/order                    -> category order {codes}
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, POST } = sourceListProxy(
  "/v1/hub/source-codes",
  [
    ["GET", ""],
    ["GET", "history"],
    ["POST", ""],
    ["POST", "order"],
  ],
  ["kind", "code"],
);
