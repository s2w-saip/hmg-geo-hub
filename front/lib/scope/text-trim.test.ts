import { describe, expect, it } from "vitest";
import { JS_TRIM_CHARS, NAME_BOUNDARY_CLASS } from "./text-trim";

// JS↔SQL 경계 등가의 JS 쪽 정본을 고정한다. SQL 쪽(Postgres 실측)과의 대조는
// scope-aggregates.sql-js-parity.int.test.ts 가 실 DB 에서 돌린다.

describe("JS_TRIM_CHARS — String.prototype.trim() 의 문자 집합", () => {
  it("런타임에서 재도출한 집합과 정확히 같다 (누락·과잉 0)", () => {
    const derived: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // surrogate 단독은 대상 아님
      const ch = String.fromCodePoint(cp);
      if (ch.trim() === "") derived.push(ch);
    }
    expect([...JS_TRIM_CHARS].sort()).toEqual(derived.sort());
  });

  it("btrim 인자로 넘길 때 필요한 성질 — 중복 문자가 없다", () => {
    expect(new Set([...JS_TRIM_CHARS]).size).toBe([...JS_TRIM_CHARS].length);
  });

  it("U+FEFF 를 포함한다 (POSIX [[:space:]] 가 놓치는 문자 — 명시 집합을 쓰는 이유)", () => {
    expect(JS_TRIM_CHARS).toContain("﻿");
  });
});

// Postgres `[[:alnum:]]` 실측(2026-08-29, 프로덕션 미러):
//   true  → Nd(ASCII '2' · U+0663 아랍-인도 · U+FF11 전각) · L*(한글·CJK·é·ß)
//   false → No(U+00B2 '²' · U+2460 '①' · U+00BD '½') · Nl(U+2161 'Ⅱ') · 구두점·공백
const PG_ALNUM_TRUE = ["2", "٣", "１", "가", "一", "é", "ß"];
const PG_ALNUM_FALSE = ["²", "①", "½", "Ⅱ", " ", "-", "_", "・"];

describe("NAME_BOUNDARY_CLASS — POSIX [[:alnum:]] 의 JS 쌍둥이", () => {
  const re = new RegExp(`^[${NAME_BOUNDARY_CLASS}]$`, "u");

  it.each(PG_ALNUM_TRUE)("PG 가 alnum 으로 보는 문자는 JS 도 본다: %s", (ch) => {
    expect(re.test(ch)).toBe(true);
  });

  it.each(PG_ALNUM_FALSE)("PG 가 alnum 이 아니라고 보는 문자는 JS 도 아니다: %s", (ch) => {
    expect(re.test(ch)).toBe(false);
  });

  it("종전 \\p{N} 이었다면 깨졌을 케이스를 실제로 잡는다 (판별력)", () => {
    // 이 셋이 `\p{N}` 에서는 true 라 SQL(=false)과 갈렸다. 회귀하면 여기서 깨진다.
    for (const ch of ["²", "①", "Ⅱ"]) {
      expect(new RegExp(`^[\\p{N}]$`, "u").test(ch)).toBe(true);
      expect(re.test(ch)).toBe(false);
    }
  });
});
