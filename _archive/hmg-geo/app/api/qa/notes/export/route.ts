import { NextResponse, type NextRequest } from "next/server";
import { guard } from "@/lib/qa/route-helpers";
import { parseQaNoteFilter } from "@/lib/qa/filters";
import { listAllNotes, type QaNoteRow } from "@/lib/db/repositories/qa-review";

// 개발팀에 넘길 산출물. 현재 화면과 **같은 필터**를 받아 같은 집합을 낸다 —
// 브라우저는 이 URL 로 이동만 하면 되므로 클라이언트가 만 행짜리 blob 을 들 필요가 없다.

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
