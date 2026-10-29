// 프롬프트 대상 시장(`prompts.regions`) 표시 규약 — 순수 함수만.
//
// ⚠️ 이 축은 **계정 권한 스코프(region/country 롤)와 다른 축**이다.
// - 대상 시장 = 그 프롬프트가 어느 시장을 담당하는가 (카탈로그 속성, 이 파일)
// - 권한 스코프 = 그 계정이 무엇을 열람할 수 있는가 (`AllowedScope`, scope-policy)
// 화면에서 같은 모양으로 그리면 즉시 혼동된다 — 권한은 헤더 칩, 대상 시장은 행 배지.
//
// 값 규약(migration 0047): 실국가는 ISO 3166-1 alpha-2, 비국가 슬롯은 `x:` 접두
// 의사코드. 접두사가 없으면 `ME`(몬테네그로)·`EU`(ISO 예약)와 충돌한다.

/** `x:` 접두 의사코드 → i18n 라벨 키(`dashboard.filters.value.*`). */
const PSEUDO_LABEL_KEY: Record<string, string> = {
  "x:WW": "pseudoWorldwide",
  "x:EU": "pseudoEuRegion",
  "x:ME": "pseudoMiddleEast",
  "x:NBRAND": "pseudoNBrand",
  "x:CPO": "pseudoCpo",
};

// 지리 필터축에 노출해도 되는 의사코드 — **허용목록**이다.
// 제외목록(x:NBRAND·x:CPO 만 빼기)으로 두면 미래에 새 비지리 슬롯이 추가될 때
// 아무도 이 파일을 고치지 않아 D10(지리축 오염 방지)이 조용히 뚫린다. 등록되지
// 않은 `x:*` 는 배지로는 보이되 필터 옵션에는 들어오지 않는 쪽이 안전하다 —
// 옵션에 뜨는데 아무 행도 안 걸리는 "죽은 옵션"이 그 반대편 실패다.
const GEO_PSEUDO = new Set(["x:WW", "x:EU", "x:ME"]);

export function isPseudoRegion(code: string): boolean {
  return code.startsWith("x:");
}

/**
 * 저장값을 비교·표시용 표준형으로. 실국가는 대문자, 의사코드는 `x:` + 대문자.
 * 공백만 있거나 빈 값은 null(= 그 원소를 버린다).
 *
 * 0047 규약을 지킨 데이터에는 no-op 이다(2026-08-29 실측: 활성 12,164행에서
 * 공백·소문자·`X:`·미등록 `x:*` **0건**). 그래도 정규화를 두는 이유는 표시 경로와
 * 필터 술어가 **서로 다른 방식으로** 값을 다뤄 어긋나는 것을 막기 위해서다 —
 * 옵션 목록은 trim 한 값을, 술어는 원문을 보면 "필터에 뜨는데 안 걸리는" 행이
 * 생긴다. 한 함수로 모아 그 갈래 자체를 없앤다.
 */
export function normalizeMarket(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return isPseudoRegion(trimmed.toLowerCase())
    ? `x:${trimmed.slice(2).toUpperCase()}`
    : trimmed.toUpperCase();
}

/** 의사코드의 i18n 라벨 키. 미등록 코드는 null → 호출부가 원문 코드로 폴백. */
export function pseudoRegionLabelKey(code: string): string | null {
  return PSEUDO_LABEL_KEY[code] ?? null;
}

/** 지리 필터축에 노출 가능한 코드인가 (실국가 + **등록된** 지리 의사코드). */
export function isGeoFilterable(code: string): boolean {
  return isPseudoRegion(code) ? GEO_PSEUDO.has(code) : true;
}

export interface SplitMarkets {
  /** 실국가 ISO alpha-2 — solid 배지. */
  real: string[];
  /** `x:` 의사코드 — outline + 태그 아이콘 배지. */
  pseudo: string[];
}

/**
 * 행의 regions 를 실국가/의사코드로 가른다. 실국가가 먼저 오도록 정렬해
 * 접힘(상위 3개 + `+N`)에서 실제 시장이 우선 노출되게 한다.
 * NULL·빈 배열은 둘 다 빈 결과 — 호출부가 "전체(상속)" 배지로 처리한다.
 */
export function splitMarkets(regions: string[] | null | undefined): SplitMarkets {
  const real = new Set<string>();
  const pseudo = new Set<string>();
  for (const raw of regions ?? []) {
    const code = normalizeMarket(raw);
    if (!code) continue;
    (isPseudoRegion(code) ? pseudo : real).add(code);
  }
  return { real: [...real].sort(), pseudo: [...pseudo].sort() };
}

/** regions 미지정(= 상한 전체 상속)인가. NULL 과 빈 배열을 같게 취급한다. */
export function isMarketUnset(regions: string[] | null | undefined): boolean {
  const { real, pseudo } = splitMarkets(regions);
  return real.length === 0 && pseudo.length === 0;
}

