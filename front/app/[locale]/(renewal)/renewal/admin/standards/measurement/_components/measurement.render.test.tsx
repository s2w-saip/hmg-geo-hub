import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { Measurement } from "../../../../projects/_components/project-measurement";
import {
  DEFAULT_MEASUREMENT_FILTER,
  measurementFilterToQuery,
  measurementMatches,
  ownedState,
  queryToMeasurementFilter,
  registeredUrls,
  rowName,
  sortMeasurements,
  unregisteredCount,
  type MeasurementListing,
  type MeasurementRow,
} from "./measurement-model";

// Admin › 측정 설정 (T6.3, 2026-11-07): one list of every surface, what is left to register at a glance, and a row's sheet is the Project › Setting form.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSearchParams: () => new URLSearchParams("surface=2"),
  usePathname: () => "/ko/renewal/admin/standards/measurement",
}));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ replace: () => {} }), usePathname: () => "/renewal/admin/standards/measurement", Link: () => null }));

const { MeasurementManager } = await import("./measurement-manager");

const measurement = (over: Partial<Measurement> = {}): Measurement => ({
  version: 1, brands: [], countries: [], engines: [], cadence: null, acrRepeats: null, webUnits: [], ownedUrls: [], trackedUrls: [], trackedTargets: [], origin: "gold_import", recordedAt: "2026-10-28T01:00:00Z", ...over,
});
const row = (projectId: string, surface: number, name: string | null, over: Partial<Measurement> = {}): MeasurementRow => ({ projectId, surface, name, description: null, domain: null, status: "active", measurement: measurement(over) });
const GLOBAL = row("00000000-0000-4000-8000-000000000001", 1, null, { brands: ["kia"], countries: ["KR", "US"], engines: ["chatgpt"] });
const SITE = row("00000000-0000-4000-8000-000000000002", 2, null, { brands: ["kia"], countries: ["AU"], engines: ["chatgpt", "gemini"], ownedUrls: ["kia.com/au"] });
const SITE_BASE = row("00000000-0000-4000-8000-000000000003", 2, null, { brands: ["hyundai"], countries: ["PR"], webUnits: [{ fileSeq: 1, langCodes: ["es"], base: "hyundaipr.com" }] });
const PROJECT = row("843ecb1b-4713-4c2a-8592-e173eb16b7c7", 3, null);
const NAMED = row("00000000-0000-4000-8000-000000000005", 3, "EV launch", { trackedUrls: ["kia.com/ev"] });
const ALL_ROWS = [GLOBAL, SITE, SITE_BASE, PROJECT, NAMED];
const LABELS = { global: "Global", brand: (c: string) => c.toUpperCase(), country: (c: string) => c };
const LISTING: MeasurementListing = { items: ALL_ROWS, options: { brands: ["hyundai", "kia"], countries: ["KR"], engines: ["chatgpt"] }, editing: true };

describe("the list's rules", () => {
  it("names a row by what the input store holds", () => {
    expect(ALL_ROWS.map((r) => rowName(r, LABELS))).toEqual(["Global", "KIA · AU", "HYUNDAI · PR", "843ecb1b", "EV launch"]);
  });

  it("counts a website unit's base address as registered, as the own-URL rule does; Global has no such list", () => {
    expect(ALL_ROWS.map(ownedState)).toEqual(["none", "registered", "registered", "unregistered", "unregistered"]);
    expect(registeredUrls(SITE_BASE)).toEqual(["hyundaipr.com"]);
    expect(unregisteredCount(ALL_ROWS)).toBe(2);
  });

  it("filters by surface, registration, brand and text", () => {
    const of = (over: object, search = "") => ALL_ROWS.filter((r) => measurementMatches(r, rowName(r, LABELS), { ...DEFAULT_MEASUREMENT_FILTER, ...over }, search));
    expect(of({ surface: "3" })).toEqual([PROJECT, NAMED]);
    expect(of({ owned: "unregistered" })).toEqual([PROJECT, NAMED]);
    expect(of({ owned: "registered", brand: "kia" })).toEqual([SITE]);
    expect(of({}, "hyundaipr")).toEqual([SITE_BASE]);
    expect(of({}, "843ecb")).toEqual([PROJECT]);
    expect(of({}, "kia.com/ev")).toEqual([NAMED]);
  });

  it("sorts by surface first, then by name, and keeps the filters in the URL", () => {
    const named = ALL_ROWS.map((r) => ({ row: r, name: rowName(r, LABELS) }));
    expect(sortMeasurements(named, "surface", true, "en").map((n) => n.name)).toEqual(["Global", "HYUNDAI · PR", "KIA · AU", "843ecb1b", "EV launch"]);
    expect(sortMeasurements(named, "ownedUrls", false, "en").map((n) => n.name).slice(0, 2)).toEqual(["HYUNDAI · PR", "KIA · AU"]);
    const query = measurementFilterToQuery({ surface: "2", owned: "unregistered", brand: "kia" }, " au ");
    expect(queryToMeasurementFilter(query, ["kia"])).toEqual({ filters: { surface: "2", owned: "unregistered", brand: "kia" }, search: "au" });
    expect(queryToMeasurementFilter("surface=9&brand=nope", ["kia"]).filters).toEqual(DEFAULT_MEASUREMENT_FILTER);
  });
});

describe("<MeasurementManager>", () => {
  it("opens on the URL's filter with the unregistered count of the whole list", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko}>
        <MeasurementManager listing={LISTING} savedFilters={{ page: "measurement-settings", userId: "u", initial: [] }} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain("2 / 5개 · 소유 URL 미등록 2개");
    expect(html).toContain(`data-hub-measurement-row="${SITE.projectId}"`);
    expect(html).not.toContain(`data-hub-measurement-row="${PROJECT.projectId}"`);
    expect(html).toContain("프로젝트 만들기");
  });
});
