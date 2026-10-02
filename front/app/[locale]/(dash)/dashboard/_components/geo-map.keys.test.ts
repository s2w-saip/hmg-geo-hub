import { describe, expect, it } from "vitest";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import worldTopo from "world-atlas/countries-110m.json";
import type { GeoRegionRow } from "../_data/live";
import { buildGeoShapes, type RegionDatum, type WorldFeature } from "./geo-map";

// GeoShapes keys each polygon by shape id. world-atlas has features without an id; String(f.id)
// gave all of them "undefined" (React: "Encountered two children with the same key").

const topo = worldTopo as unknown as Topology;
const world = (feature(topo, topo.objects.countries as GeometryCollection) as unknown as { features: WorldFeature[] }).features;
const drawn = () => "M0,0Z";
const datum = (region: string): RegionDatum => ({ market: { region } as unknown as GeoRegionRow, label: region });

describe("buildGeoShapes keys", () => {
  it("the real atlas (with id-less features) gives one unique key per polygon", () => {
    const noId = world.filter((f) => f.id === undefined || f.id === null);
    expect(noId.length).toBeGreaterThan(1); // the case under test exists in the data
    const shapes = buildGeoShapes(world, drawn, new Map());
    expect(shapes).toHaveLength(world.length);
    expect(new Set(shapes.map((s) => s.id)).size).toBe(shapes.length);
    expect(shapes.some((s) => s.id === "undefined")).toBe(false);
  });

  it("id-less features get index keys and no region data; features with an id keep their id and data", () => {
    const f = (id: string | number | undefined, name: string): WorldFeature =>
      ({ type: "Feature", id, properties: { name }, geometry: { type: "Point", coordinates: [0, 0] } }) as WorldFeature;
    const features = [f("410", "Korea"), f(undefined, "A"), f(undefined, "B"), f(840, "USA")];
    const data = new Map([
      ["410", datum("KR")],
      ["840", datum("NA")],
      ["undefined", datum("never")],
    ]);
    const shapes = buildGeoShapes(features, drawn, data);
    expect(shapes.map((s) => s.id)).toEqual(["410", "noid-1", "noid-2", "840"]);
    expect(shapes.map((s) => s.datum?.label ?? null)).toEqual(["KR", null, null, "NA"]);
  });

  it("features the projection cannot draw are left out (as before)", () => {
    const shapes = buildGeoShapes(world.slice(0, 3), (x) => (x === world[1] ? null : "M0,0Z"), new Map());
    expect(shapes.map((s) => s.id)).toEqual([String(world[0].id), String(world[2].id)]);
  });
});
