import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// T18 섹션 도착 마커 — 배치 규칙 가드.
//
// ── 왜 규칙이 바뀌었나 (2026-09-10 T12 프리뷰 스트림 포렌식) ──────────────────
// 종전 규칙은 "마커를 <Suspense> 경계 안, async 자식의 **형제**로 둔다" 였다.
// 그런데 React 19 는 자식이 서스펜드하면 그 자리에 `<template id="P:n">` 자리표시를
// 놓고 경계를 **먼저 flush** 한다 — 형제인 마커도 그 빈 세그먼트에 실려 나간다.
// 실제 내용은 나중에 `$RS("S:x","P:n")` 로 채워진다. 배포 HTML 실측:
//
//   <div hidden id="S:3"><template id="P:7"></template>
//     <div hidden data-hmg-section-done="dashboard:kpi-cards"></div></div>
//   … 32.9 s 뒤 … <script>$RS("S:7","P:7")</script>
//
//   dashboard:kpi-cards  마커 662 ms  vs  실제 32,855 ms (49배)
//   website:trend        마커 878 ms  vs  실제 25,161 ms
//
// ── 새 규칙 ────────────────────────────────────────────────────────────────
// 마커는 **데이터를 await/use 하는 그 컴포넌트가 반환하는 JSX 안**에 둔다. 그래야
// 마커가 `$RS` 로 채워지는 바로 그 세그먼트에 들어간다.
//
// ── 이 파일이 검사하는 것 ──────────────────────────────────────────────────
//  1. 금지 형태: `<SectionDoneMarker>` 가 `<Suspense>` 의 직속 자식인 경우.
//  2. 마커 목록(파일별 id 집합).
//  3. React 계약: 두 배치의 스트림 산출을 **실제로 렌더해** 대조한다
//     (section-marker.contract.test.tsx).
//
// 한계: 여기서는 소스만 본다. 페이지 전체를 렌더한 HTML 에 대한 최종 확인은
// `next build && next start` 스트림 실측이며, 그 절차는 tools/hmg-perf-probe/README.md.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PAGE_DASHBOARD = "app/[locale]/(dash)/dashboard/page.tsx";
const PAGE_WEBSITE = "app/[locale]/(dash)/website/page.tsx";
const PAGE_STD_MENTION = "app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx";
const PAGE_STD_CITATION = "app/[locale]/(dash)/standard/answer-analysis/citation/page.tsx";
const PAGE_WEB_MENTION = "app/[locale]/(dash)/website/answer-analysis/mention/page.tsx";
const PAGE_WEB_CITATION = "app/[locale]/(dash)/website/answer-analysis/citation/page.tsx";
const CMP_MENTION_KPI =
  "app/[locale]/(dash)/standard/answer-analysis/_components/kpi/mention-kpi-tab.tsx";
const CMP_CITATION_VIEW =
  "app/[locale]/(dash)/standard/answer-analysis/_components/citations-standard-view.tsx";
const CMP_LAST_MEASURED = "components/dash/last-measured-pill.tsx";

/** 파일 → 그 파일이 내는 마커 id 집합. */
const MARKERS: Record<string, string[]> = {
  [PAGE_DASHBOARD]: [
    "dashboard:last-measured",
    "dashboard:filters",
    "dashboard:kpi-cards",
    // 카드 안의 지연 슬롯(Δ 배지·스파크라인 / 경쟁사 행)과 **같은 프로미스**를
    // 기다리는 지면 없는 경계. 카드가 5번 반복돼 슬롯마다 마커를 달면 id 가
    // 중복되므로, 도착 시각은 이 둘이 대신 잡는다(E-1, 2026-09-10).
    "dashboard:kpi-extras",
    "dashboard:kpi-competitors",
    "dashboard:geo",
  ],
  [PAGE_WEBSITE]: [
    "website:filters",
    "website:as-of",
    "website:summary",
    // 타일 안쪽 지연 슬롯(엔진 일관성 배지·Δ)과 **같은 프로미스**를 기다리는 지면 없는
    // 경계. `website:summary` 는 **타일 도착**만 잡는다 — 둘을 한 마커로 두면 배지가
    // 미러(11.5~13.5 s)일 때 타일 도착 시각이 그만큼 과대 계측된다(PR③-a, 2026-09-10).
    // 대시보드의 `dashboard:kpi-extras`·`kpi-competitors` 와 같은 등급이다.
    "website:summary-deltas",
    "website:trend",
    "website:composition",
    "website:geo",
  ],
  [PAGE_STD_MENTION]: [
    "standard-mention:filters",
    "standard-mention:data",
  ],
  [CMP_MENTION_KPI]: [
    "standard-mention:kpi-hero",
    "standard-mention:kpi-hero-delta",
    "standard-mention:kpi-hero-competitors",
    "standard-mention:kpi-hero-trend",
    "standard-mention:kpi-competitor",
    "standard-mention:kpi-engine",
    "standard-mention:kpi-type",
    "standard-mention:kpi-type-trend",
  ],
  [PAGE_STD_CITATION]: [
    "standard-citation:filters",
    // 2026-09-10 QA 2차 #2 — `standard-citation:chips` 는 사라졌다. 칩 행(필터 박스
    // footerSlot)이 통째로 없어지고 출처 카테고리·경쟁사가 필터 패널 축으로 돌아갔다.
    // 2026-09-28 — `standard-citation:overview`·`standard-mention:overview` 도 사라졌다
    // (측정 개요 카드 제거).
  ],
  [CMP_CITATION_VIEW]: [
    "standard-citation:status",
    "standard-citation:category",
    "standard-citation:engine",
    "standard-citation:type",
    "standard-citation:tone",
    "standard-citation:domains",
  ],
  [CMP_LAST_MEASURED]: ["last-measured-pill"],
  [PAGE_WEB_MENTION]: ["website-mention:filters", "website-mention:data"],
  [PAGE_WEB_CITATION]: ["website-citation:filters", "website-citation:data"],
};

