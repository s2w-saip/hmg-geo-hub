import { describe, expect, it } from "vitest";
import { brandSelectValueToDb } from "./brand-select";

describe("brandSelectValueToDb", () => {
  it("returns null for the 'all' sentinel", () => {
    expect(brandSelectValueToDb("all")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(brandSelectValueToDb("")).toBeNull();
  });

  it("passes BRANDS values through unchanged", () => {
    expect(brandSelectValueToDb("Hyundai")).toBe("Hyundai");
    expect(brandSelectValueToDb("Kia")).toBe("Kia");
    expect(brandSelectValueToDb("Genesis")).toBe("Genesis");
  });

  it("is stable for arbitrary strings (no validation here — DB enforces)", () => {
    // The Select UI restricts options to BRANDS, but this helper does no
    // catalog check — it just maps the sentinel to null.
    expect(brandSelectValueToDb("Toyota")).toBe("Toyota");
  });
});
