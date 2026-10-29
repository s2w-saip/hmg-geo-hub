import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { rhqLabel } from "@/lib/rhq";
import { draftOf, missingFields, toBody, type Ga4Property } from "./ga4-registry-api";
import { DEFAULT_FILTER, filterToQuery, matches, queryToFilter, resultOf, sortProperties } from "./ga4-registry-filter-model";

// Admin › GA4 연동 (2026-10-29): the list as first rendered (the collector's last result as it left it, 반영 대기),
// its filter model, and the form's basis-driven event picking.

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("brand=Kia") }));

const { Ga4RegistryManager } = await import("./ga4-registry-manager");
const { Ga4PropertyForm } = await import("./ga4-registry-form");

const html = (ui: ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {ui}
    </NextIntlClientProvider>,
  );

const property = (over: Partial<Ga4Property>): Ga4Property => ({
  propertyId: "469542848",
  brand: "Kia",
  country: "IT",
  basis: "key_events",
  events: [],
  enabled: true,
  createdAt: "2026-10-29T02:00:00Z",
  updatedAt: "2026-10-29T02:00:00Z",
  version: "v1",
  collection: { status: "collected", checkedAt: "2026-10-29T09:15:00Z", error: null, collectedAt: "2026-10-29T09:16:00Z", collectedTo: "2026-10-28", pending: false },
  ...over,
});
const KIA_IT = property({});
const KIA_DE = property({
  propertyId: "1000",
  country: "DE",
  basis: "events",
  events: ["test_drive_request", "dealer_contact"],
  collection: { status: "pending_grant", checkedAt: "2026-10-29T09:15:00Z", error: "GA4 403: no access", collectedAt: null, collectedTo: null, pending: false },
});
const KIA_FR = property({ propertyId: "2000", country: "FR", collection: { status: null, checkedAt: null, error: null, collectedAt: null, collectedTo: null, pending: true } });
const HYUNDAI_US = property({ propertyId: "3000", brand: "Hyundai", country: "US", enabled: false, collection: { ...KIA_IT.collection, status: "stopped", pending: false } });

describe("GA4 property list", () => {
  it("renders the URL's picks, one line per matching property, its basis and the collector's result as it left it", () => {
    const out = html(<Ga4RegistryManager initial={[KIA_IT, KIA_DE, KIA_FR, HYUNDAI_US]} savedFilters={{ page: "ga4", userId: "u", initial: [] }} />);
    expect(out).toContain(">GA4 연동<");
    expect(out).toContain(ko.hubGa4.flowNote.replaceAll("'", "&#x27;"));
    expect(out).toContain('data-hub-ga4-row="469542848"');
    expect(out).not.toContain('data-hub-ga4-row="3000"'); // brand=Kia picked in the URL
    expect(out).toContain("Kia · 이탈리아");
    expect(out).toContain(">지정한 이벤트 2개<");
    expect(out).toContain('data-hub-ga4-result="collected"');
    expect(out).toContain('data-hub-ga4-result="pending_grant"');
    expect(out).toContain('data-hub-ga4-result="never"');
    expect(out).toContain("data-hub-ga4-pending"); // the never-collected property waits for the collector
    expect(out).toContain("3 / 4개 속성");
  });

  it("filters by brand, setting, result and the search text, and keeps them in the URL", () => {
    expect(matches(HYUNDAI_US, { ...DEFAULT_FILTER, setting: "stopped" }, "")).toBe(true);
    expect(matches(KIA_IT, { ...DEFAULT_FILTER, setting: "stopped" }, "")).toBe(false);
    expect(matches(KIA_FR, { ...DEFAULT_FILTER, result: "never" }, "")).toBe(true);
    expect(matches(KIA_DE, DEFAULT_FILTER, "dealer")).toBe(true);
    expect(matches(KIA_DE, DEFAULT_FILTER, "독일", (c) => (c === "DE" ? "독일" : c))).toBe(true);
    expect(matches(KIA_IT, DEFAULT_FILTER, "1000")).toBe(false);
    expect([resultOf(KIA_IT), resultOf(KIA_FR), resultOf(HYUNDAI_US)]).toEqual(["collected", "never", "stopped"]);
    const q = filterToQuery({ ...DEFAULT_FILTER, brand: "Kia", result: "failed" }, " 469 ");
    expect(q).toBe("brand=Kia&result=failed&q=469");
    expect(queryToFilter(q)).toEqual({ filters: { brand: "Kia", setting: "all", result: "failed" }, search: "469" });
    expect(queryToFilter("brand=Toyota").filters.brand).toBe("all");
  });

  it("orders by market; problems first by result; never collected after every collected day", () => {
    const all = [KIA_FR, HYUNDAI_US, KIA_DE, KIA_IT];
    expect(sortProperties(all, "market", true).map((p) => p.propertyId)).toEqual(["3000", "1000", "2000", "469542848"]);
    expect(sortProperties(all, "result", true).map((p) => p.propertyId)[0]).toBe("1000");
    expect(sortProperties(all, "collectedTo", false).map((p) => p.propertyId).slice(-2)).toEqual(["1000", "2000"]);
    expect(sortProperties(all, "propertyId", true).map((p) => p.propertyId)).toEqual(["1000", "2000", "3000", "469542848"]);
  });
});

describe("GA4 property form", () => {
  it("asks for the property ID once, the brand's countries, and events only with the listed-events basis", () => {
    const create = html(<Ga4PropertyForm item={null} onSaved={() => {}} onCancel={() => {}} />);
    expect(create).toContain('id="hub-ga4-property"');
    expect(create).toContain(ko.hubGa4.form.brandFirst);
    expect(create).not.toContain("data-hub-ga4-events");
    const edit = html(<Ga4PropertyForm item={KIA_DE} onSaved={() => {}} onCancel={() => {}} />);
    expect(edit).not.toContain('id="hub-ga4-property"'); // the property ID is set once
    expect(edit).toContain("data-hub-ga4-country");
    expect(edit).toContain(`<optgroup label="${rhqLabel("kia-western-europe", "ko")}"`); // Germany sits in Kia's western Europe
    expect(edit).toContain('data-hub-ga4-picked="dealer_contact"');
    expect(edit).toContain(ko.hubGa4.form.editNote);
    const keyEvents = html(<Ga4PropertyForm item={KIA_IT} onSaved={() => {}} onCancel={() => {}} />);
    expect(keyEvents).not.toContain("data-hub-ga4-events");
    expect(keyEvents).toContain('data-hub-ga4-basis-hint="key_events"');
  });

  it("sends events only with the listed-events basis and names what is missing", () => {
    expect(toBody({ ...draftOf(KIA_DE), basis: "key_events" })).toEqual({ brand: "Kia", country: "DE", basis: "key_events", events: [] });
    expect(toBody(draftOf(KIA_DE)).events).toEqual(["test_drive_request", "dealer_contact"]);
    expect(missingFields(draftOf(null), true)).toEqual(["propertyId", "brand", "country"]);
    expect(missingFields({ ...draftOf(null), propertyId: "G-123", brand: "Kia", country: "IT", basis: "events" }, true)).toEqual(["propertyId", "events"]);
    expect(missingFields({ ...draftOf(KIA_DE), events: ["has space"] }, false)).toEqual(["events"]);
    expect(missingFields({ ...draftOf(KIA_DE), events: ["문의_완료"] }, false)).toEqual([]);
  });
});