const FILES = Object.keys(MARKERS);
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
/**
 * The ids a file emits: literal `<SectionDoneMarker id="…">`, plus the ids a section passes down as a
 * `marker="…"` prop (the dashboard's DeferredNotice renders `<SectionDoneMarker id={marker} />` after
 * the promise its card slots wait for).
 */
const idsIn = (rel: string) => {
  const src = stripComments(read(rel));
  return [
    ...new Set([
      ...[...src.matchAll(/<SectionDoneMarker id="([^"]+)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/\smarker="([^"]+)"/g)].map((m) => m[1]),
    ]),
  ];
};

/**
 * 금지 형태 탐지 — 마커가 `<Suspense>` 의 **직속 자식**인가.
 * 이 코드베이스의 실제 형태는 언제나 "경계의 마지막 자식"이었으므로, 마커 뒤의
 * 첫 태그가 `</Suspense>` 인지 본다. 더불어 마커 **앞**의 첫 태그가 `<Suspense …>`
 * 인 경우(첫 자식)도 함께 잡는다.
 */
function suspenseChildMarkers(rel: string): string[] {
  return suspenseChildMarkersIn(stripComments(read(rel)));
}

export function suspenseChildMarkersIn(src: string): string[] {
  const bad: string[] = [];
  for (const m of src.matchAll(/<SectionDoneMarker id="([^"]+)"[^>]*\/>/g)) {
    const after = src.slice(m.index + m[0].length);
    const nextTag = /<\/?[A-Za-z]/.exec(after);
    if (nextTag && after.slice(nextTag.index).startsWith("</Suspense>")) bad.push(m[1]);
    const before = src.slice(0, m.index);
    if (/<Suspense[^>]*>\s*$/.test(before)) bad.push(m[1]);
  }
  return [...new Set(bad)];
}

describe("T18 마커 배치 규칙 — <Suspense> 직속 자식 금지", () => {
  for (const file of FILES) {
    it(`${file}`, () => {
      // React 19 가 이 자리의 마커를 `<template id="P:n">` 과 같은 세그먼트로
      // 먼저 내보낸다 → 도착 시각이 자릿수로 과소 계측된다. 마커는 데이터를
      // await/use 하는 컴포넌트의 **반환 JSX 안**으로 내려라.
      expect(suspenseChildMarkers(file)).toEqual([]);
    });
  }
});

describe("T18 배치 규칙 탐지기 — 음성/양성 대조", () => {
  it("금지 형태(경계의 마지막 자식)를 잡는다", () => {
    // 2026-09-10 이전의 실제 코드 형태. 이것이 49배 과소 계측의 원인이었다.
    const broken = `
      <Suspense fallback={<Skeleton />}>
        <KpiCardsSection filters={filters} />
        <SectionDoneMarker id="dashboard:kpi-cards" />
      </Suspense>`;
    expect(suspenseChildMarkersIn(broken)).toEqual(["dashboard:kpi-cards"]);
  });

  it("금지 형태(경계의 첫 자식)도 잡는다", () => {
    const broken = `
      <Suspense fallback={null}>
        <SectionDoneMarker id="x:y" />
        <Thing />
      </Suspense>`;
    expect(suspenseChildMarkersIn(broken)).toEqual(["x:y"]);
  });

  it("올바른 형태(반환 JSX 안)는 통과한다", () => {
    const ok = `
      async function KpiCardsSection() {
        const live = await getLiveDashboard(filters);
        return (
          <section>
            <OverviewKpiCards kpis={live.kpis} />
            <SectionDoneMarker id="dashboard:kpi-cards" />
          </section>
        );
      }`;
    expect(suspenseChildMarkersIn(ok)).toEqual([]);
  });
});

describe("T18 마커 목록", () => {
  for (const [file, ids] of Object.entries(MARKERS)) {
    it(`${file} — ${ids.length}개`, () => {
      expect(idsIn(file).sort()).toEqual([...ids].sort());
    });
  }

  it("id 는 전역에서 유일하다", () => {
    const all = Object.values(MARKERS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("마커를 둔 파일은 이 표에 전부 등재돼 있다", () => {
    const found = ["app/[locale]/(dash)", "components"].flatMap(filesWithMarkers);
    expect(found.filter((f) => !FILES.includes(f) && !f.includes(".test."))).toEqual([]);
  });

  it("셸 마커는 더 이상 없다 — 모든 마커가 데이터 세그먼트에 있다", () => {
    expect(Object.values(MARKERS).flat().filter((id) => id.endsWith("-shell"))).toEqual([]);
  });
});

function filesWithMarkers(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(join(ROOT, d))) {
      const rel = `${d}/${e}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (e.endsWith(".tsx") && read(rel).includes("<SectionDoneMarker id="))
        out.push(rel);
    }
  };
  walk(dir);
  return out;
}
