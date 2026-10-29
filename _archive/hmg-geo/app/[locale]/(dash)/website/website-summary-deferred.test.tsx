import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// next/navigation 훅은 라우터 없는 정적 렌더에서 null 을 준다 — 최소 mock
// (citations-standard-view.render.test.tsx 와 같은 형태).
vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/website",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));
import { use } from "react";
import { renderToReadableStream } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { KpiSummary } from "../dashboard/_data/sample";
import {
  SummaryTilesDeferredDeltas,
  type DeferredDeltaMap,
} from "../dashboard/_components/summary-tiles-deferred-deltas";
import { SummaryTiles } from "../dashboard/_components/summary-tiles";

// PR③-a 회귀 고정 — **/website 타일 값이 Sub-KPI·추이를 기다리지 않는다.**
//
// 프로덕션 진짜 콜드(2026-09-10, 게이트 ON `6beb6d8`): `website:summary` 마커가
// 11.5~13.5 s 인데 같은 페이지의 as-of·구성·GEO 는 0.80~0.88 s 였다. 원인은 추이가
// 아니라 `Promise.all([live, subKpis])` 의 두 번째다 — `fetchWebsiteSubKpis` 의 화면 키가
// 라이브 `read_screens` 밖이라 **미러**로 떨어진다. 키는 B6 에서 `S5.mention` →
// `S4.subkpi` 로 갈랐지만 **그 키도 off 로 머지**했으므로 배지는 아직 미러다.
// 이제 섹션은 `live` 만 await 하고, 엔진 일관성 배지와 Δ 는 타일 안쪽 경계에서 온다.
//
// 여기서는 지연 맵을 일부러 늦게 풀어 **첫 flush 에 값이 있고 배지·Δ 는 없는지**를
// 스트림 산출로 본다. 구조가 되돌아가면 첫 청크에서 값이 사라져 이 테스트가 깨진다.

const kpi = (over: Partial<KpiSummary> = {}): KpiSummary => ({
  key: "visibility",
  value: 73.1,
  delta: null,
  direction: "flat",
  ratio: { numerator: 1, denominator: 100 },
  ...over,
});

/**
 * ⚠️ **청크 순서로는 증명할 수 없다.** 이 환경의 `renderToReadableStream` 은 셸을 따로
 * 흘리지 않고 버퍼링한다 — 250 ms 지연을 줘도 첫 청크에 이미 해결된 경계(`<!--$-->`)와
 * 배지가 함께 들어 있었고, 반대로 손으로 푸는 게이트를 쓰면 첫 `read()` 가 영영 안 온다.
 * 즉 "청크가 둘 이상" 도 "첫 청크에 배지가 없다" 도 경계 유무와 무관하게 흔들린다
 * (검증 D: `<Suspense>` 를 지워도 초록이었다 — 그 지적이 맞았고, 같은 축으로 강화하려던
 * 시도도 실패했다).
 *
 * 그래서 판정 축을 바꾼다: **셸이 준비되는가**. `renderToReadableStream` 은 셸이 준비되면
 * 반환된다. 지연 값이 **영영 안 풀려도** 반환되면 타일은 그 값을 기다리지 않는 것이고,
 * 경계를 지우면 트리 전체가 서스펜드해 영영 반환되지 않는다. 이건 타이밍이 아니라
 * 구조의 차이라 흔들리지 않는다.
 */
const NEVER = new Promise<DeferredDeltaMap>(() => {});

async function shellReadyWithin(node: React.ReactElement, ms: number): Promise<boolean> {
  // ⚠️ `AbortController` 로 정리하지 않는다 — React 가 abort 를 거부로 올려
  // 처리되지 않은 DOMException 트레이스를 `npm test` 출력에 흘린다. 영영 안 풀리는
  // 렌더는 타이머도 소켓도 잡지 않으므로(프로미스 대기뿐) 그냥 두면 프로세스와 함께 끝난다.
  const ready = renderToReadableStream(node).then(() => true).catch(() => false);
  ready.catch(() => {});
  const timed = new Promise<boolean>((r) => setTimeout(() => r(false), ms));
  return Promise.race([ready, timed]);
}

/** 즉시 풀리는 값으로 전체 마크업만 볼 때 쓴다. */
async function chunks(node: React.ReactElement): Promise<string[]> {
  const stream = await renderToReadableStream(node);
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const out: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(dec.decode(value, { stream: true }));
  }
  return out;
}

