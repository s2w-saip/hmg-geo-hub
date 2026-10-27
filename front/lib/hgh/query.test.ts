import { describe, expect, it } from "vitest";
import {
  HghQueryError,
  queryToObject,
  serializeQuery,
  toSearchParams,
  withParams,
  type CommonQuery,
} from "./query";

const FIELD = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("feature params and generic serialization", () => {
  it("withParams adds feature params and refuses common keys and cf.*", () => {
    const query: CommonQuery = { surface: "global", engine: ["chatgpt"] };
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
