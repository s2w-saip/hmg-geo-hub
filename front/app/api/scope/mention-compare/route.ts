import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { hghErrorResponse } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type { ComparePartsScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/mention-screen";

// The website / project mention pages' head-to-head when the user picks a comparison brand: the
// screen mention/view-compare (back/bff/screens/mention_surfaces.py) recomputes the comparison and
// the type stack that follows its target from the same reads as the page (the page's URL filters
// are passed through). Query: the page's search params + target, surface (website | project),
// projectId (project), admin=1 (an admin's website filters include the brand axis).
export const dynamic = "force-dynamic";

const CONTROL = new Set(["surface", "projectId", "admin"]);

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const surface = q.get("surface") === "project" ? "project" : "website";
  const projectId = q.get("projectId");
  if (surface === "project" && !projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(q.keys())) {
    if (CONTROL.has(key)) continue;
    const values = q.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  query["ctx.surface"] = surface;
  if (surface === "project" && projectId) query["ctx.project_id"] = projectId;
  if (q.get("admin") === "1" && session.user.role === "admin") query["ctx.admin"] = "true";
  try {
    return NextResponse.json(await screenGet<ComparePartsScreen>("mention/view-compare", query));
  } catch (err) {
    return hghErrorResponse(err);
  }
}
