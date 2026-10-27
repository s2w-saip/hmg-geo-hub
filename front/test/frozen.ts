import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Frozen builder outputs for render-test fixtures.
//
// Some component tests used to turn their legacy fixtures (KpiSummary[], LiveTrend, CitationsLive,
// brand rows, ...) into the screen payloads with the TypeScript view model. That view model now lives
// in the API (back/bff/screens/*, pinned by the golden cases in back/bff/tests/golden/), so the
// fixtures read the payloads recorded from it once, keyed by the builder name and its arguments.
// A fixture keeps its signature; a call with inputs that were never recorded fails loudly instead of
// computing anything.

type Encoded = unknown;

/** JSON with the values plain JSON loses: undefined, NaN/Infinity/-0, Set, Map, Date. */
export function encodeFrozen(v: unknown): Encoded {
  if (v === undefined) return { $u: 1 };
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $n: "NaN" };
    if (v === Infinity) return { $n: "Infinity" };
    if (v === -Infinity) return { $n: "-Infinity" };
    if (Object.is(v, -0)) return { $n: "-0" };
    return v;
  }
  if (v === null || typeof v !== "object") {
    if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
      throw new Error(`frozen: cannot encode a ${typeof v}`);
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(encodeFrozen);
  if (v instanceof Set) return { $set: [...v].map(encodeFrozen) };
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [encodeFrozen(k), encodeFrozen(x)]) };
  if (v instanceof Date) return { $date: v.toISOString() };
  const out: Record<string, Encoded> = {};
  for (const k of Object.keys(v).sort()) out[k] = encodeFrozen((v as Record<string, unknown>)[k]);
  return out;
}

/** The inverse of encodeFrozen. */
export function decodeFrozen(v: Encoded): unknown {
  if (Array.isArray(v)) return v.map(decodeFrozen);
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, Encoded>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    if (keys[0] === "$u") return undefined;
    if (keys[0] === "$n") return o.$n === "-0" ? -0 : Number(o.$n);
    if (keys[0] === "$set") return new Set((o.$set as Encoded[]).map(decodeFrozen));
    if (keys[0] === "$map") return new Map((o.$map as [Encoded, Encoded][]).map(([k, x]) => [decodeFrozen(k), decodeFrozen(x)]));
    if (keys[0] === "$date") return new Date(o.$date as string);
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = decodeFrozen(o[k]);
  return out;
}

/** Stable key of one builder call (its name and arguments). */
export function frozenKey(name: string, args: readonly unknown[]): string {
  return createHash("sha1").update(JSON.stringify(encodeFrozen([name, args]))).digest("hex").slice(0, 20);
}

export type FrozenTable = Record<string, { fn: string; out: Encoded }>;

/** Read a frozen table (a JSON file next to the fixture): `loadFrozen(new URL("./x.frozen.json", import.meta.url))`. */
export function loadFrozen(url: URL): FrozenTable {
  return JSON.parse(readFileSync(url, "utf8")) as FrozenTable;
}

/** The recorded output of `name(...args)`. */
export function frozen<T>(table: FrozenTable, name: string, args: readonly unknown[]): T {
  const key = frozenKey(name, args);
  const hit = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  if (!hit || hit.fn !== name) {
    throw new Error(
      `frozen ${name}: no recorded output for these inputs (key ${key}). The builder was ported to back/bff/screens; ` +
        "give the component a screen payload directly instead of a new legacy fixture.",
    );
  }
  return decodeFrozen(hit.out) as T;
}
