import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { scopeContextMapRepository } from "@/lib/db/repositories/scope-context-map";
import {
  buildContextMapWorkbook,
  type ContextMapExportLabels,
} from "@/lib/social-scraping/context-map-export";
import { attachmentContentDisposition } from "@/lib/social-scraping/content-disposition";
import { hghErrorResponse } from "@/lib/hgh/errors";
import {
  contextMapRouteDenied,
  exportLang,
  isIntentApi,
  relayContextMapExport,
} from "@/lib/hgh/adapters/intent";

// POST /api/context-map/export  { labels, filename? }  → .xlsx bytes
//
// 구매 맥락 지도 헤더의 "Excel 내보내기" 버튼. 2026-09-03까지 이 버튼은
// 토스트만 띄우는 데모 스텁이었고 파일이 만들어진 적이 없다.
//
// GET 이 아니라 POST 인 이유: 시트명·헤더는 messages/{ko,en}.json 에서 와야 하고
// (경계 #4), 그 라벨 묶음을 쿼리스트링에 실어 나르느니 본문으로 받는다. 쓰기는
// 하지 않는다 — 미러는 불변(마이그레이션 0027)이고 이 라우트는 read+직렬화뿐이다.
//
// 접근: /api/context-map 와 동일하게 인증 사용자 + 프로젝트 ROUTES 규칙(아래 U10-N12, 두 원천 공통;
// U10 전에는 인증 사용자면 통과). scope_context_* 미러는
// 프로젝트·스코프 축이 없는 단일 산업 코퍼스라 여기서 걸 역할 필터가 없다.
// (코퍼스가 프로젝트 분할되면 그 라우트와 함께 이곳에도 게이트가 필요하다.)
//
// 전량(≈9.9k 행)을 한 번에 읽는 유일한 경로다. 내보내기는 정의상 "전부"이고,
// 표에 보이는 얇은 열만 싣기 때문에 상세 fan-out은 없다. 집계는 repository
// (listAllForExport) 안에 있고 화면은 바이트만 받는다.
export const maxDuration = 60;

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isLabels(v: unknown): v is ContextMapExportLabels {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.sheets === "object" &&
    o.sheets !== null &&
    typeof o.cols === "object" &&
    o.cols !== null &&
    typeof o.frequency === "object" &&
    o.frequency !== null
  );
}

// 파일명은 클라이언트가 준다(ko/en 라벨 + 날짜). 헤더 주입 방지와 비 Latin-1
// 안전판(ASCII 폴백 + RFC 5987 filename*)은 attachmentContentDisposition 이 담당 —
// 2026-09-03 프로덕션에서 한글 파일명이 헤더 ByteString 범위를 넘어 500 이 났다.

//
// Source (D8, unit U10): HGH_SOURCE_G6=api streams GET /v1/intent/social/context-map/export
// (lib/hgh/relay.ts, no buffering). The backend builds the workbook with its own sheet names and
// headers (EXPORT_LABELS, equal to messages/{ko,en} today) in the language of body `lang` (C4) or
// the NEXT_LOCALE cookie, so `labels` is not required there (U10-N9); 409 no_active_snapshot is
// passed through (the button shows its error toast). On BOTH sources, before the backend call or
// the mirror read, the route applies the context map's ROUTES rule (project social-scraping page)
// -> 403 (contextMapRouteDenied, U10-N12, verification D3).

async function apiExport(req: NextRequest, body: unknown): Promise<NextResponse> {
  const lang = exportLang((body as { lang?: unknown } | null)?.lang, req.cookies.get("NEXT_LOCALE")?.value);
  try {
    return (await relayContextMapExport(lang)) as NextResponse;
  } catch (e) {
    return hghErrorResponse(e) as NextResponse;
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const denied = contextMapRouteDenied(session.user);
  if (denied) return denied as NextResponse;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (isIntentApi()) return apiExport(req, body);

  const { labels, filename } = (body ?? {}) as Record<string, unknown>;
  if (!isLabels(labels)) {
    return NextResponse.json({ error: "labels are required" }, { status: 400 });
  }

  try {
    const data = await scopeContextMapRepository.listAllForExport();
    const buf = await buildContextMapWorkbook(data, labels);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": XLSX_MIME,
        "Content-Disposition": attachmentContentDisposition(filename),
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[context-map/export] failed:", err);
    return NextResponse.json({ error: "export failed" }, { status: 500 });
  }
}
