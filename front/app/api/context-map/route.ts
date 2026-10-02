import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { scopeContextMapRepository } from "@/lib/db/repositories/scope-context-map";
import type { ContextSortDir } from "@/components/social-scraping/types";
import { hghErrorResponse } from "@/lib/hgh/errors";
import {
  contextMapRouteDenied,
  fetchContextEntityDetail,
  fetchContextMapPage,
  isIntentApi,
} from "@/lib/hgh/adapters/intent";

// GET /api/context-map?tab=contexts|conditions|combinations&search=&sort=&dir=&page=&size=
//   → Paged<…>
// GET /api/context-map?tab=detail&id=<entityId>
//   → ContextEntityDetail | 404
//
// Page-turn + detail-open endpoint for the context map
// (openspec/changes/2026-07-15-add-context-map-query). The first page is
// server-rendered by the route; this handles everything after.
//
// Access: authenticated users who pass the project ROUTES rule (U10-N12 below, both sources;
// before U10 any session). The scope_context_* mirror is a single
// brand-neutral industry corpus — it carries no per-project or per-scope rows,
// so there is nothing here to filter by role. That is why this reads the
// repository directly rather than going through lib/scope/server.ts (which
// gates scope's project-scoped aggregates). If the corpus ever becomes
// project-partitioned, this endpoint needs a project gate.
//
// `page`/`size` are clamped in the repository (clampPaging) — the client cannot
// widen a page back into the 10MB payload this change removed.
//
// Source (D8, unit U10): HGH_SOURCE_G6=api reads /v1/intent/social/context-map/* through
// lib/hgh/adapters/intent.ts (keyset cursor: the client sends `cursor` for page > 0 and gets
// `paged.nextCursor`, decision D5 / C3; a stale or missing cursor answers page 0). On BOTH
// sources, before any backend or mirror read, the route applies the ROUTES rule of the only live
// screen (the project social-scraping page: PROJECT_VIEWERS + menu project) -> 403
// (contextMapRouteDenied, U10-N12, verification D3).

async function apiGet(sp: URLSearchParams): Promise<NextResponse> {
  const tab = sp.get("tab") ?? "contexts";
  const search = sp.get("search")?.trim() || undefined;
  const dir: ContextSortDir = sp.get("dir") === "asc" ? "asc" : "desc";
  const page = Number(sp.get("page") ?? 0);
  const size = Number(sp.get("size") ?? 50);
  const cursor = sp.get("cursor") || null;
  try {
    if (tab === "detail") {
      const id = sp.get("id");
      if (!id) {
        return NextResponse.json({ error: "id is required" }, { status: 400 });
      }
      const detail = await fetchContextEntityDetail(id);
      if (!detail) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, detail });
    }
    if (tab === "contexts" || tab === "conditions") {
      const sort = sp.get("sort") === "name" ? "name" : "mentions";
      const paged = await fetchContextMapPage(tab, { search, sort, dir, page, size, cursor });
      return NextResponse.json({ success: true, paged });
    }
    if (tab === "combinations") {
      const paged = await fetchContextMapPage(tab, { search, sort: "cooccurrence", dir, page, size, cursor });
      return NextResponse.json({ success: true, paged });
    }
    return NextResponse.json({ error: `unknown tab: ${tab}` }, { status: 400 });
  } catch (e) {
    return hghErrorResponse(e) as NextResponse;
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const denied = contextMapRouteDenied(session.user);
  if (denied) return denied as NextResponse;
  if (isIntentApi()) return apiGet(req.nextUrl.searchParams);

  const sp = req.nextUrl.searchParams;
  const tab = sp.get("tab") ?? "contexts";
  const search = sp.get("search")?.trim() || undefined;
  const dir: ContextSortDir = sp.get("dir") === "asc" ? "asc" : "desc";
  const page = Number(sp.get("page") ?? 0);
  const size = Number(sp.get("size") ?? 50);

  try {
    if (tab === "detail") {
      const id = sp.get("id");
      if (!id) {
        return NextResponse.json({ error: "id is required" }, { status: 400 });
      }
      const detail = await scopeContextMapRepository.getEntityDetail(id);
      if (!detail) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, detail });
    }

    if (tab === "contexts" || tab === "conditions") {
      const sort = sp.get("sort") === "name" ? "name" : "mentions";
      const q = { search, sort, dir, page, size } as const;
      const paged =
        tab === "contexts"
          ? await scopeContextMapRepository.listContexts(q)
          : await scopeContextMapRepository.listConditions(q);
      return NextResponse.json({ success: true, paged });
    }

    if (tab === "combinations") {
      const paged = await scopeContextMapRepository.listCombinations({
        search,
        sort: "cooccurrence",
        dir,
        page,
        size,
      });
      return NextResponse.json({ success: true, paged });
    }

    return NextResponse.json({ error: `unknown tab: ${tab}` }, { status: 400 });
  } catch (err) {
    console.error("[context-map] query failed:", err);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
