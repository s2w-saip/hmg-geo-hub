import { describe, expect, it, vi } from "vitest";

// 라우터 훅 — 테스트 렌더러에는 Next 라우터가 없어 usePathname 이 null 을 낸다
// (SignalPromptsDialog 가 pathname.includes 로 표면을 판정한다). 분할과 무관한
// 환경 차이라 표준 표면 경로로 고정한다.
vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/mention",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { MentionsLive } from "@/lib/scope/result-adapter";
import type { MentionSubKpis } from "../_data/sub-kpis";
import {
  MentionsRankSection,
  MentionsSummarySection,
  MentionsTrendSection,
  MentionsView,
} from "./mentions-view";

// 2026-09-03 구획 분할의 **렌더 실측**. 정적 검사가 아니라 실제 렌더러
// (react-dom/server)로 마크업을 뽑아 확인한다.
//
// 이 분할의 고유 위험은 "한 컴포넌트 안에서 공유하던 state·memo 를 세 구획으로
// 갈랐다"는 것이다 — 갈라진 구획이 자기 것이 아닌 변수를 참조하면 렌더가 죽는다.
// 그래서 ① 각 구획을 **단독으로**(페이지의 별도 <Suspense> 경계와 같은 조건)
// 렌더하고, ② 통짜 MentionsView(website/project 표면)가 세 구획을 이어 붙여도
// 분할 전과 같은 지면을 내는지 본다.

const TREND = {
  series: ["Hyundai", "Kia"],
  points: [
    { week: "2026-08-18", Hyundai: 12, Kia: 8 },
    { week: "2026-08-25", Hyundai: 15, Kia: 7 },
  ],
};

const DATA: MentionsLive = {
  summary: { total: 42, uniqueBrands: 3, totalPrompts: 20 },
  asOf: "2026-09-01",
  brands: [
    { brand: "Hyundai", mentions: 20, prompts: 12, share: 47.6, mentionRate: 60, avgPosition: 2.1, isTracked: true },
    { brand: "Toyota", mentions: 14, prompts: 9, share: 33.3, mentionRate: 45, avgPosition: 2.8, isTracked: false },
    { brand: "Kia", mentions: 8, prompts: 6, share: 19.1, mentionRate: 30, avgPosition: 3.4, isTracked: false },
  ],
  perBrandPrompts: {},
  sentimentTotals: { positive: 10, neutral: 6, negative: 2, mixed: 1 },
  typeTotals: { mention: 8, recommendation: 5, comparison: 4, definition: 2, final_choice: 1 },
  typesByBrand: null,
  hasPosition: true,
  trend: TREND,
};

const SUB: MentionSubKpis = {
  missingPrompts: 4,
  multiMentionAnswers: 6,
  top3Rate: 55.5,
  top3Count: 5,
  top3Base: 9,
  positiveKeywords: 7,
  negativeKeywords: 2,
  ownMentionRate: 61.2,
  totalMentions: 42,
  measuredPrompts: 20,
};

const PREV: MentionSubKpis = { ...SUB, multiMentionAnswers: 4, top3Rate: 50.0, totalMentions: 38 };

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("언급 본문 구획 — 단독 렌더", () => {
  it("① 요약 구획은 카드 6장 + 비교 기준일 + 감정/유형을 자기만으로 그린다", () => {
    const html = render(
      <MentionsSummarySection data={DATA} subKpis={SUB} prevSubKpis={PREV} prevBasisDate="2026-08-25" />,
    );
    expect(html).toContain(ko.answerAnalysis.mentions.summary.total);
    expect(html).toContain(ko.answerAnalysis.mentions.summary.missingPrompts);
    expect(html).toContain(ko.answerAnalysis.mentions.summary.top3Rate);
    // Δ 기준일 캡션 — 직전 스냅샷이 있을 때만.
    expect(html).toContain("2026-08-25");
    // 헤드투헤드 + 감정/유형이 이 구획에 있다.
    expect(html).toContain(ko.answerAnalysis.mentions.compare.title);
    expect(html).toContain(ko.answerAnalysis.mentions.breakdown.sentimentTitle);
  });

  it("② 추이 구획은 Sub KPI 없이 그려진다 — 언급 집계만 기다린다는 증거", () => {
    const html = render(<MentionsTrendSection data={DATA} />);
    expect(html).toContain(ko.answerAnalysis.mentions.trend.title);
    // 요약 카드는 이 구획 소관이 아니다(지면이 겹치면 화면에 두 번 나온다).
    expect(html).not.toContain(ko.answerAnalysis.mentions.summary.missingPrompts);
  });

  it("③ 순위표 구획도 Sub KPI 없이 그려지고 전 브랜드 행을 낸다", () => {
    const html = render(<MentionsRankSection data={DATA} lazyPrompts />);
    expect(html).toContain(ko.answerAnalysis.mentions.table.title);
    for (const b of ["Hyundai", "Toyota", "Kia"]) expect(html).toContain(b);
    expect(html).not.toContain(ko.answerAnalysis.mentions.compare.title);
  });

  it("빈 상태의 지면은 ① 만 소유한다 — ②③ 은 스스로 사라진다", () => {
    expect(render(<MentionsSummarySection data={null} />)).toContain(ko.answerAnalysis.empty);
    expect(render(<MentionsTrendSection data={null} />)).toBe("");
    expect(render(<MentionsRankSection data={null} />)).toBe("");
  });
});

