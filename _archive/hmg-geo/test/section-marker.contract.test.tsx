import { Suspense } from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SectionDoneMarker } from "@/components/perf/section-marker";

/**
 * React 계약 테스트 — "마커를 어디에 두어야 하는가"를 **실제 스트림 산출로** 고정한다.
 *
 * 배경(2026-09-10 T12 포렌식): React 19 는 경계의 자식이 서스펜드하면 그 자리에
 * `<template id="P:n">` 자리표시를 놓고 경계를 먼저 flush 한다. 그래서 서스펜드하는
 * 컴포넌트의 **형제**로 둔 마커는 데이터보다 훨씬 먼저 나간다(실측 49배 과소 계측).
 *
 * 여기서는 페이지 전체가 아니라 **그 메커니즘**을 렌더한다 — 페이지 렌더는 DB·세션·
 * next-intl 이 필요해 단위 테스트에 담기 어렵다. 대신 이 테스트가 React 의 동작이
 * 바뀌었는지(또는 우리 가정이 틀렸는지)를 잡는다. 페이지 HTML 에 대한 최종 확인은
 * `next build && next start` 스트림 실측이며 절차는 tools/hmg-perf-probe/README.md.
 */

/** 데이터가 도착해야 렌더되는 컴포넌트. */
async function Slow({ gate, marker }: { gate: Promise<string>; marker?: boolean }) {
  const v = await gate;
  return (
    <div data-v={v}>
      {/* 올바른 배치: await 뒤 반환 JSX 안 */}
      {marker ? <SectionDoneMarker id="inside" /> : null}
    </div>
  );
}

async function collect(node: React.ReactElement): Promise<string[]> {
  const stream = await renderToReadableStream(node);
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(dec.decode(value, { stream: true }));
  }
  return chunks;
}

/** 마커가 처음 등장하는 청크의 인덱스. */
const chunkOf = (chunks: string[], needle: string) =>
  chunks.findIndex((c) => c.includes(needle));

describe("React 19 Suspense 세그먼트 — 마커 배치 계약", () => {
  it("형제로 두면 마커가 `<template id=\"P:` 자리표시와 **같은 청크**로 먼저 나간다", async () => {
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => (release = r));
    // 셸이 먼저 flush 되도록 게이트는 조금 뒤에 연다 — 이 지연이 있어야 "자리표시와
    // 함께 먼저 나간 청크"와 "나중에 채워진 청크"가 실제로 갈린다.
    setTimeout(() => release("v"), 30);
    const chunks = await collect(
      <html>
        <body>
          <Suspense fallback={<i>loading</i>}>
            <Slow gate={gate} />
            <SectionDoneMarker id="sibling" />
          </Suspense>
        </body>
      </html>,
    );
    const i = chunkOf(chunks, 'data-hmg-section-done="sibling"');
    expect(i, "마커가 스트림에 없다").toBeGreaterThanOrEqual(0);
    // ⚠️ 이것이 결함의 지문이다 — 같은 청크에 자리표시가 함께 있다.
    expect(chunks[i]).toMatch(/<template id="P:/);
  });

  it("반환 JSX 안에 두면 자리표시와 같은 청크에 있지 않다", async () => {
    const gate = Promise.resolve("v");
    const chunks = await collect(
      <html>
        <body>
          <Suspense fallback={<i>loading</i>}>
            <Slow gate={gate} marker />
          </Suspense>
        </body>
      </html>,
    );
    const i = chunkOf(chunks, 'data-hmg-section-done="inside"');
    expect(i, "마커가 스트림에 없다").toBeGreaterThanOrEqual(0);
    // 데이터(`data-v`)와 같은 청크에 있고, 자리표시와는 함께 있지 않다.
    expect(chunks[i]).toMatch(/data-v="v"/);
    expect(chunks[i]).not.toMatch(/<template id="P:[0-9a-z]+"><\/template>\s*<div hidden(=""|)\s+data-hmg-section-done="inside"/);
  });
});
