import { describe, expect, it } from "vitest";
import { hmgBrandByNamePrefix, HMG_BRAND_NAME_PREFIXES } from "./hmg-brands";
import { isNonCompetitorMention } from "./non-competitor-brands";
import { JS_TRIM_CHARS, NAME_BOUNDARY_CLASS } from "./text-trim";

// 2026-08-29 경계 등가 회귀 가드 (PR #113 사후 검증 결함 ③).
//
// 표기 접두 규칙은 두 번 구현돼 있다 — SQL(scope-aggregates::canonRollupSql, 표준
// 표면)과 JS(hmg-brands::hmgBrandByNamePrefix, 프로젝트 표면). 두 경로가 갈리면
// **같은 언급이 화면마다 다른 브랜드로 귀속**된다.
//
// 종전 등가 테스트(hmg-brands.test·non-competitor-parity.test)는 **미러 실데이터**
// 로 대조해서, 데이터에 아직 없는 표기 형태는 영원히 못 잡았다. 이 파일은 데이터가
// 아니라 **프로브**로 강제한다 — 아래 6건이 정확히 그렇게 숨어 있던 불일치다
// (미러 해당 행 0건, 그래서 실데이터 대조가 전수 일치를 보고했다).
//
// SQL 쪽 실행은 sql-js-parity.int.test.ts(DATABASE_URL 필요)가 담당한다.
// 여기서는 POSIX 클래스를 JS 클래스로 치환한 쌍둥이와 대조한다 — 그 치환의
// 타당성(`[[:alnum:]]` ≡ `[\p{L}\p{Nd}]`)이 int 테스트가 DB 에서 확인하는 명제다.

/** SQL `canonRollupSql` 의 접두 CASE 를 JS 로 옮긴 것 (btrim + POSIX 치환). */
function sqlTwinPrefixBrand(name: string): string | null {
  const trimmed = trimLikeSql(name);
  for (const [brand, prefixes] of Object.entries(HMG_BRAND_NAME_PREFIXES)) {
    const pattern = `^(${prefixes.map(escapeRe).join("|")})([^${NAME_BOUNDARY_CLASS}]|$)`;
    if (new RegExp(pattern, "iu").test(trimmed)) return brand;
  }
  return null;
}
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Postgres `btrim(col, JS_TRIM_CHARS)` 의 JS 쌍둥이. */
function trimLikeSql(v: string): string {
  const set = new Set([...JS_TRIM_CHARS]);
  let s = 0;
  let e = v.length;
  while (s < e && set.has(v[s]!)) s++;
  while (e > s && set.has(v[e - 1]!)) e--;
  return v.slice(s, e);
}

// 프로브 — 경계 문자·공백·부분일치·자국어 표기를 축으로 짠 격자.
const BOUNDARY_PROBES = [
  // 경계 없음(문자열 끝)
  "Genesis", "Kia", "Hyundai", "현대", "기아", "제네시스",
  // 일반 경계
  "Genesis G70", "Genesis-G70", "Genesis(G70)", "Kia EV6", "현대 아이오닉 5",
  "Hyundai_N", "Kia/Charge", "제네시스 GV80",
  // 부분일치 — 매치되면 안 된다
  "Genesisian", "Kiabi", "Hyundaia", "현대차량", "기아자동차판매",
  // ASCII 숫자 경계 — alnum 이므로 매치되면 안 된다
  "Genesis2", "Kia6", "현대1",
  // ── 아래가 2026-08-29 이전 SQL↔JS 불일치 6건 ──────────────────────────────
  "  Genesis", " Kia", "\t현대",            // 선행 공백: JS 만 trim 했다
  "Genesis²", "GenesisⅡ", "Genesis①",      // No/Nl: JS \p{N} 만 숫자로 봤다
  // 유니코드 숫자 중 Nd 는 양쪽 다 alnum → 매치되면 안 된다
  "Genesis٣", "Kia１",
  // 비HMG
  "Toyota", "Tesla Model 3", "", "   ",
];

describe("표기 접두 규칙 — SQL 쌍둥이와 전 프로브 일치", () => {
  it.each(BOUNDARY_PROBES)("JS == SQL 쌍둥이: %j", (probe) => {
    expect(hmgBrandByNamePrefix(probe)).toBe(sqlTwinPrefixBrand(probe));
  });

  it("선행 공백이 붙어도 당사로 판정한다 (SQL btrim 도입 전 SQL 쪽 미매칭이던 것)", () => {
    expect(hmgBrandByNamePrefix("  Genesis")).toBe("Genesis");
    expect(sqlTwinPrefixBrand("  Genesis")).toBe("Genesis");
  });

  it("위첨자·로마숫자·원문자는 경계로 본다 (JS \\p{N} 이던 시절 JS 쪽 미매칭)", () => {
    for (const p of ["Genesis²", "GenesisⅡ", "Genesis①"]) {
      expect(hmgBrandByNamePrefix(p)).toBe("Genesis");
      expect(sqlTwinPrefixBrand(p)).toBe("Genesis");
    }
  });

  it("Nd(십진 숫자)는 경계가 아니다 — 부분일치 배제가 유지된다", () => {
    for (const p of ["Genesis2", "Genesis٣", "Kia１"]) {
      expect(hmgBrandByNamePrefix(p)).toBeNull();
      expect(sqlTwinPrefixBrand(p)).toBeNull();
    }
  });
});

// bare-only 비경쟁 제외(#120)도 같은 경계 클래스를 쓴다 — 함께 고정한다.
describe("bare-only 되살리기 — 같은 경계 규칙", () => {
  it("이름을 확장한 하위 제품은 살린다", () => {
    expect(isNonCompetitorMention("Smart", "Smart Fortwo")).toBe(false);
    expect(isNonCompetitorMention("Cruise", "Cruise Origin")).toBe(false);
  });

  it("bare 표기와 부분일치는 그대로 제외한다", () => {
    expect(isNonCompetitorMention("Smart", "Smart")).toBe(true);
    expect(isNonCompetitorMention("Smart", "Smartphone")).toBe(true);
    expect(isNonCompetitorMention("Smart", "Smart2")).toBe(true);
  });

  it("경계가 No/Nl 이면 살린다 (경계 클래스 회귀 시 깨진다)", () => {
    expect(isNonCompetitorMention("Smart", "Smart²")).toBe(false);
  });
});
