/**
 * 발행 리포트 HTML 안 `<script id="sb-data">` 파서 — **순수 함수**(DB·fs·네트워크 없음).
 *
 * 왜 이 파일이 정본인가: 통합 리포트(vol.2)의 **생성기는 이 리포 안에 없다**. 워크스페이스
 * 전체에서 `sb-data` 를 가진 것은 발행된 HTML 뿐이다. 즉 값을 재현할 방법이 없고,
 * **발행물 자체가 유일한 원천**이다. 그래서 파서는 "읽어서 옮긴다" 가 아니라 "읽은 값이
 * 발행물 자신의 요약과 맞는지 검산한다" 까지 한다 — 옮기다 어긋나면 적재를 거부한다.
 *
 * ── 동일성은 백분율이 아니라 정수 쌍에 건다 ─────────────────────────────────
 * 리포트 안에 f1(소수 1자리)·f2(소수 2자리) 두 표기가 공존하고 대시보드 카드는
 * `toFixed(1)` 이다. 실수를 저장해 비교하면 반올림이 다른 오차를 가린다. 그래서 표에는
 * 분자·분모만 싣고, 검산에서만 백분율을 **발행물이 쓴 자릿수로** 맞춰 본다.
 *
 * ── 헤드라인 풀(= 벤치 평균 모수)을 **데이터에서 역산**한다 ─────────────────
 * 리포트의 표지 숫자는 105개가 아니라 104개 평균이다(`bench.n` 104 vs `bench.nAll` 105).
 * 그런데 sb-data 는 **어느 유닛이 빠졌는지 직접 말하지 않는다** — `excluded[]` 는 다른
 * 것(고객 요청으로 통째로 빠져 `sites[]` 에 행조차 없는 3개)이다.
 *
 * 그래서 Σ 검산으로 역산한다: `bench.nAll - bench.n` 개를 빼서
 *   ① Σc6 → `curAvg.k6`   ② Σco → `curAvg.o6`
 *   ③ Σcs → `curAvg.sub`  ④ Σq6 → `prevAvg.g6`
 * **네 개가 동시에** 발행값과 소수 2자리까지 맞는 조합을 찾는다. 9/11 발행물 실측에서
 * 후보는 **정확히 하나**였다(u=109 Korea (CPO), c6=[3,91]) — 105개를 하나씩 빼 본 105회
 * 중 나머지 104개는 어느 것도 네 값을 동시에 재현하지 못했다.
 *
 * 그리고 이 역산은 **독립적으로 한 번 더 확인된다**: 발행물의 `brandAvgAll` 이
 * Hyundai `n: 42` 라고 적고 있는데 `sites[].b === 'Hyundai'` 는 **43개**다. 그 43개에서
 * 같은 유닛 하나를 빼면 42개 · 2775/4223 = 65.71 로 발행값과 맞는다. 즉 리포트는
 * **브랜드 부분합에도 같은 제외를 적용한다** — 리더의 필터 규칙(아래 `HEADLINE_POOL_RULE`)
 * 이 그래서 "필터 결과 ∩ 헤드라인 풀" 이다.
 *
 * 후보가 0개거나 2개 이상이면 **던진다**. 추측으로 고객 계약 지표의 모수를 정하지 않는다.
 * 빼는 개수가 2 이상인 발행물은 조합 탐색이 되므로 이번 판에서는 거부한다(전례 없음).
 *
 * ── 지원 형식 ───────────────────────────────────────────────────────────────
 * vol.2 형식만 받는다. 구버전(v2.4)은 `k5`·`c5` 뿐이고 `co`·`o6` 가 없어 자사 인용률을
 * 낼 수 없다 — 조용히 NULL 로 적재하면 그 회차의 자사 카드가 근거 없이 비므로 **명확한
 * 오류로 거부**한다(스펙 §F 소급 적재 조건 2).
 */

/** 정수 쌍 `[분자, 분모]`. */
export type IntPair = [number, number];

