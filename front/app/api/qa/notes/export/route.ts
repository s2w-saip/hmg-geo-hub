import { NextResponse, type NextRequest } from "next/server";
import { guard } from "@/lib/qa/route-helpers";
import { parseQaNoteFilter } from "@/lib/qa/filters";
import { qaApiSource } from "@/lib/qa/auth";
import { listAllNotes, type QaNoteRow } from "@/lib/db/repositories/qa-review";
import { qaApiRoutes } from "@/lib/hgh/adapters/qa";

// 개발팀에 넘길 산출물. 현재 화면과 **같은 필터**를 받아 같은 집합을 낸다 —
// 브라우저는 이 URL 로 이동만 하면 되므로 클라이언트가 만 행짜리 blob 을 들 필요가 없다.
//
// HGH_SOURCE_G7=api 면 GET /v1/qa/notes/export 스트림을 버퍼 없이 중계한다(relayDownload).
// 열 머리글·순서·파일명·상한 10,000행은 같고, 값은 백엔드 core.export 규칙을 따른다: 수식 주입 방지
// 작은따옴표 접두(DC-17), surface 열 global, 시각은 오프셋 붙은 ISO, 행마다 CRLF.

export const runtime = "nodejs";
export const maxDuration = 120;

const HEADER = [
  "created_at",
  "reviewer",
  "job_id",
  "target_kind",
  "target_key",
  "target_label",
  "severity",
  "body",
  "prompt",
  "surface",
  "resolved_at",
  "resolved_by",
] as const;

function cell(v: unknown): string {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(n: QaNoteRow): string {
  return [
    n.createdAt,
    n.reviewerName,
    n.jobId,
    n.targetKind,
    n.targetKey,
    n.targetLabel,
    n.severity,
    n.body,
    n.promptText,
    n.surface,
    n.resolvedAt,
    n.resolvedBy,
  ]
    .map(cell)
    .join(",");
}

export async function GET(req: NextRequest) {
  if (qaApiSource()) return qaApiRoutes.notesExport(req);
  const g = await guard();
  if (!g.ok) return g.response;

  // 반복 파라미터를 배열로 모은다 — 검수자 이름에 콤마가 들어갈 수 있어
  // Object.fromEntries 로 뭉개면 필터가 달라진다.
  const raw: Record<string, string[]> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    (raw[k] ??= []).push(v);
  });

  const notes = await listAllNotes(parseQaNoteFilter(raw));
  const csv = [HEADER.join(","), ...notes.map(row)].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);

  // 선두 BOM — 없으면 Excel 이 UTF-8 CSV 의 한글을 깨뜨린다.
  return new NextResponse("\uFEFF" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="qa-notes-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
