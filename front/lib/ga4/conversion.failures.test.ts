import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  one: vi.fn(), many: vi.fn(), report: vi.fn(), cache: new Map<string, unknown>(),
}));
vi.mock("@/lib/db/repositories/ga4-tracked-events", () => ({ ga4TrackedEventRepository: { listForProperty: mock.one, listForProperties: mock.many } }));
vi.mock("./client", () => ({
  runReport: mock.report, AI_CHANNEL_GROUP: "AI Assistant", isoToGa4: (d: string) => d,
  dateNDaysAgo: () => ({ start: "28daysAgo", end: "today" }),
}));
// Cache only fulfilled callbacks, matching the behavior this code relies on.
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => Promise<unknown>, keys: string[]) => async () => {
  const key = JSON.stringify(keys);
  if (mock.cache.has(key)) return mock.cache.get(key);
  const value = await fn();
  mock.cache.set(key, value);
  return value;
} }));
import { getAiTrafficConversionKpi, getAiTrafficConversionRollup } from "./conversion";

beforeEach(() => {
  mock.cache.clear();
  mock.one.mockReset().mockResolvedValue([]);
  mock.many.mockReset().mockResolvedValue(new Map());
  mock.report.mockReset().mockImplementation(async (_id, query) => {
    const ai = JSON.stringify(query).includes("AI Assistant");
    const event = query.metrics[0].name === "eventCount";
    const values = event ? [ai ? "1" : "4"] : [ai ? "10" : "30", ai ? "2" : "12"];
    return { rows: [{ dimensionValues: [], metricValues: values.map((value) => ({ value })) }] };
  });
});
const markets = [
  { brand: "Hyundai", country: "KR", propertyId: "1" },
  { brand: "Hyundai", country: "US", propertyId: "2" },
];

describe("GA4 configuration and rollup failures", () => {
  it("uses key events only for genuinely absent configuration", async () => {
    const result = await getAiTrafficConversionKpi("1");
    expect(result).toMatchObject({ aiConvRate: 20, humanConvRate: 50 });
    expect(mock.cache.size).toBe(1);
  });
  it("does not substitute key events or cache success when configuration cannot be read", async () => {
    mock.one.mockRejectedValueOnce(new Error("config DB down"));
    expect(await getAiTrafficConversionKpi("1")).toBeNull();
    expect(mock.report).not.toHaveBeenCalled();
    expect(mock.cache.size).toBe(0);
    mock.one.mockResolvedValueOnce(["test_drive"]);
    expect(await getAiTrafficConversionKpi("1")).toMatchObject({ aiConvRate: 10, humanConvRate: 15 });
  });
  it("does not substitute an empty configuration map for a database failure", async () => {
    mock.many.mockRejectedValueOnce(new Error("config DB down"));
    expect(await getAiTrafficConversionRollup(markets)).toBeNull();
    expect(mock.report).not.toHaveBeenCalled();
    expect(mock.cache.size).toBe(0);
  });
  it.each(["partial", "all"])("retries after %s failure without waiting for a 24-hour cache expiry", async (failure) => {
    const healthy = mock.report.getMockImplementation()!;
    mock.report.mockImplementation(async (id, query) => {
      if (failure === "all" || id === "2") throw new Error("GA4 temporary failure");
      return healthy(id, query);
    });
    expect(await getAiTrafficConversionRollup(markets)).toBeNull();
    expect(mock.cache.size).toBe(0);
    mock.report.mockImplementation(healthy);
    expect(await getAiTrafficConversionRollup(markets)).toMatchObject({ measuredMarkets: 2, totalMarkets: 2, totalAiUsers: 20 });
    expect(mock.cache.size).toBe(1);
  });
  it("includes country/brand mappings in the cache identity", async () => {
    const first = await getAiTrafficConversionRollup([markets[0]]);
    const second = await getAiTrafficConversionRollup([{ ...markets[0], country: "AU" }]);
    expect(first?.byCountry[0].country).toBe("KR");
    expect(second?.byCountry[0].country).toBe("AU");
    expect(mock.cache.size).toBe(2);
  });
});
