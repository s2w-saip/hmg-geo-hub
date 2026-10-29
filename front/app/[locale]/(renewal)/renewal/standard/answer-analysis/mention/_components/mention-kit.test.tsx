import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RnDelta } from "../_data/screen-types";
import { useDeltaBasis, useDeltaNote } from "./mention-kit";

// The Δ captions of the renewal Mention cards. The screens send the "prev" basis only for a snapshot, where it is
// the previous round (mention_data.load_kpi_hero_sub_kpis_prev); its caption read "기간 첫 측정일 누적 대비", the
// legacy period wording, next to the same card's "직전 회차 대비" (2026-10-29 BI review, the negative share).

function Captions({ delta }: { delta: RnDelta }) {
  const basis = useDeltaBasis();
  const note = useDeltaNote();
  return (
    <p>
      {basis(delta)}|{note(delta)}
    </p>
  );
}

const render = (delta: RnDelta) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <Captions delta={delta} />
    </NextIntlClientProvider>,
  );

describe("renewal Mention Δ basis captions", () => {
  it("the previous snapshot is told as the previous round", () => {
    const html = render({ value: 0.3, basis: { kind: "prev", date: "2026-09-28" } });
    expect(html).toContain("직전 회차(2026-09-28) 대비");
    expect(html).not.toContain("기간 첫 측정일");
  });
  it("the Overview card rule says the same", () => {
    expect(render({ value: 1.8, basis: { kind: "cycle", date: "2026-09-28" } })).toContain("직전 회차(2026-09-28) 대비");
  });
});
