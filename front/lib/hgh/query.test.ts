import { describe, expect, it } from "vitest";
import type { AllowedScope } from "@/lib/auth/types";
import { readStandardFilters } from "@/components/dash/standard-filters";
import {
  HghQueryError,
  queryToObject,
  resolveDateRange,
  serializeQuery,
  toCommonQuery,
  toSearchParams,
  withParams,
  type CommonQueryContext,
} from "./query";
import type { StandardFilters } from "@/lib/scope/result-adapter";

/** toCommonQuery as the client will send it: sorted query string (typed query + cf). */
const cq = (f: StandardFilters, ctx: CommonQueryContext) => {
  const { query, cf } = toCommonQuery(f, ctx);
  return new URLSearchParams(serializeQuery(query, cf));
};

const ADMIN: AllowedScope = { all: true };
const KIA_EU: AllowedScope = { all: false, brands: ["Kia"], countries: ["DE", "FR", "IT"] };
const REGION_NO_BRAND: AllowedScope = { all: false, countries: ["KR", "US"] };
const TODAY = "2026-09-28";
const PID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const FIELD = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("toCommonQuery: shape", () => {
  it("empty filters -> surface only (empty axes are never sent)", () => {
    expect(cq({}, { surface: "global", scope: ADMIN, today: TODAY }).toString()).toBe("surface=global");
    expect(cq({ engine: [], lang: [] }, { surface: "global", scope: ADMIN }).toString()).toBe("surface=global");
  });

  it("list axes repeat the name, sorted, deduped, keys in sorted order", () => {
    const q = cq(
      { engine: ["Gemini", "chatgpt", "chatgpt"], funnelStage: ["비교/검증", "인지/탐색"], lang: ["EN", "ko"] },
      { surface: "global", scope: ADMIN },
    );
    expect([...q.keys()]).toEqual(["engine", "engine", "funnel", "funnel", "lang", "lang", "surface"]);
    expect(q.getAll("engine")).toEqual(["chatgpt", "gemini"]);
    expect(q.getAll("lang")).toEqual(["en", "ko"]);
    expect(q.getAll("funnel")).toEqual(["비교/검증", "인지/탐색"].sort());
  });

  it("maps every StandardFilters axis to its CommonFilters name", () => {
    const q = cq(
      {
        region: ["US"],
        engine: ["chatgpt"],
        funnelStage: ["f"],
        brand: ["Kia"],
        brandPresence: ["branded"],
        listType: ["lt"],
        depth1: ["d1"],
        depth2: ["EV,Hybrid Brand Awareness"],
        depth3: ["d3"],
        sourceCategory: ["Official (HMG)"],
        lang: ["en"],
        dateFrom: "2026-08-01",
        dateTo: "2026-08-31",
        cumulative: true,
        contextBrand: ["Hyundai"],
        ownEntities: [{ id: "1", name: "x" }],
      },
      { surface: "global", scope: ADMIN },
    );
    expect(queryToObject(q)).toEqual({
      brand: ["Kia"],
      brand_presence: ["branded"],
      country: ["US"],
      depth1: ["d1"],
      depth2: ["EV,Hybrid Brand Awareness"],
      depth3: ["d3"],
      engine: ["chatgpt"],
      from: ["2026-08-01"],
      funnel: ["f"],
      lang: ["en"],
      list_type: ["lt"],
      source: ["officialHmg"],
      surface: ["global"],
      to: ["2026-08-31"],
    });
  });

  it("same filter state in a different click order -> identical query string", () => {
    const a = cq({ engine: ["b", "a"], region: ["US", "GB"] }, { surface: "global", scope: ADMIN });
    const b = cq({ region: ["GB", "US", "GB"], engine: ["a", "b"] }, { surface: "global", scope: ADMIN });
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe("country=GB&country=US&engine=a&engine=b&surface=global");
  });
});

