import { describe, it, expect } from "vitest";
import {
  foldCitationsLive,
  type CitDomainGroupRow,
  type CitDomainStatRow,
  type CitUrlRow,
  type CitPromptRow,
  type CitPromptRefRow,
  type CitSplitPromptRow,
  type CitSplitRefRow,
} from "./scope-aggregates";
import {
  aggregateCitationsFrom,
  type StandardFilters,
  type CitationsLive,
  type CitationPromptLive,
} from "@/lib/scope/result-adapter";
import type {
  CitationCategory,
  CitationOverrideMap,
} from "@/lib/citation-categorizer";
import { ownedBaseEntryForUrl } from "@/lib/geo-catalog/owned";
import type { MeasurementJob, QueryRunView, ScopeCitation } from "@/lib/scope/types";

// 인용 집계 SQL 전환(2026-07-22)의 판정 동등성 안전망.
// 같은 원자료(잡/인용)를 두 경로로 굴린다:
//  (a) 종전 JS 경로 — aggregateCitationsFrom (live 경로와 공유되는 순수 변환)
//  (b) 신규 SQL 경로 — DB 가 반환할 GROUP BY 행을 여기서 동일 규칙으로 재현해
//      foldCitationsLive 에 투입
// 요약·도메인 통계·카테고리·엔진 구성·드릴다운이 모두 일치해야 한다.
// (SQL 텍스트 자체의 정합 — 정규화·owned predicate — 은
// scope-aggregates.urlmatch.test.ts 의 SQL↔JS 왕복 검증이 담당.)

interface FixtureCitation {
  jobId: string;
  url: string;
  domain: string;
  title: string;
  category?: string;
}

const promptMap = new Map([
  ["p1", { text: "best ev 2026", funnel: "인지/탐색" }],
  ["p2", { text: "family suv compare", funnel: null }],
]);

const jobs: MeasurementJob[] = [
  { job_id: "j1", prompt_id: "p1", target: "chatgpt", region: "IT", status: "completed", measured_at: "2026-07-01T00:00:00Z" },
  { job_id: "j2", prompt_id: "p2", target: "gemini", region: "KR", status: "completed", measured_at: "2026-07-02T00:00:00Z" },
  { job_id: "j3", prompt_id: null, target: "chatgpt", region: "US", status: "completed", measured_at: "2026-07-03T00:00:00Z" },
];

// 도메인별 인용수가 전부 다르게(4/3/2/1) 설계 — 정렬 동률로 인한 순서 차이 배제.
const CITS: FixtureCitation[] = [
  { jobId: "j1", url: "https://www.kia.com/it/it/a", domain: "kia.com", title: "Kia A" },
  { jobId: "j1", url: "https://www.kia.com/it/it/b", domain: "kia.com", title: "Kia B" },
  { jobId: "j1", url: "https://www.kia.com/it/it/c", domain: "kia.com", title: "Kia C" },
  { jobId: "j1", url: "https://www.caranddriver.com/x", domain: "caranddriver.com", title: "CD X" },
  { jobId: "j1", url: "https://unknownsite.io/1", domain: "unknownsite.io", title: "U1" },
  // j2 — 같은 URL 재인용 (다른 엔진) + scope 분류가 실려 온 행(분류 우선 규칙)
  { jobId: "j2", url: "https://www.kia.com/it/it/a", domain: "kia.com", title: "Kia A", category: "News & Media" },
  { jobId: "j2", url: "https://www.caranddriver.com/x", domain: "caranddriver.com", title: "CD X" },
  { jobId: "j2", url: "https://www.caranddriver.com/y", domain: "caranddriver.com", title: "CD Y" },
  // j3 — 프롬프트 없는 답변 (prompts 카운트 제외 규칙)
  { jobId: "j3", url: "https://blog.naver.com/post1", domain: "naver.com", title: "N1" },
  { jobId: "j3", url: "https://blog.naver.com/post2", domain: "naver.com", title: "N2" },
];

function buildResults(): QueryRunView[] {
  return jobs.map((j) => ({
    job_id: j.job_id,
    target: j.target,
    status: "completed",
    result: {
      answer_text: "",
      measured_at: j.measured_at,
      citations: CITS.filter((c) => c.jobId === j.job_id).map(
        (c): ScopeCitation => ({
          url: c.url,
          host: c.domain,
          title: c.title,
          ...(c.category ? { category: c.category } : {}),
        }),
      ),
    },
  }));
}

