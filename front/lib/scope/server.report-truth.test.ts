import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SUMMARY_SCREEN_KEYS, SUMMARY_SCREEN_OPT_IN } from "@/lib/summary/read/screens";
import {
  reportTruthForced,
  reportTruthOverrideAllowedHere,
} from "@/lib/summary/read/report-truth-flag";

// ── 발행 리포트 정본(`X.reportTruth`): **배선 가드** (2026-09-20) ────────────
//
// 이 change 의 전제는 하나다 — **키가 꺼져 있으면 아무것도 안 바뀐다.** 값도, SQL 도,
// 반환 객체의 모양도. 그래서 "off 에서 종전 경로를 그대로 부르는가" 를 소스에서 고정한다
// (라이브 판정은 프리뷰 실측과 대조 스크립트가 본다 — server.period-route.test.ts 와 같은 자세).

const src = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");

function bodyOf(signature: string): string {
  const i = src.indexOf(signature);
  expect(i, signature).toBeGreaterThan(0);
  return src.slice(i, src.indexOf("\n}\n", i));
}

describe("화면 키", () => {
  it("어휘에 있고 **옵트인**이다: `screens all` 로 켜지지 않는다", () => {
    expect(SUMMARY_SCREEN_KEYS).toContain("X.reportTruth");
    expect(SUMMARY_SCREEN_OPT_IN.has("X.reportTruth")).toBe(true);
  });
});