describe("toCommonQuery: scope-injected values are not sent", () => {
  it("brand account: URL-less read injects the scope (brand lock + countries) -> nothing sent", () => {
    const f = readStandardFilters({}, KIA_EU);
    expect(f.brand).toEqual(["Kia", "HMG"]);
    expect(f.region?.sort()).toEqual(["DE", "FR", "IT"]);
    expect(cq(f, { surface: "global", scope: KIA_EU }).toString()).toBe("surface=global");
  });

  it("brand account narrowing inside its scope -> only the URL intersection is sent", () => {
    const f = readStandardFilters({ geography: "FR~DE", brand: "Genesis" }, KIA_EU);
    const q = cq(f, { surface: "global", scope: KIA_EU });
    expect(q.getAll("country")).toEqual(["DE", "FR"]);
    expect(q.has("brand")).toBe(false); // lock wins over ?brand, and the lock is not sent
  });

  it("URL countries all outside the scope: legacy falls back to the whole scope -> not sent", () => {
    const f = readStandardFilters({ geography: "US" }, KIA_EU);
    expect(f.region?.sort()).toEqual(["DE", "FR", "IT"]);
    expect(cq(f, { surface: "global", scope: KIA_EU }).has("country")).toBe(false);
  });

  it("admin: URL brand and countries are sent as chosen", () => {
    const f = readStandardFilters({ geography: "US~KR", brand: "Hyundai~Kia" }, ADMIN);
    const q = cq(f, { surface: "global", scope: ADMIN });
    expect(q.getAll("brand")).toEqual(["Hyundai", "Kia"]);
    expect(q.getAll("country")).toEqual(["KR", "US"]);
  });

  it("account with countries but no brand lock: URL brand is a user choice -> sent", () => {
    const f = readStandardFilters({ brand: "Genesis" }, REGION_NO_BRAND);
    const q = cq(f, { surface: "global", scope: REGION_NO_BRAND });
    expect(q.getAll("brand")).toEqual(["Genesis"]);
    expect(q.has("country")).toBe(false);
  });

  it("scope null (filters read without scope): values are URL values", () => {
    const q = cq({ region: ["KR"], brand: ["Kia"] }, { surface: "global", scope: null });
    expect(q.getAll("country")).toEqual(["KR"]);
    expect(q.getAll("brand")).toEqual(["Kia"]);
  });
});

describe("toCommonQuery: surfaces", () => {
  it("website uses websiteCountry (page moves region there), virtual codes pass through", () => {
    const f = { ...readStandardFilters({ geography: "HYUNDAI-N~KR" }, ADMIN), region: undefined };
    const q = cq({ ...f, websiteCountry: ["KR", "HYUNDAI-N"] }, { surface: "website", scope: ADMIN });
    expect(q.getAll("country")).toEqual(["HYUNDAI-N", "KR"]);
    expect(q.get("surface")).toBe("website");
  });

  it("project needs projectId and sends project_id; global never sends project_id", () => {
    expect(() => cq({}, { surface: "project", scope: ADMIN })).toThrow(HghQueryError);
    expect(cq({}, { surface: "project", projectId: PID, scope: ADMIN }).toString()).toBe(`project_id=${PID}&surface=project`);
    expect(cq({}, { surface: "global", projectId: PID, scope: ADMIN }).has("project_id")).toBe(false);
    expect(cq({}, { surface: "website", projectId: PID, scope: ADMIN }).get("project_id")).toBe(PID);
  });

  it("cf.<uuid> only on project; malformed field ids skipped; values sorted", () => {
    const customFields = { [FIELD]: ["b", "a"], "not-a-uuid": ["x"] };
    const q = cq({}, { surface: "project", projectId: PID, scope: ADMIN, customFields });
    expect(q.getAll(`cf.${FIELD}`)).toEqual(["a", "b"]);
    expect([...q.keys()].filter((k) => k.startsWith("cf."))).toEqual([`cf.${FIELD}`, `cf.${FIELD}`]);
    expect(cq({}, { surface: "global", scope: ADMIN, customFields }).toString()).toBe("surface=global");
  });

  it("source: names become slugs, slugs pass, unknown names pass raw (server drops them, fail-closed)", () => {
    const q = cq({ sourceCategory: ["News & Media", "wikiReference", "Mystery"] }, { surface: "global", scope: ADMIN });
    expect(q.getAll("source")).toEqual(["Mystery", "newsMedia", "wikiReference"]);
  });
});

