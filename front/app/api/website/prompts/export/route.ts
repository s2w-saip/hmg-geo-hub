import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "@/i18n/routing";
import { getSession } from "@/lib/auth/session";
import { listWebsitePromptsForExport } from "@/lib/db/repositories/website-sites";
import {
  readWebsitePromptQuery,
  searchParamsToRecord,
} from "@/lib/website/prompt-query";
import { buildWebsitePromptSheet } from "@/lib/website/prompt-export";
import { buildXlsxBuffer, XLSX_MIME } from "@/lib/export/xlsx-server";
import { attachmentContentDisposition } from "@/lib/social-scraping/content-disposition";
import { countryName } from "@/lib/geo-catalog/country-name";
import { languageName } from "@/lib/geo-catalog/language-name";
import { canReadAnalysis, isAnalysisApi } from "@/lib/hgh/adapters/filters";
import { relayWebsitePromptsExport } from "@/lib/hgh/adapters/catalog";
import { hghErrorResponse } from "@/lib/hgh/errors";

// GET /api/website/prompts/export?<화면과 동일한 필터>&locale=ko  → .xlsx bytes
//
// 2026-09-11 고객 요청(이노션): "웹사이트 > 프롬프트에서 화면에 보여지는 리스트를
// 엑셀로 내려받기. 필터를 걸면 그 필터의 국가-언어에 맞는 프롬프트만."
//
// 왜 라우트인가 — 이 화면은 **서버 페이징**(PAGE_SIZE=50, website_prompts 1만행대)
// 이라 클라이언트에는 50행뿐이다. 글로벌(표준) 화면처럼 메모리 배열을 직렬화할
// 수 없어 서버가 같은 술어로 다시 질의해야 한다. 파생은 화면과 **같은 함수**
// (readWebsitePromptQuery)만 쓴다 — 두 벌이 되면 화면과 엑셀이 갈린다.
//
// 왜 GET 인가(제품 결정 2026-09-16) — 다운로드를 평범한 링크로 유지한다. 라벨은
// 쿼리로 나르지 않고 `?locale=` 만 받아 서버가 getTranslations 로 읽는다
// (경계 #4: UI 문자열은 messages/{ko,en}.json 에서만). 구매 맥락 지도 내보내기의
// POST+labels 방식은 이 화면에서는 기각됐다.
//
// 쓰기 없음 — 미러 읽기 + 직렬화뿐이다.
//
// 원천 스위치(결정 D8, U8): HGH_SOURCE_G3=api 면 같은 파생(readWebsitePromptQuery)으로
// GET /v1/prompts?surface=website&format=xlsx&columns=screen&locale 를 **버퍼 없이 중계**한다
// (결정 D7, lib/hgh/relay.ts). 파일은 백엔드가 현행 8열·라벨·표시명으로 만든다(BG-35).
// 파일 이름만 현행 규칙(<i18n stem>-YYYY-MM-DD.xlsx, KST)으로 덮어 두 원천이 같게 한다.
// 게이트는 두 원천 모두 아래 3인자 검사(canReadAnalysis)가 먼저다. 백엔드 오류는 상태를 그대로, 본문은 {error:{code}}(Content-Disposition 없음:
// 브라우저가 파일이 아니라 오류를 보여 준다, export-button.tsx 주석).
export const runtime = "nodejs";