// ── SQL 이 반환할 행들을 fixture 에서 재현 (신규 쿼리와 동일한 그룹 규칙) ──────
const jobBy = new Map(jobs.map((j) => [j.job_id, j]));
const owned = (url: string) => ownedBaseEntryForUrl(url) !== null;

function buildGroupRows(): CitDomainGroupRow[] {
  const m = new Map<string, { citations: number; owned: boolean; ownedCitations: number }>();
  for (const c of CITS) {
    const key = `${c.domain}|${c.category ?? ""}|${jobBy.get(c.jobId)!.target}`;
    const g = m.get(key) ?? { citations: 0, owned: false, ownedCitations: 0 };
    g.citations += 1;
    // 그룹 bool + 행 단위 FILTER 카운트 — 신규 SQL 의 owned/owned_citations 재현.
    if (owned(c.url)) {
      g.owned = true;
      g.ownedCitations += 1;
    }
    m.set(key, g);
  }
  return [...m.entries()].map(([key, g]) => {
    const [domain, category, target] = key.split("|");
    return {
      domain,
      category: category || null,
      target,
      citations: g.citations,
      owned: g.owned,
      owned_citations: g.ownedCitations,
    };
  });
}

function buildStatRows(): CitDomainStatRow[] {
  const m = new Map<string, { jobs: Set<string>; prompts: Set<string> }>();
  for (const c of CITS) {
    const s = m.get(c.domain) ?? { jobs: new Set(), prompts: new Set() };
    s.jobs.add(c.jobId);
    const pid = jobBy.get(c.jobId)!.prompt_id;
    if (pid) s.prompts.add(pid);
    m.set(c.domain, s);
  }
  return [...m.entries()].map(([domain, s]) => ({
    domain,
    citing_answers: s.jobs.size,
    prompts: s.prompts.size,
  }));
}

function buildUrlRows(): CitUrlRow[] {
  const m = new Map<string, { title: string; promptText: string | null; cites: number; targets: Set<string> }>();
  for (const c of CITS) {
    // measured_at 순 정렬과 동일 — fixture 는 j1→j2→j3 순으로 이미 정렬돼 있다.
    const key = `${c.domain}|${c.url}`;
    const j = jobBy.get(c.jobId)!;
    const u = m.get(key) ?? {
      title: c.title,
      promptText: j.prompt_id ? (promptMap.get(j.prompt_id)?.text ?? null) : null,
      cites: 0,
      targets: new Set<string>(),
    };
    u.cites += 1;
    u.targets.add(j.target);
    m.set(key, u);
  }
  return [...m.entries()].map(([key, u]) => {
    const [domain, url] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
    return {
      domain,
      url,
      title: u.title,
      prompt_text: u.promptText,
      cites: u.cites,
      targets: [...u.targets].sort(),
    };
  });
}

function buildPromptRows(): CitPromptRow[] {
  const m = new Map<string, { cites: number; ownedCites: number; targets: Set<string> }>();
  for (const c of CITS) {
    const j = jobBy.get(c.jobId)!;
    if (!j.prompt_id) continue;
    const key = `${c.domain}|${j.prompt_id}`;
    const p = m.get(key) ?? { cites: 0, ownedCites: 0, targets: new Set<string>() };
    p.cites += 1;
    // SQL 의 `count(*) FILTER (WHERE ${owned})` 재현 — 행 단위 판정.
    if (owned(c.url)) p.ownedCites += 1;
    p.targets.add(j.target);
    m.set(key, p);
  }
  return [...m.entries()].map(([key, p]) => {
    const [domain, promptId] = key.split("|");
    return {
      domain,
      prompt_id: promptId,
      text: promptMap.get(promptId)?.text ?? null,
      funnel: promptMap.get(promptId)?.funnel ?? null,
      cites: p.cites,
      owned_cites: p.ownedCites,
      targets: [...p.targets].sort(),
    };
  });
}

