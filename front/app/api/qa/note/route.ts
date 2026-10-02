import { NextResponse, type NextRequest } from "next/server";
import {
  MAX_NOTE_BODY,
  guard,
  noteKind as kind,
  noteSeverity as severity,
  readJson,
  str,
} from "@/lib/qa/route-helpers";
import { qaApiSource } from "@/lib/qa/auth";
import { createNote, deleteNote, updateNote } from "@/lib/db/repositories/qa-review";
import { qaApiRoutes } from "@/lib/hgh/adapters/qa";

// 낱알 단위 노트. targetLabel 은 클라이언트가 만들어 보내는 **스냅샷**이다 —
// 재싱크로 scope_citations.id 가 바뀌면 targetKey 만으로는 무엇을 지목했는지
// 알 수 없게 되므로, 사람이 읽을 수 있는 라벨을 함께 굳혀 둔다.
//
// 본문 검증 규칙(kind·severity·4,000자)은 두 원천 공통이라 lib/qa/route-helpers.ts 로 옮겼다(동작 동일).
// HGH_SOURCE_G7=api 면 POST /v1/qa/answers/{id}/notes·PATCH|DELETE /v1/qa/notes/{id} 로 중계한다.
// 백엔드는 본문·severity 수정과 삭제를 작성자에게만 허용한다(403 not_author → {error:"forbidden"}, DC-17).

const MAX_BODY = MAX_NOTE_BODY;

export async function POST(req: NextRequest) {
  if (qaApiSource()) return qaApiRoutes.notePost(req);
  const g = await guard();
  if (!g.ok) return g.response;

  const body = await readJson(req);
  const jobId = str(body.jobId);
  const targetKind = kind(body.targetKind);
  const text = typeof body.body === "string" ? body.body.trim().slice(0, MAX_BODY) : "";
  if (!jobId || !targetKind || !text) {
    return NextResponse.json({ error: "jobId, targetKind, body required" }, { status: 400 });
  }

  const note = await createNote({
    jobId,
    targetKind,
    targetKey: str(body.targetKey),
    targetLabel: str(body.targetLabel),
    severity: severity(body.severity),
    body: text,
    reviewerName: g.reviewer.name,
    sessionId: g.reviewer.sessionId,
  });
  return NextResponse.json({ note });
}

export async function PATCH(req: NextRequest) {
  if (qaApiSource()) return qaApiRoutes.notePatch(req);
  const g = await guard();
  if (!g.ok) return g.response;

  const body = await readJson(req);
  const id = str(body.id);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const note = await updateNote(id, {
    body:
      typeof body.body === "string" ? body.body.trim().slice(0, MAX_BODY) || undefined : undefined,
    severity: body.severity === undefined ? undefined : severity(body.severity),
    resolved: typeof body.resolved === "boolean" ? body.resolved : undefined,
    reviewerName: g.reviewer.name,
  });
  if (!note) return NextResponse.json({ error: "not-found" }, { status: 404 });
  return NextResponse.json({ note });
}

export async function DELETE(req: NextRequest) {
  if (qaApiSource()) return qaApiRoutes.noteDelete(req);
  const g = await guard();
  if (!g.ok) return g.response;
  const id = str((await readJson(req)).id);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteNote(id);
  return NextResponse.json({ ok: true });
}
