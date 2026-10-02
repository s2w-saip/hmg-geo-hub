import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// 2026-09-10 핫픽스 회귀 고정 — "필터가 상단 배너 위로 겹친다"(제품 책임자 보고).
//
// 프로덕션 실측(1920×900, /ko/standard/answer-analysis/mention, scrollY 973):
//   banner.bottom = 96 / panel.top = -732.7  → 828.7px 겹침.
// 원인 두 겹:
//   ① 필터 박스가 자기 높이와 같은 `items-stretch` grid 행의 아이템이 되면서
//      (2026-09-09 #231 QA 2차 #10) sticky 이동거리가 0 → 그대로 스크롤돼 올라갔다.
//   ② 배너와 패널이 **같은 z-20** 이라, 동률에서는 DOM 뒤쪽인 패널이 이겼다.
// 이 리포엔 레이아웃 엔진(jsdom 은 sticky 를 계산하지 않는다)이 없으므로 여기서는
// **되돌아가면 즉시 드러나는 계약**만 고정하고, 픽셀은 프리뷰 실측이 본다
// (notes/hmg-perf/filter-banner-overlap.mjs).

const read = (p: string) => readFileSync(p, "utf-8");
const LAYOUT = read("app/[locale]/(dash)/layout.tsx");
const BANNER = read("components/dash/beta-notice.tsx");
const PANEL = read("components/dash/dimension-filter-panel.tsx");
const STANDARD_PAGES = [
  "app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx",
  "app/[locale]/(dash)/standard/answer-analysis/citation/page.tsx",
];
const WEBSITE_PAGES = [
  "app/[locale]/(dash)/website/answer-analysis/mention/page.tsx",
  "app/[locale]/(dash)/website/answer-analysis/citation/page.tsx",
];

/** Tailwind 스페이싱 스케일: n → n * 0.25rem = n * 4px. */
const px = (n: number) => n * 4;

describe("sticky 레이어 — 크롬(헤더+배너) > 본문(필터 패널)", () => {
  const header = LAYOUT.match(/<header className="sticky top-0 (z-\d+) flex (h-\d+)/);
  const banner = BANNER.match(/"sticky top-(\d+) (z-\d+) flex (h-\d+)/);
  const panel = PANEL.match(/sticky && "sticky top-(\d+) (z-\d+)"/);

  it("세 요소의 클래스를 읽을 수 있다 (파싱 실패 = 계약이 움직였다)", () => {
    expect(header).not.toBeNull();
    expect(banner).not.toBeNull();
    expect(panel).not.toBeNull();
  });

  it("배너는 헤더와 같은 크롬 층이고, 본문 패널보다 위다", () => {
    const headerZ = Number(header![1].slice(2));
    const bannerZ = Number(banner![2].slice(2));
    const panelZ = Number(panel![2].slice(2));
    expect(bannerZ).toBe(headerZ); // 헤더·배너 = 한 층
    expect(panelZ).toBeLessThan(bannerZ); // 본문은 절대 크롬 위로 못 올라온다
  });

  it("패널의 sticky 오프셋 = 헤더 높이 + 배너 높이 (틈도 겹침도 없다)", () => {
    const headerH = px(Number(header![2].slice(2)));
    const bannerTop = px(Number(banner![1]));
    const bannerH = px(Number(banner![3].slice(2)));
    const panelTop = px(Number(panel![1]));
    expect(bannerTop).toBe(headerH); // 배너는 헤더 바로 아래
    expect(panelTop).toBe(headerH + bannerH); // 96 = 56 + 40
  });
});

describe("sticky 소유권 — 포함 블록이 자기보다 높은 요소만 sticky 를 갖는다", () => {
  it.each(STANDARD_PAGES)("%s: grid 행 래퍼가 sticky 를 소유한다", (p) => {
    const src = read(p);
    // 필터 박스 행(QA 2차 #10, 2026-09-28 측정 개요 카드 제거 후 한 열). 이 행이 sticky 여야 한다 —
    // 행 안의 패널은 행과 높이가 같아 sticky 가 무력화된다.
    // sticky 는 lg 부터 — 그 아래는 두 열이 세로로 쌓여 뷰포트를 먹는다.
    expect(src).toMatch(/className="grid items-stretch[^"]*lg:sticky lg:top-24 lg:z-20[^"]*"/);
    // 그리고 패널은 sticky 를 갖지 않는다 (소유자는 하나뿐).
    expect(src).toContain("sticky={false}");
  });

  it.each(WEBSITE_PAGES)("%s: 패널이 stretch grid 행 안에 있지 않다", (p) => {
    const src = read(p);
    // 웹사이트 화면의 필터바는 페이지 flex 열의 직접 자식이라 패널이 sticky 를
    // 그대로 소유한다(프로덕션 실측 PASS). 여기에 grid 행을 도입하면 표준 화면과
    // 같은 결함이 재발한다 — 그때는 래퍼로 sticky 를 옮겨야 한다.
    expect(src).not.toContain("grid items-stretch");
  });
});