// ── B035 — API 원천의 일시 실패 고지 (website/project) ────────────────────────
//
// 페이지가 요청 스코프 표식(mentionsDegraded)을 읽어 `degraded` 로 넘긴다. 참인 자리만 기존
// `kpi.degraded`(추이는 `kpi.degradedTrend`) 문구로 바뀌고, 정상 경로 마크업은 그대로다.
describe("B035 일시 실패 고지", () => {
  const kpi = ko.answerAnalysis.mentions.kpi;
  const ALL_FALSE = { data: false, types: false, subKpis: false };

  it("정상 경로(표식 전부 false)는 표식 미전달과 바이트 단위로 같다", () => {
    const props = { data: DATA, subKpis: SUB, prevSubKpis: PREV, prevBasisDate: "2026-08-25", hideFilterPanel: true };
    expect(render(<MentionsView {...props} degraded={ALL_FALSE} />)).toBe(render(<MentionsView {...props} />));
    expect(render(<MentionsView {...props} />)).not.toContain(kpi.degraded);
  });

  it("본문 실패(data null)는 '데이터 없음' 대신 기존 degraded 문구", () => {
    for (const html of [
      render(<MentionsView data={null} degraded={{ data: true }} />),
      render(<MentionsSummarySection data={null} degraded={{ data: true }} />),
    ]) {
      expect(html).toContain(kpi.degraded);
      expect(html).not.toContain(ko.answerAnalysis.empty);
    }
    // 표식이 없으면 종전 빈 상태
    expect(render(<MentionsView data={null} />)).toContain(ko.answerAnalysis.empty);
  });

  it("유형 조회 실패는 유형 카드의 '준비 중' 대신 degraded 문구", () => {
    const noTypes = { ...DATA, typeTotals: null };
    const failed = render(<MentionsSummarySection data={noTypes} degraded={{ types: true }} />);
    expect(failed).toContain(kpi.degraded);
    expect(failed).not.toContain(ko.answerAnalysis.pending);
    expect(render(<MentionsSummarySection data={noTypes} />)).toContain(ko.answerAnalysis.pending);
  });

  it("Sub KPI·Δ 실패는 카드 그리드 아래 캡션 자리에 degraded 문구 한 줄", () => {
    const failed = render(<MentionsSummarySection data={DATA} subKpis={null} degraded={{ subKpis: true }} />);
    expect(failed).toContain(`<p class="-mt-3 text-[11px] text-muted-foreground">${kpi.degraded}</p>`);
    expect(render(<MentionsSummarySection data={DATA} subKpis={null} />)).not.toContain(kpi.degraded);
  });

  it("측정 프롬프트 수 null(요약 실패)은 0 이 아니라 '—'", () => {
    // 카드 라벨 뒤 첫 값 칸(SummaryCard 의 큰 숫자)
    const valueOf = (html: string) => {
      const card = html.slice(html.indexOf(ko.answerAnalysis.mentions.summary.totalPrompts));
      return card.match(/font-head text-xl font-semibold tracking-tight tabular-nums text-foreground">([^<]*)</)?.[1];
    };
    expect(valueOf(render(<MentionsSummarySection data={{ ...DATA, summary: { ...DATA.summary, totalPrompts: null } }} />))).toBe("—");
    // 정상 값은 종전 그대로(20)
    expect(valueOf(render(<MentionsSummarySection data={DATA} />))).toBe("20");
  });

  it("추이 실패(trendDegraded)는 '준비 중' 대신 degradedTrend — 표준 공통 하단과 같은 판정", () => {
    const failed = render(<MentionsTrendSection data={{ ...DATA, trend: null, trendDegraded: true }} />);
    expect(failed).toContain(kpi.degradedTrend);
    expect(failed).not.toContain(ko.answerAnalysis.pending);
    // 2주 미만(실패 아님)은 종전 '준비 중'
    expect(render(<MentionsTrendSection data={{ ...DATA, trend: null }} />)).toContain(ko.answerAnalysis.pending);
  });
});

// ── B039 — 전량 목록 절단 표식(순위표 구획) ─────────────────────────────────────
describe("B039 순위표 절단 한 줄", () => {
  const cut = (shown: number, total: number) =>
    ko.answerAnalysis.mentions.kpi.overview.unmeasuredDialog.truncated
      .replace("{total}", String(total))
      .replace("{shown}", String(shown));

  it("잘린 목록이면 '{total}개 중 {shown}개 표시', 안 잘렸으면 마크업 그대로", () => {
    const html = render(<MentionsRankSection data={{ ...DATA, brandsTotal: 12000 }} />);
    expect(html).toContain(cut(3, 12000));
    expect(render(<MentionsRankSection data={DATA} />)).not.toContain(cut(3, 12000));
    expect(render(<MentionsRankSection data={DATA} />)).toBe(render(<MentionsRankSection data={{ ...DATA, brandsTotal: undefined }} />));
  });
});

describe("통짜 MentionsView — 분할 전과 같은 지면", () => {
  it("website/project 표면은 세 구획을 이어 붙여 전과 같은 화면을 낸다", () => {
    const html = render(
      <MentionsView data={DATA} subKpis={SUB} prevSubKpis={PREV} prevBasisDate="2026-08-25" hideFilterPanel />,
    );
    for (const label of [
      ko.answerAnalysis.mentions.summary.total,
      ko.answerAnalysis.mentions.summary.missingPrompts,
      ko.answerAnalysis.mentions.compare.title,
      ko.answerAnalysis.mentions.breakdown.sentimentTitle,
      ko.answerAnalysis.mentions.trend.title,
      ko.answerAnalysis.mentions.table.title,
    ]) {
      expect(html).toContain(label);
    }
    // 지면이 중복되지 않는다 — 각 구획이 자기 것만 그린다.
    const count = (s: string) => html.split(s).length - 1;
    expect(count(ko.answerAnalysis.mentions.table.title)).toBe(1);
    expect(count(ko.answerAnalysis.mentions.trend.title)).toBe(1);
  });
});