// 1만행 규모 × 8열 직렬화. 상한은 넉넉히 두되 무제한은 두지 않는다.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ⚠️ 3번째 인자(menuGroups)를 반드시 넘긴다. 빼면 groupAllowed 가 무조건 true 를
  // 돌려줘(route-policy.ts:335-338) **계정별 메뉴 화이트리스트가 통째로 무력화**된다.
  // 페이지가 2인자로 부르는 것은 DashLayout(layout.tsx:121)이 이미 3인자로 판정한
  // 뒤이기 때문인데, 라우트 핸들러에는 그 레이아웃이 없다 — 여기가 유일한 게이트다.
  // canReadAnalysis(user, "prompts", "website") = canAccessRoute(role, "/website/prompts",
  // menuGroups): the same 3-argument check, shared with the other analysis BFF routes (U4).
  if (!canReadAnalysis(session.user, "prompts", "website")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const rawLocale = url.searchParams.get("locale");
  const locale = hasLocale(routing.locales, rawLocale)
    ? rawLocale
    : routing.defaultLocale;

  if (isAnalysisApi("prompts", "website")) {
    try {
      const sp = searchParamsToRecord(url.searchParams);
      const isAdmin = session.user.role === "admin";
      const { filters, sort, dir } = readWebsitePromptQuery(sp, session.user.scope, isAdmin);
      const [t, upstream] = await Promise.all([
        getTranslations({ locale, namespace: "website.prompts" }),
        relayWebsitePromptsExport({ filters, sort, dir }, session.user.scope ?? null, locale),
      ]);
      upstream.headers.set(
        "Content-Disposition",
        attachmentContentDisposition(exportFilenameFor(t("exportFilename"))),
      );
      return upstream;
    } catch (err) {
      return hghErrorResponse(err);
    }
  }

  try {
    const sp = searchParamsToRecord(url.searchParams);
    const isAdmin = session.user.role === "admin";
    const { filters, sort, dir } = readWebsitePromptQuery(sp, session.user.scope, isAdmin);

    const [t, { rows, truncated }] = await Promise.all([
      getTranslations({ locale, namespace: "website.prompts" }),
      listWebsitePromptsForExport(session.user.scope, filters, { sort, dir }),
    ]);

    const sheet = buildWebsitePromptSheet(
      rows,
      {
        prompt: t("promptLabel"),
        brand: t("brandLabel"),
        country: t("countryLabel"),
        lang: t("langLabel"),
        targetUrl: t("targetUrlLabel"),
        answers: t("answersLabel"),
        lastMeasured: t("lastMeasuredLabel"),
        engines: t("enginesLabel"),
        notMeasured: t("notMeasured"),
      },
      {
        country: (code) => countryName(code, locale),
        language: (code) => languageName(code, locale),
      },
    );

    const buf = await buildXlsxBuffer(sheet.headers, sheet.rows, t("exportSheetName"));
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": XLSX_MIME,
        // 한글 파일명을 헤더에 직접 조립하지 않는다 — HTTP 헤더는 ByteString 이라
        // 2026-09-03 프로덕션에서 그대로 500 이 났다(content-disposition.ts 머리 주석).
        "Content-Disposition": attachmentContentDisposition(
          exportFilenameFor(t("exportFilename")),
        ),
        "Content-Length": String(buf.byteLength),
        // 필터·스코프별로 내용이 다르고 개인 스코프가 걸린 데이터다 — 캐시 금지.
        "Cache-Control": "no-store",
        // 상한(WEBSITE_PROMPT_EXPORT_MAX_ROWS)에 닿았음을 알리는 헤더.
        // ⚠️ 정직하게 적어둔다 — 실사용 경로는 <a href> 라 **사용자에게는 이
        // 헤더가 보이지 않는다.** 소비자는 이 라우트를 직접 부르는 프로그래매틱
        // 호출(운영 스크립트·헬스체크)뿐이다. 그래도 남기는 이유: 상한에 닿는
        // 상황은 정의상 "전량이 아닌 파일이 나갔다"라서, 사후에 그 사실을 알
        // 수 있는 흔적이 응답 어딘가에는 있어야 한다. 사용자 가시 경로가
        // 필요해지면 그때는 fetch 기반 다운로드로 바꿔야 하고, 그것은 GET 링크
        // 유지(제품 책임자 2026-09-16) 결정을 뒤집는 일이라 별도 판단 사안이다.
        ...(truncated ? { "X-Export-Truncated": "true" } : {}),
      },
    });
  } catch (err) {
    console.error("[website/prompts/export] failed:", err);
    return NextResponse.json({ error: "export failed" }, { status: 500 });
  }
}

// `<stem>-YYYY-MM-DD.xlsx` — 날짜는 서비스 기준 시간대(KST)의 달력일.
// 서버는 UTC(Vercel)라 그냥 toISOString 을 쓰면 한국 자정 부근에 하루 어긋난다.
function exportFilenameFor(stem: string): string {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return `${stem}-${day}.xlsx`;
}