/**
 * 시장 필터 드롭다운 옵션 — 표시 중인 행 전체에서 파생.
 * 실국가 먼저(정렬), 그 다음 지리 의사코드. 비지리 의사코드는 제외(D10).
 */
export function marketFilterOptions(rowsRegions: (string[] | null)[]): string[] {
  const real = new Set<string>();
  const pseudo = new Set<string>();
  for (const regions of rowsRegions) {
    for (const raw of regions ?? []) {
      const code = normalizeMarket(raw);
      if (!code || !isGeoFilterable(code)) continue;
      (isPseudoRegion(code) ? pseudo : real).add(code);
    }
  }
  return [...[...real].sort(), ...[...pseudo].sort()];
}

/**
 * 행이 그 시장 코드를 담당하는가 (필터 술어).
 * 옵션 목록과 **같은 정규화**를 거친다 — 이게 어긋나면 "드롭다운에 뜨는데
 * 고르면 0행"이 된다.
 */
export function matchesMarket(
  regions: string[] | null | undefined,
  code: string,
): boolean {
  const target = normalizeMarket(code);
  if (!target) return false;
  const { real, pseudo } = splitMarkets(regions);
  return real.includes(target) || pseudo.includes(target);
}

// ── 열람 스코프 ∩ 대상 시장 (B1, 운영 결정 2026-09-03) ────────────────────
//
// ⚠️ 이 절은 위 주석("대상 시장은 권한 스코프와 다른 축")의 **예외를 하나만**
// 만든다: 글로벌 프롬프트 열람 화면(/standard/prompts)의 행 집합을 계정 국가로
// 좁힌다. 축이 합쳐진 것이 아니라, 열람 술어가 두 축의 **교집합**을 쓴다.
// (프롬프트 리전 UI 플랜 §비목표 "계정 권한과 대상 시장의 연동"을 뒤집는 결정 —
//  칩이 `Hyundai · KR` 로 국가 스코프를 약속하는데 행이 전 시장이던 배반을 없앤다.)
//
// **의사코드는 술어에서 무시한다** — 근거 3가지:
//  ① 실측(hmg 운영 DB, 2026-09-03): 활성 루트 카탈로그 12,164행 중 **의사코드만
//     가진 행 0건**. `x:WW`/`x:EU`/`x:ME`/`x:NBRAND`/`x:CPO` 는 항상 실국가 목록을
//     동반한다(예: `x:WW|AE|BE|BR|CA|DE|EG|FR|US`). 즉 시장 귀속의 정본은 실국가
//     배열이고 의사코드는 분류 슬롯이다(플랜 D10 "지리축 오염 방지"와 같은 결).
//  ② 의사코드를 국가로 펼치면(예: `x:EU` → 유럽 48개국) **에디토리얼 시트가 태깅
//     하지 않은 시장까지 열람이 넓어진다** — default-deny 와 반대 방향이다.
//  ③ 넓히는 결정은 나중에 additive 하게 가능하지만, 좁히는 방향은 이미 보이던 것을
//     빼앗는 것이라 되돌리기 어렵다.
//
// 다만 **의사코드만 가진 행은 "시장 미지정(상속)"으로 취급해 보인다** — ①의 실측이
// 미래 데이터에서 깨져도 그 행이 전 계정에서 조용히 사라지지 않게 하는 안전판이다.

/**
 * 계정 스코프의 허용 국가가 이 행의 대상 시장을 포함하는가 (열람 술어의 순수 정의).
 *
 * - `allowed` 가 비면(= `effectiveScopeCountries` 가 undefined: admin/`scope.all`)
 *   제한 없음 → 항상 true.
 * - 실국가 태그가 없으면(NULL·빈 배열·의사코드만) **미지정 = 상속 = 전 시장** → true.
 * - 그 외에는 실국가 겹침.
 *
 * SQL 정본은 `lib/db/repositories/standards.ts::catalogMarketScopeCondition` 이며,
 * 두 구현은 **같은 규칙**이어야 한다(어긋나면 "목록엔 있는데 행이 없다"가 된다).
 */
export function marketInScope(
  regions: string[] | null | undefined,
  allowed: string[] | null | undefined,
): boolean {
  if (!allowed?.length) return true;
  const { real } = splitMarkets(regions);
  if (real.length === 0) return true;
  const set = new Set(
    allowed
      .map((c) => normalizeMarket(c))
      .filter((c): c is string => c !== null && !isPseudoRegion(c)),
  );
  if (set.size === 0) return true; // 허용값이 전부 무효 → 좁히지 않는다(빈 화면 방지)
  return real.some((c) => set.has(c));
}