/** 이 파서가 받는 sb-data 형식. 구버전은 거부한다. */
export const SB_DATA_VERSION = "vol2";

/**
 * 리더가 필터 부분합에 적용하는 헤드라인 풀 규칙 — **한 곳에 적어 두고 리더가 인용한다.**
 *
 *   발행 부분합 = (필터에 걸리는 발행 사이트) ∩ (in_headline_pool = true)
 *   단, 그 교집합이 **비면** 필터에 걸리는 발행 사이트 전체를 쓴다.
 *
 * 앞 절은 리포트 자신의 자세다(무필터 58.53 · Hyundai 65.71 둘 다 제외 적용).
 * 뒤 절은 "필터로 CPO 를 직접 고르면 CPO 값이 보여야 한다" 는 요구를 만족시킨다 —
 * 국가=CPO 를 고르면 교집합이 공집합이 되고, 그때만 제외 유닛 자신의 값(3/91)을 낸다.
 * 두 절이 충돌하지 않는 이유: 제외 유닛이 **섞여 있는** 선택에서는 항상 앞 절이 이긴다.
 */
export const HEADLINE_POOL_RULE =
  "필터 결과 ∩ 헤드라인 풀. 교집합이 비면 필터 결과 전체(제외 유닛만 고른 경우)";

export interface SbSite {
  /** `sites[].u` — website_prompts.file_seq 와 1:1. '001' 처럼 0 패딩된 문자열이다. */
  u: string;
  b: string;
  c: string;
  l: string;
  r: string;
  s: string;
  c6: IntPair;
  co: IntPair;
  cs: IntPair;
  np: number;
  na: number;
  q6: IntPair;
  qo: IntPair;
  eng?: Record<string, number>;
  engPrev?: Record<string, number>;
  dash?: { geo?: string | null; brand?: string | null; lang?: string | null };
}

export interface ParsedSiteFact {
  fileSeq: number;
  brand: string;
  countryCode: string | null;
  countryName: string | null;
  regionLabel: string | null;
  langCode: string | null;
  langLabel: string | null;
  agencyStatus: string | null;
  inHeadlinePool: boolean;
  targetHitPrompts: number;
  measuredPrompts: number;
  ownedPrompts: number;
  ownedPromptsDen: number;
  ownedAnswers: number | null;
  monitoredAnswers: number | null;
  prompts: number | null;
  answers: number | null;
  prevTargetHitPrompts: number | null;
  prevMeasuredPrompts: number | null;
  prevOwnedPrompts: number | null;
  prevOwnedPromptsDen: number | null;
  raw: SbSite;
}

export interface ParsedEngineFact {
  fileSeq: number;
  engine: string;
  targetHitPrompts: number;
  prevTargetHitPrompts: number | null;
}

/** sb-data 에서만 나오는 발행물 속성. 파일명·해시·slug 는 호출자가 덧붙인다. */
export interface ParsedPublicationMeta {
  brandScopeLabel: string;
  cycleLabel: string | null;
  cycleLabelEn: string | null;
  roundDate: string;
  prevRoundDate: string | null;
  asofCur: string | null;
  asofPrev: string | null;
  publishedOn: string | null;
  engines: string[];
  excludedFs: number[];
  benchN: number | null;
  benchNAll: number | null;
  srcCite: string | null;
  sbDataVersion: string;
}