describe("dates", () => {
  it("both ends -> from/to; none -> omitted (snapshot)", () => {
    expect(cq({ dateFrom: "2026-09-01", dateTo: "2026-09-10" }, { surface: "global", scope: ADMIN }).toString()).toBe(
      "from=2026-09-01&surface=global&to=2026-09-10",
    );
    expect(resolveDateRange({}, undefined, TODAY)).toBeNull();
  });

  it("one-sided range without bounds throws (caller must read /v1/filters/dates first)", () => {
    expect(() => cq({ dateFrom: "2026-09-01" }, { surface: "global", scope: ADMIN })).toThrow(/dateBounds/);
  });

  it("one-sided range is closed with first_measured_date / latest_round_date", () => {
    const bounds = { firstMeasuredDate: "2026-05-02", latestRoundDate: "2026-09-25" };
    expect(resolveDateRange({ dateFrom: "2026-09-01" }, bounds, TODAY)).toEqual({ from: "2026-09-01", to: "2026-09-25" });
    expect(resolveDateRange({ dateTo: "2026-06-30" }, bounds, TODAY)).toEqual({ from: "2026-05-02", to: "2026-06-30" });
    const q = cq({ dateTo: "2026-06-30" }, { surface: "global", scope: ADMIN, dateBounds: bounds });
    expect([q.get("from"), q.get("to")]).toEqual(["2026-05-02", "2026-06-30"]);
  });

  it("missing latest_round_date -> today KST; from after the latest round collapses to one day", () => {
    expect(resolveDateRange({ dateFrom: "2026-09-01" }, { latestRoundDate: null }, TODAY)).toEqual({ from: "2026-09-01", to: TODAY });
    expect(resolveDateRange({ dateFrom: "2026-10-05" }, { latestRoundDate: "2026-09-25" }, TODAY)).toEqual({
      from: "2026-10-05",
      to: "2026-10-05",
    });
  });

  it("reversed and out-of-range values are normalised instead of producing a 422", () => {
    expect(resolveDateRange({ dateFrom: "2026-09-10", dateTo: "2026-09-01" }, undefined, TODAY)).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(resolveDateRange({ dateFrom: "1999-01-01", dateTo: "2026-01-01" }, undefined, TODAY)).toEqual({ from: "2000-01-01", to: "2026-01-01" });
  });
});

describe("feature params and generic serialization", () => {
  it("returns a typed object; cf travels apart from the query", () => {
    const FIELD2 = "7c9e6679-7425-40de-944b-e07fc1f90ae8";
    const out = toCommonQuery(
      { engine: ["gemini", "chatgpt"], dateFrom: "2026-09-01", dateTo: "2026-09-10" },
      { surface: "project", projectId: PID, scope: ADMIN, customFields: { [FIELD]: ["b", "a"], [FIELD2]: [] } },
    );
    expect(out).toEqual({
      query: { surface: "project", project_id: PID, from: "2026-09-01", to: "2026-09-10", engine: ["chatgpt", "gemini"] },
      cf: { [FIELD]: ["a", "b"] },
    });
    expect(toCommonQuery({}, { surface: "global", scope: ADMIN })).toEqual({ query: { surface: "global" } });
  });

  it("withParams adds feature params and refuses common keys and cf.*", () => {
    const { query } = toCommonQuery({ engine: ["chatgpt"] }, { surface: "global", scope: ADMIN });
    const q = withParams(query, { cycle_offset: 1, metrics: ["visibility", "position"], cursor: null });
    expect(q).toEqual({ surface: "global", engine: ["chatgpt"], cycle_offset: 1, metrics: ["visibility", "position"], cursor: null });
    expect(serializeQuery(q)).toBe("cycle_offset=1&engine=chatgpt&metrics=visibility&metrics=position&surface=global");
    expect(query).toEqual({ surface: "global", engine: ["chatgpt"] }); // base untouched
    expect(() => withParams(query, { country: ["US"] } as never)).toThrow(HghQueryError);
    expect(() => withParams(query, { [`cf.${FIELD}`]: "x" })).toThrow(HghQueryError);
  });

  it("cf is serialized as cf.<uuid> repeated; a non-UUID field id is refused", () => {
    expect(serializeQuery({ surface: "project" }, { [FIELD.toUpperCase()]: ["x", "y"] })).toBe(
      `cf.${FIELD}=x&cf.${FIELD}=y&surface=project`,
    );
    expect(() => serializeQuery({ surface: "project" }, { "../x": ["a"] })).toThrow(HghQueryError);
    expect(queryToObject({ a: 1 }, { [FIELD]: ["v"] })).toEqual({ a: ["1"], [`cf.${FIELD}`]: ["v"] });
  });

  it("serializeQuery sorts keys, keeps each key's value order, skips null/undefined", () => {
    expect(serializeQuery({ b: ["2", "1"], a: true, c: undefined, d: null, e: 0 })).toBe("a=true&b=2&b=1&e=0");
    expect(serializeQuery(new URLSearchParams("z=1&a=2&z=0"))).toBe("a=2&z=1&z=0");
    expect(serializeQuery(undefined)).toBe("");
    expect(toSearchParams({ x: [1, 2] }).getAll("x")).toEqual(["1", "2"]);
  });
});