const wrap = (deltas: Promise<DeferredDeltaMap>) => (
  <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
    <SummaryTilesDeferredDeltas items={[kpi()]} deltas={deltas} />
  </NextIntlClientProvider>
);

describe("/website 요약 타일 — 값은 Sub-KPI·추이를 기다리지 않는다 (PR③-a)", () => {
  it("배지·Δ 가 **영영 안 와도** 셸이 준비된다 — 타일이 그것을 안 기다린다", async () => {
    expect(await shellReadyWithin(wrap(NEVER), 1_000)).toBe(true);
  });

  it("(대조) 경계를 지우면 셸이 준비되지 않는다 — 위 단언이 무엇을 잡는지의 증거", async () => {
    // `SummaryTilesDeferredDeltas` 의 <Suspense> 를 뺀 형태를 흉내낸다: 지연 값을
    // 직접 `use()` 하는 컴포넌트를 경계 없이 렌더. 구조가 그렇게 되돌아가면 위 테스트가
    // 이렇게 실패한다.
    function NoBoundary() {
      const map = use(NEVER);
      return <SummaryTiles items={[kpi(map.visibility ?? {})]} perturb={false} />;
    }
    expect(
      await shellReadyWithin(
        <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
          <NoBoundary />
        </NextIntlClientProvider>,
        1_000,
      ),
    ).toBe(false);
  });

  it("배지·Δ 가 풀리면 타일에 병합된다", async () => {
    const html = (
      await chunks(
        wrap(Promise.resolve({
          visibility: { delta: -4.4, direction: "down", engineConsistency: 88.5 },
        })),
      )
    ).join("");
    expect(html).toContain("73.1");
    // React 는 `88.5<!-- -->%` 로 쪼갠다 — 숫자만 본다.
    expect(html).toContain("88.5");
    expect(html).toContain("4.4");
  });

  it("지연 맵이 비어도(둘 다 실패) 타일 값은 그대로다 — 카드가 안 깨진다", async () => {
    const cs = await chunks(wrap(Promise.resolve({} as DeferredDeltaMap)));
    expect(cs.join("")).toContain("73.1");
  });

  it("i18n 원시 키가 마크업에 남지 않는다", async () => {
    const html = (await chunks(wrap(Promise.resolve({} as DeferredDeltaMap)))).join("");
    expect(html).not.toMatch(/dashboard\.[a-zA-Z.]+/);
  });
});

// ── 페이지 레벨 고정 — 섹션이 `subKpis` 를 await 하지 않는다 ─────────────────
//
// 위 스트림 테스트는 **컴포넌트 계약**만 본다(`SummaryTilesDeferredDeltas` 가 경계를
// 갖는가). 정작 회귀가 나기 쉬운 곳은 **섹션이 무엇을 await 하는가** 이고, 그건
// `page.tsx` 에 있다. `Promise.all([live, subKpis])` 로 되돌리면 타일이 다시 미러
// Sub-KPI 에 묶이는데 위 테스트는 그대로 초록이다 — 그래서 소스 형태로 고정한다.
describe("WebsiteSummarySection — 타일이 기다리는 read (PR③-a)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./page.tsx", import.meta.url)),
    "utf8",
  );
  const body = src.slice(src.indexOf("async function WebsiteSummarySection"));
  const section = body.slice(0, body.indexOf("\n}\n"));

  it("`live` 하나만 await 한다 — Promise.all 로 되돌리면 깨진다", () => {
    expect(section).toContain("const dash = await live;");
    expect(section).not.toMatch(/await Promise\.all\(\[\s*live/);
  });

  it("`subKpis`·`trend` 는 지연 맵 안에서만 소비된다", () => {
    // 둘 다 `deferred` 프로미스 체인 안에서만 등장해야 한다(직접 await 금지).
    expect(section).not.toMatch(/await subKpis/);
    expect(section).not.toMatch(/await trend/);
    expect(section).toContain("subKpis.then(");
  });

  it("마커가 갈려 있다 — 타일 도착과 배지·Δ 도착", () => {
    expect(section).toContain('id="website:summary"');
    expect(section).toContain('id="website:summary-deltas"');
  });
});