export interface ChecksumLine {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export interface HeadlinePoolDerivation {
  /** 헤드라인 평균에서 빠지는 유닛(file_seq). 9/11 발행물에서는 [109]. */
  excludedFileSeqs: number[];
  /** 어떻게 정했는지 — 감사 로그와 보고에 그대로 싣는다. */
  method: string;
}

export interface ParsedPublication {
  meta: ParsedPublicationMeta;
  sites: ParsedSiteFact[];
  engineFacts: ParsedEngineFact[];
  headlinePool: HeadlinePoolDerivation;
  checks: ChecksumLine[];
}

// ── 작은 도구들 ──────────────────────────────────────────────────────────────

/** 발행물이 쓰는 반올림(소수 2자리). 분모 0 이면 null. */
export function pct2(n: number, d: number): number | null {
  if (d === 0) return null;
  return Math.round((n / d) * 10000) / 100;
}

/** 화면 카드가 쓰는 반올림(소수 1자리). 분모 0 이면 null = 측정 대기. */
export function pct1(n: number, d: number): number | null {
  if (d === 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

function isIntPair(v: unknown): v is IntPair {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    Number.isInteger(v[0]) &&
    Number.isInteger(v[1])
  );
}

function sumPair(sites: readonly SbSite[], key: "c6" | "co" | "cs" | "q6" | "qo"): IntPair {
  let n = 0;
  let d = 0;
  for (const s of sites) {
    n += s[key][0];
    d += s[key][1];
  }
  return [n, d];
}

function line(name: string, expected: unknown, actual: unknown): ChecksumLine {
  const e = String(expected);
  const a = String(actual);
  return { name, expected: e, actual: a, ok: e === a };
}

// ── ① HTML 에서 sb-data 뽑기 ────────────────────────────────────────────────

const SB_DATA_RE =
  /<script\b[^>]*\bid=["']sb-data["'][^>]*>([\s\S]*?)<\/script>/i;

/**
 * 발행 HTML 문자열에서 sb-data JSON 을 뽑는다. HTML 전체를 메모리에 올리지만 **반환은
 * 파싱된 객체뿐**이다 — 호출자가 원문을 들고 다니지 않게.
 */
export function extractSbData(html: string): unknown {
  const m = SB_DATA_RE.exec(html);
  if (!m) {
    throw new Error(
      '발행 HTML 에서 `<script id="sb-data">` 를 찾지 못했다 — 통합 리포트 파일이 맞는지 확인할 것',
    );
  }
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`sb-data JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── ② 형식 판정 ────────────────────────────────────────────────────────────

type SbRoot = {
  sites?: unknown;
  bench?: { g6?: number; n?: number; nAll?: number };
  curAvg?: { k6?: number; o6?: number; sub?: number; n?: number };
  prevAvg?: { g6?: number; n?: number };
  brandAvgAll?: Record<string, { k6?: number; o6?: number; n?: number }>;
  asOf?: Record<string, unknown>;
  asof?: unknown;
  rounds?: { cur?: string; prev?: string };
  roundsEn?: { cur?: string; prev?: string };
  excluded?: Array<{ u?: string }>;
  src?: { cite?: string };
  trend?: Array<Record<string, unknown>>;
  brand?: unknown;
};

const BRAND_SCOPE: Record<string, string> = {
  "HMG 전체": "Global",
  Global: "Global",
  Hyundai: "Hyundai",
  현대: "Hyundai",
  Kia: "Kia",
  기아: "Kia",
  Genesis: "Genesis",
  제네시스: "Genesis",
};

/** sb-data 루트 라벨('HMG 전체' 등) → 표에 넣는 brand_scope. 모르면 던진다. */
export function brandScopeOf(label: unknown): string {
  const key = typeof label === "string" ? label.trim() : "";
  const v = BRAND_SCOPE[key];
  if (!v) {
    throw new Error(
      `sb-data 의 brand 라벨을 brand_scope 로 옮길 수 없다: ${JSON.stringify(label)} — --brand-scope 로 명시할 것`,
    );
  }
  return v;
}

function assertVol2(root: SbRoot): SbSite[] {
  if (!Array.isArray(root.sites) || root.sites.length === 0) {
    throw new Error("sb-data 에 sites[] 가 없다");
  }
  const sites = root.sites as Array<Record<string, unknown>>;
  const legacy = sites.find((s) => s.c5 !== undefined || s.k5 !== undefined);
  if (legacy) {
    throw new Error(
      `구버전 sb-data(v2.4 계열 — k5·c5 만 있고 co·o6 가 없다)는 이번 판이 지원하지 않는다. ` +
        `자사 인용률을 낼 근거가 없어 조용히 NULL 로 적재하면 그 회차 카드가 이유 없이 비게 된다. ` +
        `지원 형식: ${SB_DATA_VERSION}`,
    );
  }
  for (const [i, s] of sites.entries()) {
    for (const k of ["c6", "co", "cs", "q6", "qo"] as const) {
      if (!isIntPair(s[k])) {
        throw new Error(`sites[${i}] (u=${String(s.u)}) 의 ${k} 가 정수 쌍이 아니다: ${JSON.stringify(s[k])}`);
      }
    }
    for (const k of ["u", "b", "s"] as const) {
      if (typeof s[k] !== "string" || !s[k]) {
        throw new Error(`sites[${i}] 의 ${k} 가 비어 있다`);
      }
    }
    if (!Number.isInteger(s.np) || !Number.isInteger(s.na)) {
      throw new Error(`sites[${i}] (u=${String(s.u)}) 의 np/na 가 정수가 아니다`);
    }
  }
  for (const k of ["bench", "curAvg", "prevAvg", "asOf"] as const) {
    if (!root[k] || typeof root[k] !== "object") {
      throw new Error(`sb-data 에 ${k} 가 없다 — vol.2 형식이 아니다`);
    }
  }
  const need: Array<[string, unknown]> = [
    ["bench.n", root.bench?.n],
    ["bench.nAll", root.bench?.nAll],
    ["curAvg.k6", root.curAvg?.k6],
    ["curAvg.o6", root.curAvg?.o6],
    ["curAvg.sub", root.curAvg?.sub],
    ["prevAvg.g6", root.prevAvg?.g6],
  ];
  for (const [name, v] of need) {
    if (typeof v !== "number") throw new Error(`sb-data 의 ${name} 가 숫자가 아니다 — vol.2 형식이 아니다`);
  }
  return sites as unknown as SbSite[];
}

// ── ③ 헤드라인 풀 역산 ──────────────────────────────────────────────────────

/**
 * `bench.n` 모집단을 데이터에서 푼다. 머리 주석의 4중 검산을 동시에 만족하는 조합만
 * 받아들이고, 유일하지 않으면 던진다.
 */
export function deriveHeadlinePool(root: SbRoot, sites: readonly SbSite[]): HeadlinePoolDerivation {
  const n = root.bench!.n as number;
  const nAll = root.bench!.nAll as number;
  if (sites.length !== nAll) {
    throw new Error(`sites[] 는 ${sites.length}개인데 bench.nAll 은 ${nAll} 이다 — 발행물이 일관되지 않다`);
  }
  const drop = nAll - n;
  if (drop < 0) throw new Error(`bench.n(${n}) 이 bench.nAll(${nAll}) 보다 크다`);
  if (drop === 0) {
    return {
      excludedFileSeqs: [],
      method: `bench.n === bench.nAll (${n}) — 전 유닛이 헤드라인 풀. 역산 불필요`,
    };
  }
  if (drop > 1) {
    throw new Error(
      `헤드라인 평균에서 ${drop}개가 빠진 발행물은 이번 판이 지원하지 않는다 ` +
        `(조합 탐색이 되어 유일성을 보장할 수 없다). bench.n=${n} · bench.nAll=${nAll}`,
    );
  }

  const want = {
    k6: root.curAvg!.k6 as number,
    o6: root.curAvg!.o6 as number,
    sub: root.curAvg!.sub as number,
    g6: root.prevAvg!.g6 as number,
  };
  const hits: SbSite[] = [];
  for (const cand of sites) {
    const rest = sites.filter((s) => s !== cand);
    const c6 = sumPair(rest, "c6");
    const co = sumPair(rest, "co");
    const cs = sumPair(rest, "cs");
    const q6 = sumPair(rest, "q6");
    if (
      pct2(c6[0], c6[1]) === want.k6 &&
      pct2(co[0], co[1]) === want.o6 &&
      pct2(cs[0], cs[1]) === want.sub &&
      pct2(q6[0], q6[1]) === want.g6
    ) {
      hits.push(cand);
    }
  }
  if (hits.length !== 1) {
    throw new Error(
      `헤드라인 풀 역산 실패: 4중 검산(curAvg.k6·o6·sub + prevAvg.g6)을 동시에 만족하는 ` +
        `제외 유닛 후보가 ${hits.length}개다(기대 1개). 후보=${hits.map((h) => h.u).join(",") || "없음"}. ` +
        `추측으로 모수를 정하지 않는다 — 발행물 형식을 확인할 것`,
    );
  }
  const only = hits[0];
  return {
    excludedFileSeqs: [Number.parseInt(only.u, 10)],
    method:
      `Σ 역산(유일해). bench.nAll(${nAll}) − bench.n(${n}) = 1 개를 빼서 ` +
      `curAvg.k6=${want.k6} · curAvg.o6=${want.o6} · curAvg.sub=${want.sub} · prevAvg.g6=${want.g6} ` +
      `네 값을 동시에 재현하는 유닛을 ${nAll}개 전수 탐색 → u=${only.u}(${only.c}) 1개만 일치`,
  };
}

// ── ④ 본체 ─────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parsePublication(raw: unknown): ParsedPublication {
  if (!raw || typeof raw !== "object") throw new Error("sb-data 가 객체가 아니다");
  const root = raw as SbRoot;
  const sites = assertVol2(root);

  const pool = deriveHeadlinePool(root, sites);
  const excluded = new Set(pool.excludedFileSeqs);

  const seen = new Set<number>();
  const facts: ParsedSiteFact[] = [];
  const engineFacts: ParsedEngineFact[] = [];
  for (const s of sites) {
    const fileSeq = Number.parseInt(s.u, 10);
    if (!Number.isInteger(fileSeq)) throw new Error(`sites[].u 를 file_seq 로 읽을 수 없다: ${s.u}`);
    if (seen.has(fileSeq)) throw new Error(`file_seq ${fileSeq} 가 sites[] 에 중복이다`);
    seen.add(fileSeq);
    facts.push({
      fileSeq,
      brand: s.b,
      countryCode: str(s.dash?.geo),
      countryName: str(s.c),
      regionLabel: str(s.r),
      // 조인 축은 소문자(website_prompts.lang_code), 표기는 대문자 원문.
      langCode: str(s.dash?.lang)?.toLowerCase() ?? str(s.l)?.toLowerCase() ?? null,
      langLabel: str(s.l),
      agencyStatus: str(s.s),
      inHeadlinePool: !excluded.has(fileSeq),
      targetHitPrompts: s.c6[0],
      measuredPrompts: s.c6[1],
      ownedPrompts: s.co[0],
      ownedPromptsDen: s.co[1],
      ownedAnswers: s.cs[0],
      monitoredAnswers: s.cs[1],
      prompts: s.np,
      answers: s.na,
      prevTargetHitPrompts: s.q6[0],
      prevMeasuredPrompts: s.q6[1],
      prevOwnedPrompts: s.qo[0],
      prevOwnedPromptsDen: s.qo[1],
      raw: s,
    });
    for (const [engine, v] of Object.entries(s.eng ?? {})) {
      if (!Number.isInteger(v)) continue;
      const prev = s.engPrev?.[engine];
      engineFacts.push({
        fileSeq,
        engine,
        targetHitPrompts: v,
        prevTargetHitPrompts: Number.isInteger(prev) ? (prev as number) : null,
      });
    }
  }

  const asOf = (root.asOf ?? {}) as Record<string, unknown>;
  const roundDate = str(asOf.curLabel);
  if (!roundDate) throw new Error("sb-data 의 asOf.curLabel(회차 라벨 날짜)이 없다");

  const meta: ParsedPublicationMeta = {
    brandScopeLabel: typeof root.brand === "string" ? root.brand : "",
    cycleLabel: str(root.rounds?.cur),
    cycleLabelEn: str(root.roundsEn?.cur),
    roundDate,
    prevRoundDate: str(asOf.prevLabel),
    asofCur: str(asOf.cur),
    asofPrev: str(asOf.prev),
    publishedOn: str(root.asof),
    engines: str(asOf.engines)
      ? (asOf.engines as string).split(",").map((x) => x.trim()).filter(Boolean)
      : [],
    excludedFs: (root.excluded ?? [])
      .map((e) => Number.parseInt(String(e?.u ?? ""), 10))
      .filter((n) => Number.isInteger(n)),
    benchN: root.bench?.n ?? null,
    benchNAll: root.bench?.nAll ?? null,
    srcCite: str(root.src?.cite),
    sbDataVersion: SB_DATA_VERSION,
  };

  return { meta, sites: facts, engineFacts, headlinePool: pool, checks: buildChecks(root, sites, excluded) };
}

// ── ⑤ 검산 ─────────────────────────────────────────────────────────────────

/**
 * 발행물이 자기 자신에 대해 말하는 요약(bench·curAvg·prevAvg·brandAvgAll·trend)을
 * `sites[]` 에서 다시 계산해 대조한다. 하나라도 어긋나면 적재를 거부한다 —
 * 옮기다 틀린 것과 발행물이 원래 그런 것을 여기서 가른다.
 */
function buildChecks(root: SbRoot, sites: readonly SbSite[], excluded: ReadonlySet<number>): ChecksumLine[] {
  const out: ChecksumLine[] = [];
  const pool = sites.filter((s) => !excluded.has(Number.parseInt(s.u, 10)));
  const bench = root.bench!;
  const curAvg = root.curAvg!;
  const prevAvg = root.prevAvg!;

  out.push(line("사이트 수 = bench.nAll", bench.nAll, sites.length));
  out.push(line("헤드라인 풀 크기 = bench.n", bench.n, pool.length));
  out.push(line("curAvg.n = bench.n", bench.n, curAvg.n ?? bench.n));

  const c6p = sumPair(pool, "c6");
  out.push(line(`Σc6(풀) → curAvg.k6  [${c6p[0]}/${c6p[1]}]`, curAvg.k6, pct2(c6p[0], c6p[1])));
  if (typeof bench.g6 === "number") {
    out.push(line(`Σc6(풀) → bench.g6  [${c6p[0]}/${c6p[1]}]`, bench.g6, pct2(c6p[0], c6p[1])));
  }
  const cop = sumPair(pool, "co");
  out.push(line(`Σco(풀) → curAvg.o6  [${cop[0]}/${cop[1]}]`, curAvg.o6, pct2(cop[0], cop[1])));
  const csp = sumPair(pool, "cs");
  out.push(line(`Σcs(풀) → curAvg.sub [${csp[0]}/${csp[1]}]`, curAvg.sub, pct2(csp[0], csp[1])));
  const q6p = sumPair(pool, "q6");
  out.push(line(`Σq6(풀) → prevAvg.g6 [${q6p[0]}/${q6p[1]}]`, prevAvg.g6, pct2(q6p[0], q6p[1])));

  // 브랜드 부분합 — 헤드라인 풀 규칙의 **독립 확인**(Hyundai n=42 ≠ sites 43).
  for (const [brand, avg] of Object.entries(root.brandAvgAll ?? {})) {
    const sub = pool.filter((s) => s.b === brand);
    out.push(line(`brandAvgAll.${brand}.n`, avg?.n, sub.length));
    if (typeof avg?.k6 === "number") {
      const p = sumPair(sub, "c6");
      out.push(line(`brandAvgAll.${brand}.k6 [${p[0]}/${p[1]}]`, avg.k6, pct2(p[0], p[1])));
    }
    if (typeof avg?.o6 === "number") {
      const p = sumPair(sub, "co");
      out.push(line(`brandAvgAll.${brand}.o6 [${p[0]}/${p[1]}]`, avg.o6, pct2(p[0], p[1])));
    }
  }

  // 추이 마지막 점 — '완료' 그룹과 대조군이 전 사이트를 남김없이 두 조각으로 가른다.
  const last = root.trend?.[root.trend.length - 1] as
    | { n?: number; tp?: number; mp?: number; rate?: number; ctl?: { n?: number; tp?: number; mp?: number } }
    | undefined;
  if (last) {
    const done = sites.filter((s) => s.s === "완료");
    const dp = sumPair(done, "c6");
    out.push(line("trend[last].n = '완료' 사이트 수", last.n, done.length));
    out.push(line("trend[last].tp = Σc6[0]('완료')", last.tp, dp[0]));
    out.push(line("trend[last].mp = Σc6[1]('완료')", last.mp, dp[1]));
    if (typeof last.rate === "number") {
      out.push(line(`trend[last].rate [${dp[0]}/${dp[1]}]`, last.rate, pct2(dp[0], dp[1])));
    }
    const all = sumPair(sites, "c6");
    if (last.ctl) {
      out.push(line("trend[last] n + ctl.n = 전체", sites.length, (last.n ?? 0) + (last.ctl.n ?? 0)));
      out.push(line("trend[last] tp + ctl.tp = Σc6[0](전체)", all[0], (last.tp ?? 0) + (last.ctl.tp ?? 0)));
      out.push(line("trend[last] mp + ctl.mp = Σc6[1](전체)", all[1], (last.mp ?? 0) + (last.ctl.mp ?? 0)));
    }
  }

  // 고객 제외 요청 유닛은 sites[] 에 **행 자체가 없어야** 한다(모수에 섞이면 안 된다).
  const present = new Set(sites.map((s) => Number.parseInt(s.u, 10)));
  const leaked = (root.excluded ?? [])
    .map((e) => Number.parseInt(String(e?.u ?? ""), 10))
    .filter((n) => Number.isInteger(n) && present.has(n));
  out.push(line("excluded[] 유닛이 sites[] 에 없다", "0건", `${leaked.length}건${leaked.length ? ` (${leaked.join(",")})` : ""}`));

  // 사이트별 분모 정합 — 두 카드가 같은 분모를 쓴다는 구조적 전제.
  const bad = {
    c6den: sites.filter((s) => s.c6[1] !== s.np).length,
    coden: sites.filter((s) => s.co[1] !== s.np).length,
    csden: sites.filter((s) => s.cs[1] !== s.na).length,
    over: sites.filter((s) => s.c6[0] > s.c6[1] || s.co[0] > s.co[1] || s.cs[0] > s.cs[1]).length,
  };
  out.push(line("c6 분모 = np (전 사이트)", "0건 불일치", `${bad.c6den}건 불일치`));
  out.push(line("co 분모 = np (전 사이트)", "0건 불일치", `${bad.coden}건 불일치`));
  out.push(line("cs 분모 = na (전 사이트)", "0건 불일치", `${bad.csden}건 불일치`));
  out.push(line("분자 ≤ 분모 (전 사이트)", "0건 위반", `${bad.over}건 위반`));

  return out;
}

/** 검산이 하나라도 어긋나면 던진다. 적재 경로가 이것을 통과해야 쓴다. */
export function assertChecksPass(checks: readonly ChecksumLine[]): void {
  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) return;
  throw new Error(
    `발행물 검산 ${bad.length}건 실패 — 적재를 거부한다:\n` +
      bad.map((c) => `  · ${c.name}: 기대 ${c.expected} · 실제 ${c.actual}`).join("\n"),
  );
}