describe("프리뷰 전용 env 오버라이드", () => {
  it("프리뷰에서만 읽는다 — 프로덕션에 값이 있어도 무시한다", () => {
    expect(reportTruthOverrideAllowedHere({ VERCEL_ENV: "preview" } as NodeJS.ProcessEnv)).toBe(true);
    expect(reportTruthOverrideAllowedHere({ VERCEL_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(reportTruthOverrideAllowedHere({ VERCEL_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
    // Vercel 밖에서는 로컬 개발만.
    expect(reportTruthOverrideAllowedHere({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
    expect(reportTruthOverrideAllowedHere({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(reportTruthOverrideAllowedHere({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("환경을 먼저 본다 — 프로덕션에서 FORCE=1 은 아무 일도 안 한다", () => {
    expect(
      reportTruthForced({ VERCEL_ENV: "production", REPORT_TRUTH_FORCE: "1" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      reportTruthForced({ VERCEL_ENV: "preview", REPORT_TRUTH_FORCE: "1" } as NodeJS.ProcessEnv),
    ).toBe(true);
    // 값이 정확히 "1" 일 때만.
    expect(
      reportTruthForced({ VERCEL_ENV: "preview", REPORT_TRUTH_FORCE: "true" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(reportTruthForced({ VERCEL_ENV: "preview" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("`NEXT_PUBLIC_` 접두사를 쓰지 않는다 (서버 전용)", () => {
    const flag = readFileSync(
      fileURLToPath(new URL("../summary/read/report-truth-flag.ts", import.meta.url)),
      "utf8",
    );
    // 주석은 뺀다 — 머리말이 "붙이지 않는다" 고 **설명하느라** 그 문자열을 갖고 있다.
    const code = flag
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toContain("NEXT_PUBLIC_");
    expect(code).toContain("env.REPORT_TRUTH_FORCE");
    expect(flag).toContain('import "server-only"');
  });
});

describe("fetchWebsiteTargetHitRate 배선", () => {
  const body = bodyOf("export async function fetchWebsiteTargetHitRate(");

  it("**off 는 종전 경로 그대로** — 표식조차 붙이지 않는다", () => {
    // 키 판정이 제일 먼저 오고, 꺼져 있으면 캐시 셀을 바로 반환한다.
    // 라이브 값의 경로(사실표 우선·미러 폴백)는 `websiteTargetHitRateLive` 한 곳이다 :
    // off 도 on-폴백도 **같은 함수**를 부른다(2026-09-27 GGMD-61 서머리 편입).
    expect(body).toContain("if (!(await reportTruthEnabled())) return websiteTargetHitRateLive(ids, f);");
    // off 분기가 객체를 새로 만들지 않는다 = 종전과 같은 참조·같은 모양.
    const off = body.slice(body.indexOf("reportTruthEnabled"), body.indexOf("websiteTargetHitRateFromPublication"));
    expect(off).not.toContain("source");
    expect(off).not.toContain("...");
  });

  it("on + 폴백이면 라이브 값에 `source: live` 를 단다 (조용히 섞지 않는다)", () => {
    expect(body).toContain('return { ...(await websiteTargetHitRateLive(ids, f)), source: "live" as const };');
  });

  it("맥락(ctx)을 해소 경로로 넘긴다 — 권한·브랜드 선택이 거기서 갈린다", () => {
    expect(body).toContain("websiteTargetHitRateFromPublication(ids, f, ctx)");
  });

  it("발행값이 없으면(null) 반드시 라이브로 간다 — 빈 값을 발행값이라 하지 않는다", () => {
    expect(body).toContain("if (published) return published;");
  });

  it("여전히 withWebsite 를 거친다 (브랜드 축이 project id 로 흡수되는 경로)", () => {
    expect(body).toContain('withWebsite("websiteTargetHitRate"');
  });
});

describe("발행값 해소 경로", () => {
  const body = bodyOf("async function websiteTargetHitRateFromPublication(");

  it("술어를 순수 함수에 위임한다 (화면·SQL 에 흩지 않는다)", () => {
    expect(body).toContain("resolveReportTruthRoute(f, ctx.selectedBrands)");
    expect(body).toContain('if (route.source === "live") return null;');
    expect(body).toContain("decidePublishedSelection({ published: pub.sites, runtime, axes: route.axes })");
    expect(body).toContain("publishedSubtotal(decision.selected)");
  });

  // 2026-09-20 검증 차단 1·2 의 회귀 가드.
  it("**브랜드 축을 원본 선택에서 가져온다** — withWebsite 가 filters.brand 를 지운다", () => {
    expect(body).toContain("ctx.selectedBrands");
    // 지워진 `f.brand` 를 읽으면 브랜드 축이 조용히 죽는다.
    expect(body).not.toContain("f.brand");
  });

  it("**권한은 계정 스코프로 판정한다** — 필터로 좁힌 projectIds 를 권한에 쓰지 않는다", () => {
    expect(body).toContain("cachedProjectIdsForScope(JSON.stringify(ctx.accountScope))");
    expect(body).toContain("websiteRuntimeClassification(accountProjectIds)");
    // 종전의 "조용한 교집합" 이 돌아오면 안 된다 — 그것이 Hyundai 42 → 40 의 원인이었다.
    expect(body).not.toContain("visible.has(s.fileSeq)");
    expect(body).not.toContain("visibleWebsiteFileSeqs");
  });

  it("기간이 없으면 최신 노출 회차를 미러에서 읽는다 (새 회차 = 자동 라이브)", () => {
    expect(body).toContain("await latestVisibleWebsiteRound(projectIds)");
    expect(body).toContain("if (!roundDate) return null;");
    expect(body).toContain("if (!pub) return null;");
    expect(body).toContain("if (!decision.ok) return null;");
    expect(body).toContain("if (!sub) return null;");
  });

  it("최신 회차를 **화면과 같은 함수**로 고른다 (술어를 두 벌로 만들지 않는다)", () => {
    const repo = readFileSync(
      fileURLToPath(new URL("../db/repositories/report-publications.ts", import.meta.url)),
      "utf8",
    );
    const fn = repo.slice(
      repo.indexOf("export async function latestVisibleWebsiteRound("),
      repo.indexOf("\n}\n", repo.indexOf("export async function latestVisibleWebsiteRound(")),
    );
    // 화면의 달력·스냅샷이 쓰는 술어 한 벌(`selectableAnchorDatesSql` 경유).
    expect(fn).toContain('listSelectableAnchorDates("website"');
    // 인용 화면이므로 계열은 citations — 집계층도 같은 계열이다
    // (`scope-aggregates.ts` 의 `answerWhere(…, { hiddenFamily: "citations" })`).
    expect(fn).toContain('"citations"');
    // 오름차순 목록의 마지막이 최신이다.
    expect(fn).toContain("dates[dates.length - 1]");
    // 손으로 쓴 SQL 이 돌아오면 안 된다 — 그것이 09-18(숨김 회차)을 고르던 형태였다.
    expect(fn).not.toContain("max(ca.round_date)");
    expect(fn).not.toContain("scope_answer_cycle_anchors");
  });

  it("앵커 축이 꺼져 있으면 **소리를 낸다** (조용한 no-op 금지)", () => {
    expect(body).toContain('if ("anchorAxisOff" in latest)');
    expect(body).toContain("console.warn");
    expect(body).toContain("ANSWER_ANCHOR_FORCE=1");
  });

  it("표시는 정수 쌍에서 파생한다 — 백분율을 저장해 비교하지 않는다", () => {
    expect(body).toContain("rate: pct1(sub.hitPrompts, sub.measuredPrompts)");
    expect(body).toContain("ownedRate: pct1(sub.ownedPrompts, sub.measuredPrompts)");
    // 두 카드가 **같은 분모**를 쓴다(GGMD-61 수용 기준 A1 을 이 경로에서도 지킨다).
    expect(body).toContain("measuredPrompts: sub.measuredPrompts");
  });

  it("직전 회차 쌍을 **같은 발행물에서** 실어 준다 (섞어 빼지 않기 위한 전제)", () => {
    expect(body).toContain("prev: sub.prev");
  });
});

describe("반환 타입", () => {
  it("추가 필드가 전부 optional 이고 직렬화 가능하다 (캐시 셀·서버→클라 경계)", () => {
    const i = src.indexOf("export interface WebsitePromptHitRates");
    expect(i).toBeGreaterThan(0);
    const decl = src.slice(i, src.indexOf("\n}\n", i));
    expect(decl).toContain("source?:");
    expect(decl).toContain("publication?:");
    expect(decl).toContain("prev?:");
    // Map·Set·Date 를 싣지 않는다 — unstable_cache 셀이 직렬화한다(2026-09-18 사고).
    for (const bad of ["Map<", "Set<", ": Date"]) expect(decl, bad).not.toContain(bad);
  });
});

// ── 차단 3 회귀 가드 (2026-09-20 검증) ──────────────────────────────────────
//
// `fetchWebsiteTargetHitRate` 의 표식(source·publication)은 화면 이관 뒤 웹사이트 요약 화면
// (website/summary, back/bff/screens/overview.py)이 타일의 provenance 로 싣는다. Next 쪽에 남은 것은
// 타일이 그 표식을 실제로 그리는 배선이다(키가 꺼져 있으면 provenance 가 없어 아무것도 안 그린다).
describe("출처 표식을 타일이 그린다", () => {
  it("타일이 그 표식을 실제로 렌더한다", () => {
    const tile = readFileSync(
      fileURLToPath(
        new URL("../../app/[locale]/(dash)/dashboard/_components/summary-tiles.tsx", import.meta.url),
      ),
      "utf8",
    );
    expect(tile).toContain("{tile.provenance ? (");
    expect(tile).toContain('tKpi("provenance.published"');
    expect(tile).toContain('tKpi("provenance.live")');
  });
});