function buildPromptRefRows(): CitPromptRefRow[] {
  const m = new Map<string, number>();
  for (const c of CITS) {
    const j = jobBy.get(c.jobId)!;
    if (!j.prompt_id) continue;
    const key = `${c.domain}|${j.prompt_id}|${c.jobId}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, cites]) => {
    const [domain, promptId, jobId] = key.split("|");
    const j = jobBy.get(jobId)!;
    return { domain, prompt_id: promptId, job_id: jobId, target: j.target, region: j.region, cites };
  });
}

function buildSplitRows(): { rows: CitSplitPromptRow[]; refs: CitSplitRefRow[] } {
  // 자사 판정은 **인용 행 단위**다 (2026-09-08). 종전 픽스처는 도메인 단위로
  // 접었는데(그 도메인의 어떤 인용이라도 owned 면 그 도메인을 인용한 프롬프트
  // 전부가 자사), 그러면 genesis.com 처럼 국가 경로로 갈리는 공유 호스트에서
  // 타국·글로벌 페이지만 인용한 프롬프트가 자사로 승격된다.
  const per = new Map<string, { cites: number; targets: Set<string>; owned: boolean }>();
  const refs = new Map<string, number>();
  for (const c of CITS) {
    const j = jobBy.get(c.jobId)!;
    if (!j.prompt_id) continue;
    const p = per.get(j.prompt_id) ?? { cites: 0, targets: new Set<string>(), owned: false };
    p.cites += 1;
    p.targets.add(j.target);
    if (owned(c.url)) p.owned = true;
    per.set(j.prompt_id, p);
    const rk = `${j.prompt_id}|${c.jobId}`;
    refs.set(rk, (refs.get(rk) ?? 0) + 1);
  }
  const ownedTotal = [...per.values()].filter((p) => p.owned).length;
  const uncitedTotal = per.size - ownedTotal;
  return {
    rows: [...per.entries()].map(([promptId, p]) => ({
      prompt_id: promptId,
      text: promptMap.get(promptId)?.text ?? null,
      funnel: promptMap.get(promptId)?.funnel ?? null,
      cites: p.cites,
      targets: [...p.targets].sort(),
      owned: p.owned,
      bucket_total: p.owned ? ownedTotal : uncitedTotal,
    })),
    refs: [...refs.entries()].map(([key, cites]) => {
      const [promptId, jobId] = key.split("|");
      const j = jobBy.get(jobId)!;
      return { prompt_id: promptId, job_id: jobId, target: j.target, region: j.region, cites };
    }),
  };
}

function foldFromFixture(
  filters: StandardFilters = {},
  overrides?: CitationOverrideMap,
): CitationsLive {
  return foldCitationsLive({
    sampledAnswers: jobs.length,
    groups: buildGroupRows(),
    stats: buildStatRows(),
    urls: buildUrlRows(),
    promptRows: buildPromptRows(),
    promptRefs: buildPromptRefRows(),
    split: filters.sourceCategory?.length ? null : buildSplitRows(),
    filters,
    overrides,
  });
}

// 정렬·집합 순서에 의존하지 않는 비교 형태로 정규화. summary 는 종전 JS 경로와
// 공유하는 필드만 비교한다 — officialOwnShare 는 SQL 경로 전용(당사 스코프 판정,
// 2026-08-05)이라 별도 describe 에서 검증.
function comparable(live: CitationsLive) {
  return {
    summary: { total: live.summary.total, uniqueDomains: live.summary.uniqueDomains },
    categories: live.categories,
    engineCategories: live.engineCategories,
    domains: live.domains.map((d) => ({
      domain: d.domain,
      citations: d.citations,
      share: d.share,
      prompts: d.prompts,
      coverageRate: d.coverageRate,
      isOurs: d.isOurs,
      category: d.category,
      subcategory: d.subcategory,
      urls: [...d.urls]
        .map((u) => ({ ...u, aiProvider: u.aiProvider.split(", ").sort().join(", ") }))
        .sort((a, b) => a.url.localeCompare(b.url)),
      promptList: [...d.promptList]
        .map((p) => ({
          ...p,
          providers: [...p.providers].sort(),
          answers: [...p.answers].sort((a, b) => a.jobId.localeCompare(b.jobId)),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    })),
  };
}

describe("foldCitationsLive — 종전 JS 경로(aggregateCitationsFrom)와 판정 동등", () => {
  it("무필터: 요약·도메인 통계·카테고리·엔진 구성·URL/프롬프트 드릴다운 일치", () => {
    const legacy = aggregateCitationsFrom(jobs, promptMap, buildResults(), {});
    expect(legacy).not.toBeNull();
    const next = foldFromFixture({});
    expect(comparable(next)).toEqual(comparable(legacy!));
    // 도메인 정렬(인용수 내림차순)도 일치 — fixture 는 동률 없음.
    expect(next.domains.map((d) => d.domain)).toEqual(legacy!.domains.map((d) => d.domain));
  });

  it("engine 필터: 대상 엔진 답변의 인용만 (양쪽 동일)", () => {
    const filters: StandardFilters = { engine: ["chatgpt"] };
    // SQL 은 W(답변 술어) 단계에서 좁힌다 — fixture 행도 동일하게 좁혀 재현.
    const legacy = aggregateCitationsFrom(jobs, promptMap, buildResults(), filters);
    const chatgptJobs = new Set(jobs.filter((j) => j.target === "chatgpt").map((j) => j.job_id));
    const narrowed = CITS.filter((c) => chatgptJobs.has(c.jobId));
    const saved = CITS.splice(0, CITS.length, ...narrowed);
    try {
      const next = foldCitationsLive({
        sampledAnswers: chatgptJobs.size,
        groups: buildGroupRows(),
        stats: buildStatRows(),
        urls: buildUrlRows(),
        promptRows: buildPromptRows(),
        promptRefs: buildPromptRefRows(),
        split: buildSplitRows(),
        filters,
      });
      expect(comparable(next)).toEqual(comparable(legacy!));
    } finally {
      CITS.splice(0, CITS.length, ...saved);
    }
  });

  it("sourceCategory 필터: 행 단위 분류(cat = category ?? categorizeDomain)로 전 산출물 좁힘", () => {
    const filters: StandardFilters = { sourceCategory: ["Automotive Media"] };
    const legacy = aggregateCitationsFrom(jobs, promptMap, buildResults(), filters);
    const next = foldFromFixture(filters);
    expect(next.summary.total).toBe(legacy!.summary.total);
    expect(next.summary.uniqueDomains).toBe(legacy!.summary.uniqueDomains);
    expect(next.categories).toEqual(legacy!.categories);
    expect(next.engineCategories).toEqual(legacy!.engineCategories);
    // 도메인 목록: Automotive Media 로 분류되는 도메인만 남는다. 2026-08-24
    // 도메인 분류사전 병합으로 naver.com 이 seed 에 들어와(car.naver.com 이 이
    // 도메인 인용의 92%) 여기에 합류했다 — 두 경로가 같은 분류기를 쓰므로
    // legacy 와의 동등성은 그대로다.
    expect(next.domains.map((d) => d.domain)).toEqual(["caranddriver.com", "naver.com"]);
    expect(next.domains[0].citations).toBe(legacy!.domains[0].citations);
    expect(next.domains[0].share).toBe(legacy!.domains[0].share);
    // sourceCategory 활성 → promptSplit 미계산(undefined) — 뷰가 종전 방식 폴백.
    expect(next.promptSplit).toBeUndefined();
  });

  it("scope 분류가 실려 온 행은 로컬 분류보다 우선한다 (카테고리 합계)", () => {
    const next = foldFromFixture({});
    const slices = new Map(next.categories!.map((s) => [s.name, s.value]));
    expect(slices.get("News & Media")).toBe(1); // j2 의 kia/a 1건
    expect(slices.get("Official (HMG)")).toBe(3); // 나머지 kia 3건은 로컬 분류
  });
});

describe("officialOwnShare — 공식(당사) 인용 비중 타일 (2026-08-05 축E 통일)", () => {
  it("분자 = 행 단위 owned 매칭 합, 분모 = 전체 인용 (round1)", () => {
    // fixture: kia.com/it 베이스 매칭 4건 (j1 3 + j2 1) / 전체 10건 = 40.0%.
    const next = foldFromFixture({});
    expect(next.summary.officialOwnShare).toBe(40);
  });

  it("sourceCategory 필터가 분자·분모에 같은 지점에서 적용된다", () => {
    // Automotive Media 로 좁히면 kia 그룹이 전부 빠져 분자 0 / 분모 3 → 0%.
    const next = foldFromFixture({ sourceCategory: ["Automotive Media"] });
    expect(next.summary.officialOwnShare).toBe(0);
  });

  it("분모 0 → null (0% 와 구분 — 측정 대기)", () => {
    const next = foldCitationsLive({
      sampledAnswers: 0,
      groups: [],
      stats: [],
      urls: [],
      promptRows: [],
      promptRefs: [],
      split: null,
      filters: {},
    });
    expect(next.summary.officialOwnShare).toBeNull();
  });

  it("그룹 bool(owned)이 true 여도 행 단위 비매칭 인용은 분자에 세지 않는다", () => {
    // 같은 도메인 그룹에 owned 2/citations 5 — 도메인 배지(isOurs)는 true 지만
    // 분자는 2 (KPI ⑤ 분자 규칙).
    const next = foldCitationsLive({
      sampledAnswers: 1,
      groups: [
        { domain: "hyundai.com", category: null, target: "chatgpt", citations: 5, owned: true, owned_citations: 2 },
        { domain: "blog.example.com", category: null, target: "chatgpt", citations: 5, owned: false, owned_citations: 0 },
      ],
      stats: [],
      urls: [],
      promptRows: [],
      promptRefs: [],
      split: null,
      filters: {},
    });
    expect(next.summary.officialOwnShare).toBe(20);
    expect(next.domains.find((d) => d.domain === "hyundai.com")?.isOurs).toBe(true);
  });
});

// ── 회귀 가드: 공유 호스트의 행 단위 자사 판정 ────────────────────────────
// 공유 유닛 픽스처(CITS)에는 "owned 와 non-owned 가 섞인 도메인"이 없어서, 규칙을
// 도메인 단위로 되돌려도 위 동등성 테스트들은 전부 통과한다(2026-09-08 실증:
// SQL 만 도메인 접기로 되돌려도 1,730 테스트가 전부 초록이었다). 그래서 그 형태만
// 따로 세운다 — genesis.com/hyundai.com/kia.com 처럼 국가 경로로 갈리는 공유
// 호스트에서 타국 페이지만 인용한 프롬프트가 자사로 승격되면 안 된다.
describe("자사 판정은 인용 행 단위 — 공유 호스트 국가 경로", () => {
  // kia.com 한 도메인 안에서 p1 은 /kr/ko(자사), p2 는 /us/en(타국)만 인용.
  const rows = {
    sampledAnswers: 2,
    groups: [
      { domain: "kia.com", category: null, target: "chatgpt", citations: 2, owned: true, owned_citations: 1 },
    ] as CitDomainGroupRow[],
    stats: [{ domain: "kia.com", citing_answers: 2, prompts: 2 }] as CitDomainStatRow[],
    urls: [] as CitUrlRow[],
    promptRows: [
      { domain: "kia.com", prompt_id: "p1", text: "a", funnel: null, cites: 1, owned_cites: 1, targets: ["chatgpt"] },
      { domain: "kia.com", prompt_id: "p2", text: "b", funnel: null, cites: 1, owned_cites: 0, targets: ["chatgpt"] },
    ] as CitPromptRow[],
    promptRefs: [] as CitPromptRefRow[],
    filters: {} as StandardFilters,
  };

  it("promptList 는 프롬프트별 owned 인용수를 싣는다 (도메인 owned 를 상속하지 않는다)", () => {
    const live = foldCitationsLive({ ...rows, split: null });
    const dom = live.domains.find((d) => d.domain === "kia.com")!;
    // 도메인 배지는 종전대로 도메인 단위(자사 인용이 하나라도 있으면 자사)
    expect(dom.isOurs).toBe(true);
    const byId = new Map(dom.promptList.map((p) => [p.id, p]));
    expect(byId.get("p1")!.ownedCitations).toBe(1);
    expect(byId.get("p2")!.ownedCitations).toBe(0); // ← 도메인 상속이면 1 이 된다
  });

  it("뷰 폴백(ownedPromptBuckets)은 p2 를 미인용으로 가른다", () => {
    const live = foldCitationsLive({ ...rows, split: null });
    // citations-view.tsx 의 판정 한 줄을 그대로 옮긴 것
    const ownedIds = new Set<string>();
    for (const d of live.domains) {
      for (const p of d.promptList) {
        if (p.ownedCitations === undefined ? d.isOurs : p.ownedCitations > 0) ownedIds.add(p.id);
      }
    }
    expect([...ownedIds]).toEqual(["p1"]);
  });

  it("SQL 분할(promptSplit)도 같은 결과를 낸다", () => {
    const live = foldCitationsLive({
      ...rows,
      split: {
        rows: [
          { prompt_id: "p1", text: "a", funnel: null, cites: 1, targets: ["chatgpt"], owned: true, bucket_total: 1 },
          { prompt_id: "p2", text: "b", funnel: null, cites: 1, targets: ["chatgpt"], owned: false, bucket_total: 1 },
        ],
        refs: [],
      },
    });
    expect(live.promptSplit).toMatchObject({ ownedCount: 1, uncitedCount: 1 });
    expect(live.promptSplit!.owned.map((p) => p.id)).toEqual(["p1"]);
    expect(live.promptSplit!.uncited.map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("promptSplit — 뷰의 클라이언트 폴백(ownedPromptBuckets)과 동등", () => {
  // citations-view.tsx 의 ownedPromptBuckets useMemo 를 그대로 재현.
  // 이 폴백은 소스 분류 필터가 켜져 promptSplit 이 미계산일 때 실제로 화면을
  // 그린다 — SQL 과 규칙이 갈리면 필터 on/off 로 숫자가 바뀐다. 그래서 두 경로가
  // **행 단위 판정**(promptList[].ownedCitations)으로 같아야 한다.
  function legacyBuckets(live: CitationsLive) {
    const allPrompts = new Map<string, CitationPromptLive & { providersSet: Set<string> }>();
    const ownedIds = new Set<string>();
    for (const domain of live.domains) {
      for (const prompt of domain.promptList ?? []) {
        let b = allPrompts.get(prompt.id);
        if (!b) {
          b = { ...prompt, citations: 0, providersSet: new Set() };
          allPrompts.set(prompt.id, b);
        }
        b.citations += prompt.citations;
        for (const p of prompt.providers) b.providersSet.add(p);
        if (
          prompt.ownedCitations === undefined ? domain.isOurs : prompt.ownedCitations > 0
        ) {
          ownedIds.add(prompt.id);
        }
      }
    }
    if (allPrompts.size === 0 || ownedIds.size === 0) return null;
    const owned = [...allPrompts.values()].filter((p) => ownedIds.has(p.id));
    const uncited = [...allPrompts.values()].filter((p) => !ownedIds.has(p.id));
    return { owned, uncited, ownedCount: owned.length, uncitedCount: uncited.length };
  }

  it("자사/미인용 카운트·구성 프롬프트·총 인용수 일치", () => {
    const legacy = legacyBuckets(aggregateCitationsFrom(jobs, promptMap, buildResults(), {})!);
    const next = foldFromFixture({}).promptSplit;
    expect(next).not.toBeNull();
    expect(next!.ownedCount).toBe(legacy!.ownedCount);
    expect(next!.uncitedCount).toBe(legacy!.uncitedCount);
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
    expect(ids(next!.owned)).toEqual(ids(legacy!.owned));
    expect(ids(next!.uncited)).toEqual(ids(legacy!.uncited));
    for (const row of next!.owned) {
      const l = legacy!.owned.find((r) => r.id === row.id)!;
      expect(row.citations).toBe(l.citations);
      expect([...row.providers].sort()).toEqual([...l.providersSet].sort());
    }
  });

  it("자사 인용 프롬프트가 없으면 null (섹션 숨김 — 종전 판정)", () => {
    const rows = buildSplitRows().rows.map((r) => ({ ...r, owned: false, bucket_total: 2 }));
    const next = foldCitationsLive({
      sampledAnswers: jobs.length,
      groups: buildGroupRows(),
      stats: buildStatRows(),
      urls: [],
      promptRows: [],
      promptRefs: [],
      split: { rows, refs: [] },
      filters: {},
    });
    expect(next.promptSplit).toBeNull();
  });
});

// ── 운영자 오버라이드 주입 (2026-08-21, citation-category-override) ──────────
// 두 가지를 고정한다:
//  (a) 회귀 기준 — 오버라이드 0행이면 두 경로 산출물이 도입 이전과 동일.
//  (b) live/mirror 패리티 — 같은 맵을 주입하면 두 경로가 같은 결과를 낸다.
//      (오버라이드를 모듈 전역 상태로 두는 안이 기각된 이유가 바로 이것 —
//       파라미터라야 패리티가 로드 타이밍 운이 아니라 구조로 보장된다.)
describe("인용 카테고리 오버라이드 — 회귀 기준과 live/mirror 패리티", () => {
  // fixture 도메인: kia.com(owned) · caranddriver.com(seed) ·
  // unknownsite.io(fallback) · naver.com(seed, 2026-08-24 이전에는 rule 미발화).
  // 세 계층을 한 번에 덮는다.
  const overrides: CitationOverrideMap = new Map<string, CitationCategory>([
    ["kia.com", "Dealer & Marketplace"],
    ["caranddriver.com", "Blogs & Reviews"],
    ["unknownsite.io", "Government & Public"],
  ]);

  it("오버라이드 0행: 생략·빈 맵이 서로 같고, 종전 JS 경로와도 같다", () => {
    const legacyNone = aggregateCitationsFrom(jobs, promptMap, buildResults(), {});
    const legacyEmpty = aggregateCitationsFrom(jobs, promptMap, buildResults(), {}, {}, new Map());
    expect(comparable(legacyEmpty!)).toEqual(comparable(legacyNone!));

    const mirrorNone = foldFromFixture({});
    const mirrorEmpty = foldFromFixture({}, new Map());
    expect(comparable(mirrorEmpty)).toEqual(comparable(mirrorNone));
    expect(comparable(mirrorNone)).toEqual(comparable(legacyNone!));
  });

  it("같은 오버라이드 주입: live(aggregateCitationsFrom) == mirror(foldCitationsLive)", () => {
    const legacy = aggregateCitationsFrom(jobs, promptMap, buildResults(), {}, {}, overrides);
    expect(legacy).not.toBeNull();
    const next = foldFromFixture({}, overrides);
    expect(comparable(next)).toEqual(comparable(legacy!));
  });

  it("주입 시 분류가 실제로 바뀐다 (테스트가 no-op 이 아님을 확인)", () => {
    const before = foldFromFixture({});
    const after = foldFromFixture({}, overrides);
    const catOf = (live: CitationsLive, domain: string) =>
      live.domains.find((d) => d.domain === domain)?.category ?? null;

    expect(catOf(before, "caranddriver.com")).toBe("Automotive Media");
    expect(catOf(after, "caranddriver.com")).toBe("Blogs & Reviews");
    expect(catOf(before, "unknownsite.io")).toBe("Other");
    expect(catOf(after, "unknownsite.io")).toBe("Government & Public");
    // 파이(categories) 총합은 불변 — 분류만 옮겨 담긴다.
    const sum = (live: CitationsLive) =>
      (live.categories ?? []).reduce((s, c) => s + c.citations, 0);
    expect(sum(after)).toBe(sum(before));
    expect(new Set((after.categories ?? []).map((c) => c.name))).toContain("Government & Public");
  });

  it("운영자 교정이 실어 보낸 category 를 이긴다 (운영 결정 2026-08-21)", () => {
    // fixture j2 의 kia.com 행은 category="News & Media"(엔진 분류)를 갖고,
    // 오버라이드는 같은 도메인을 "Dealer & Marketplace" 로 교정한다.
    // 교정이 아래에 있으면 scope 가 분류를 보내기 시작하는 순간 admin 화면이
    // 조용히 무력화된다 — 그래서 사람이 지정한 값이 위다.
    const before = foldFromFixture({});
    const after = foldFromFixture({}, overrides);
    expect(new Set((before.categories ?? []).map((c) => c.name))).toContain("News & Media");
    expect(new Set((after.categories ?? []).map((c) => c.name))).not.toContain("News & Media");
    expect(after.domains.find((d) => d.domain === "kia.com")?.category).toBe(
      "Dealer & Marketplace",
    );
    // 총합 불변 — 분류만 옮겨 담긴다.
    const sum = (live: typeof after) =>
      (live.categories ?? []).reduce((s, c) => s + c.citations, 0);
    expect(sum(after)).toBe(sum(before));
    // live 경로도 같은 규칙 (패리티).
    const legacy = aggregateCitationsFrom(jobs, promptMap, buildResults(), {}, {}, overrides);
    expect(new Set((legacy!.categories ?? []).map((c) => c.name))).toEqual(
      new Set((after.categories ?? []).map((c) => c.name)),
    );
  });

  it("sourceCategory 필터도 오버라이드 후 분류로 좁힌다 (양 경로 동일)", () => {
    const filters: StandardFilters = { sourceCategory: ["Government & Public"] };
    const legacy = aggregateCitationsFrom(jobs, promptMap, buildResults(), filters, {}, overrides);
    const next = foldFromFixture(filters, overrides);
    expect(next.domains.map((d) => d.domain)).toEqual(["unknownsite.io"]);
    expect(comparable(next).domains.map((d) => d.domain)).toEqual(
      comparable(legacy!).domains.map((d) => d.domain),
    );
    // 오버라이드 없이 같은 필터를 걸면 그 카테고리에 아무것도 안 걸린다(대조군).
    expect(foldFromFixture(filters).domains).toEqual([]);
  });
});
