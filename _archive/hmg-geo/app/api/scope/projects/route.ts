import { NextRequest, NextResponse } from "next/server";
import { listProjects, UnauthorizedError } from "@/lib/scope/server";

// BFF passthrough for the scope project list. The workspace key is attached
// server-side inside the enforcement layer (listProjects); the browser only
// ever talks to this route, never to scope directly (scope-gateway spec).
//
// Replaces the former /api/scope/results route: scope's workspace-wide results
// feed (/results) is internal-only now. Public reads are project-scoped, so the
// project list is the workspace-level entry point a client starts from.
export async function GET(req: NextRequest) {
  try {
    const limitParam = req.nextUrl.searchParams.get("limit");
    const cursor = req.nextUrl.searchParams.get("cursor") ?? undefined;
    const limit = limitParam ? Number(limitParam) : undefined;
    const page = await listProjects({ limit, cursor });
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
}
