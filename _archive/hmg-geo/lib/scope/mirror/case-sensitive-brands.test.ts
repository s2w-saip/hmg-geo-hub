import { describe, expect, it } from "vitest";
import { correctCaseSensitiveBrandMention } from "./case-sensitive-brands";

function seatMention(overrides: Partial<Parameters<typeof correctCaseSensitiveBrandMention>[0]> = {}) {
  return {
    entity_id: "seat-entity",
    entity_type: "Brand" as const,
    display_name: "SEAT",
    rollups: { product_entity_id: null, brand_entity_id: null, company_entity_id: null },
    surfaces: ["seat"],
    mention_count: 3,
    ...overrides,
  };
}

describe("correctCaseSensitiveBrandMention", () => {
  it("drops the mention when the answer only uses 'seat' as a common noun", () => {
    const result = correctCaseSensitiveBrandMention(
      seatMention({ mention_count: 2, surfaces: ["seat"] }),
      "The rear seat is comfortable and the front seat has good legroom.",
    );
    expect(result).toBeNull();
  });

  it("keeps the mention and recounts when the brand is genuinely referenced", () => {
    const result = correctCaseSensitiveBrandMention(
      seatMention({ mention_count: 1, surfaces: ["SEAT"] }),
      "Rivals include the SEAT Ibiza and the SEAT Arona.",
    );
    expect(result).toEqual(
      expect.objectContaining({ mention_count: 2, surfaces: ["SEAT"] }),
    );
  });

  it("recounts down when a mixed answer has both noise and a genuine mention", () => {
    const result = correctCaseSensitiveBrandMention(
      seatMention({ mention_count: 3, surfaces: ["seat", "SEAT"] }),
      "Rear-seat space is tight, but rivals like the SEAT Arona offer more.",
    );
    expect(result).toEqual(
      expect.objectContaining({ mention_count: 1, surfaces: ["SEAT"] }),
    );
  });

  it("drops the mention when there is no answer text to verify against", () => {
    const result = correctCaseSensitiveBrandMention(seatMention(), null);
    expect(result).toBeNull();
  });

  it("leaves non-collision brands untouched", () => {
    const mention = seatMention({ display_name: "Kia" });
    expect(correctCaseSensitiveBrandMention(mention, "anything")).toBe(mention);
  });

  it("leaves Product-type mentions untouched", () => {
    const mention = seatMention({ entity_type: "Product", display_name: "SEAT" });
    expect(correctCaseSensitiveBrandMention(mention, "unrelated text")).toBe(mention);
  });
});
