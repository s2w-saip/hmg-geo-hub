import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { CitationsStandardView } from "./citations-standard-view";

// 인용 집계가 `null` 일 때 화면이 두 사실을 구분하는가 (E-2 degrade-registry 연계).
//
//   ① 이 필터에 데이터가 없다        → "데이터 없음"
//   ② 집계가 예산에 걸려 못 끝냈다   → "시간 안에 끝나지 않았습니다 · 다른 수치는 정상"
//
// 값으로는 구분이 안 된다(둘 다 `null`) — 그래서 서버의 요청 스코프 표식
// `wasDegraded("standardCitations")` 을 `dataDegraded` 로 받아 분기한다. 종전에는
// ②를 ①로 오독해 "데이터 없음"을 띄웠고, 고객에게는 측정 실패로 보였다.

vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const EMPTY = ko.answerAnalysis.empty;
const DEGRADED = ko.answerAnalysis.mentions.kpi.degraded;

/**
 * 인용 **현황** 블록만 잘라 본다 — 같은 화면의 유형별 구성·우호도 블록도 입력이
 * null 이라 같은 문구를 내므로, 문서 전체에서 문자열을 세면 셋이 섞인다.
 * 경계는 그 블록의 도착 마커(`standard-citation:status`)다.
 */
function statusBlock(html: string): string {
  const end = html.indexOf('data-hmg-section-done="standard-citation:status"');
  expect(end, "인용 현황 블록의 마커를 못 찾았다").toBeGreaterThan(0);
  return html.slice(0, end);
}

function render(dataDegraded: boolean | undefined) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <CitationsStandardView
        data={null}
        prevSubKpis={null}
        prevBasisDate={null}
        typeCategories={null}
        toneSummary={null}
        dataDegraded={dataDegraded}
      />
    </NextIntlClientProvider>,
  );
}

describe("인용 현황 — 예산 초과를 '데이터 없음'으로 오독하지 않는다", () => {
  it("degrade 표식이 있으면 지연 안내를 띄운다", () => {
    const block = statusBlock(render(true));
    expect(block).toContain(DEGRADED);
    expect(block).not.toContain(EMPTY);
  });

  it("표식이 없으면 종전대로 '데이터 없음'", () => {
    const block = statusBlock(render(false));
    expect(block).toContain(EMPTY);
    expect(block).not.toContain(DEGRADED);
  });

  it("prop 자체가 없어도 종전 동작(데이터 없음)이 기본값이다", () => {
    const block = statusBlock(render(undefined));
    expect(block).toContain(EMPTY);
    expect(block).not.toContain(DEGRADED);
  });
});
