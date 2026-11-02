import { RnAccountGate } from "@/app/[locale]/(renewal)/renewal/_components/account-gate";
import type { RnConvBody as Body } from "../_data/screen-types";
import { RnConvBody } from "./conv-body";
import fixture from "./conv-body.fixture.json";

// AI Conversion while no GA4 property is connected (2026-11-02, user): the whole body on sample data under the
// "GA4 account needed" veil, in place of the noprop state card. The sample is the render test's fixture — the BFF's own
// output over the made-up reader rows of back/bff/tests/test_screens_conversion.py (test_front_fixture_is_current keeps
// it in step) — so it always has the shape the body draws. It never shows next to measured values.
export function RnConvSample() {
  return (
    <RnAccountGate account="ga4">
      <RnConvBody input={fixture as unknown as Body} />
    </RnAccountGate>
  );
}
