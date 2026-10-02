/**
 * 발행 리포트 sb-data 파서 — 오프라인 테스트(DB 접속 없음).
 *
 * 픽스처는 실제 9/11 발행물(vol.2 v3.0 Global, 2026-09-15 발행)의 sb-data 에서
 * **정수 쌍과 국가·브랜드·상태 코드만** 뽑은 축약본이다. 고객 프롬프트 원문(`promptEx`)·
 * 사이트별 URL·감사 지표는 **의도적으로 들어 있지 않다** — 이 리포는 조직으로 단방향
 * 미러되므로 고객 데이터를 싣지 않는다(secrets-handling 룰과 같은 자세).
 *
 * 이 파일이 잡아야 하는 것:
 *   · 헤드라인 풀 역산이 **유일해**를 낸다(추측으로 모수가 정해지지 않는다)
 *   · 발행물이 자기 자신에 대해 말하는 요약 전부가 sites[] 에서 재현된다
 *   · 구버전 sb-data 가 **조용히 통과하지 않는다**
 *   · 검산이 깨지면 적재 경로가 **던진다**(변이 테스트로 감지력 확인)
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertChecksPass,
  brandScopeOf,
  deriveHeadlinePool,
  extractSbData,
  parsePublication,
  pct1,
  pct2,
  SB_DATA_VERSION,
} from "./sb-data";

const FIXTURE = path.join(__dirname, "__fixtures__", "sbdata-vol2-global-20260915.min.json");
const raw = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
/** 매 테스트가 자기 사본을 만지도록(변이 테스트가 옆 테스트를 오염시키지 않게). */
const clone = () => JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

describe("픽스처 자체 — 고객 데이터가 섞여 있지 않다", () => {
  it("프롬프트 원문·URL·긴 자유 문자열이 없다", () => {
    const blob = fs.readFileSync(FIXTURE, "utf8");
    expect(blob).not.toContain("http");
    expect(blob).not.toContain(".com");
    // 40자를 넘는 문자열 값이 있으면 코드·라벨이 아니라 문장이라는 뜻이다.
    expect(blob.match(/"[^"]{41,}"/g)).toBeNull();
    expect(raw.promptEx).toBeUndefined();
    expect(raw.trendSite).toBeUndefined();
  });
});

describe("extractSbData", () => {
  it("script 태그에서 JSON 을 뽑는다", () => {
    const html = `<html><body><script id="sb-data" type="application/json">{"a":1}</script></body></html>`;
    expect(extractSbData(html)).toEqual({ a: 1 });
  });

  it("속성 순서가 달라도 찾는다", () => {
    const html = `<script type='application/json' id='sb-data'>{"a":2}</script>`;
    expect(extractSbData(html)).toEqual({ a: 2 });
  });

  it("없으면 던진다 (엉뚱한 파일을 조용히 적재하지 않는다)", () => {
    expect(() => extractSbData("<html><body>리포트가 아니다</body></html>")).toThrow(/sb-data/);
  });

  it("JSON 이 깨져 있으면 던진다", () => {
    expect(() => extractSbData(`<script id="sb-data">{</script>`)).toThrow(/파싱 실패/);
  });
});

describe("헤드라인 풀 역산 — 유일해", () => {
  it("9/11 발행물에서 제외 유닛은 u=109(CPO) 하나뿐이다", () => {
    const sites = (clone().sites ?? []) as never[];
    const d = deriveHeadlinePool(clone() as never, sites);
    expect(d.excludedFileSeqs).toEqual([109]);
    // 방법을 기록한다 — 다음 사람이 "어떻게 정했나" 를 코드를 읽지 않고 알 수 있게.
    expect(d.method).toContain("유일해");
    expect(d.method).toContain("u=109");
  });

  it("105개를 하나씩 빼 보면 네 값을 동시에 재현하는 것은 하나뿐이다 (유일성의 근거)", () => {
    const root = clone() as {
      sites: Array<Record<string, number[]>>;
      curAvg: { k6: number; o6: number; sub: number };
      prevAvg: { g6: number };
    };
    const sum = (ss: Array<Record<string, number[]>>, k: string): [number, number] =>
      ss.reduce<[number, number]>((a, s) => [a[0] + s[k][0], a[1] + s[k][1]], [0, 0]);
    let hits = 0;
    for (const cand of root.sites) {
      const rest = root.sites.filter((s) => s !== cand);
      const c6 = sum(rest, "c6");
      const co = sum(rest, "co");
      const cs = sum(rest, "cs");
      const q6 = sum(rest, "q6");
      if (
        pct2(c6[0], c6[1]) === root.curAvg.k6 &&
        pct2(co[0], co[1]) === root.curAvg.o6 &&
        pct2(cs[0], cs[1]) === root.curAvg.sub &&
        pct2(q6[0], q6[1]) === root.prevAvg.g6
      ) {
        hits += 1;
      }
    }
    expect(hits).toBe(1);
  });

  it("후보가 여러 개면 던진다 — 추측으로 모수를 정하지 않는다", () => {
    // 값이 똑같은 사이트가 둘이면 어느 쪽을 빼도 합이 같아 **둘 다 후보**가 된다.
    // 그런 발행물이 오면 모수를 고를 근거가 없으므로 멈춰야 한다.
    const twin = {
      u: "001", b: "Hyundai", c: "A", l: "EN", r: "WW", s: "진행중",
      c6: [1, 2], co: [2, 2], cs: [3, 4], q6: [1, 2], qo: [2, 2], np: 2, na: 4,
    };
    const sites = [
      { ...twin },
      { ...twin, u: "002" },
      {
        u: "003", b: "Kia", c: "B", l: "EN", r: "WW", s: "진행중",
        c6: [8, 10], co: [9, 10], cs: [15, 20], q6: [7, 10], qo: [8, 10], np: 10, na: 20,
      },
    ];
    // 쌍둥이 하나를 빼면 남는 합: c6 9/12=75.00 · co 11/12=91.67 · cs 18/24=75.00 · q6 8/12=66.67
    const root = {
      sites,
      bench: { n: 2, nAll: 3 },
      curAvg: { k6: 75, o6: 91.67, sub: 75 },
      prevAvg: { g6: 66.67 },
    };
    expect(() => deriveHeadlinePool(root as never, sites as never[])).toThrow(/후보가 2개/);
  });

  it("2개 이상 제외하는 발행물은 거부한다 (조합 탐색 = 유일성 보장 불가)", () => {
    const root = clone() as { bench: { n: number } };
    root.bench.n -= 1;
    expect(() => deriveHeadlinePool(root as never, (root as never as { sites: never[] }).sites)).toThrow(
      /2개가 빠진 발행물은 이번 판이 지원하지 않는다/,
    );
  });

  it("sites 수와 bench.nAll 이 다르면 던진다", () => {
    const root = clone() as { bench: { nAll: number } };
    root.bench.nAll += 1;
    expect(() => deriveHeadlinePool(root as never, (root as never as { sites: never[] }).sites)).toThrow(
      /일관되지 않다/,
    );
  });
});

describe("parsePublication — 9/11 발행물", () => {
  const parsed = parsePublication(clone());

  it("검산이 전부 통과한다", () => {
    const bad = parsed.checks.filter((c) => !c.ok);
    expect(bad.map((b) => `${b.name}: ${b.expected} vs ${b.actual}`)).toEqual([]);
    expect(() => assertChecksPass(parsed.checks)).not.toThrow();
    // 검산이 "0건" 만 세고 끝나지 않도록 개수 하한을 둔다.
    expect(parsed.checks.length).toBeGreaterThanOrEqual(20);
  });

  it("사이트 105개 · 헤드라인 풀 104개", () => {
    expect(parsed.sites).toHaveLength(105);
    expect(parsed.sites.filter((s) => s.inHeadlinePool)).toHaveLength(104);
    expect(parsed.sites.filter((s) => !s.inHeadlinePool).map((s) => s.fileSeq)).toEqual([109]);
  });

  it("무필터 헤드라인 값 = 5,611 / 9,586 = 58.5% (리포트 표지 숫자)", () => {
    const pool = parsed.sites.filter((s) => s.inHeadlinePool);
    const n = pool.reduce((a, s) => a + s.targetHitPrompts, 0);
    const d = pool.reduce((a, s) => a + s.measuredPrompts, 0);
    expect([n, d]).toEqual([5611, 9586]);
    expect(pct2(n, d)).toBe(58.53);
    expect(pct1(n, d)).toBe(58.5);
  });

  it("105개 전부면 5,614 / 9,677 — 고객이 본 58.5 와 다르다 (모수 선택이 값을 가른다)", () => {
    const n = parsed.sites.reduce((a, s) => a + s.targetHitPrompts, 0);
    const d = parsed.sites.reduce((a, s) => a + s.measuredPrompts, 0);
    expect([n, d]).toEqual([5614, 9677]);
    expect(pct1(n, d)).toBe(58.0);
  });

  it("자사 URL 인용률 — 풀 7,584 / 9,586 · 전체 7,616 / 9,677", () => {
    const pool = parsed.sites.filter((s) => s.inHeadlinePool);
    expect([
      pool.reduce((a, s) => a + s.ownedPrompts, 0),
      pool.reduce((a, s) => a + s.ownedPromptsDen, 0),
    ]).toEqual([7584, 9586]);
    expect([
      parsed.sites.reduce((a, s) => a + s.ownedPrompts, 0),
      parsed.sites.reduce((a, s) => a + s.ownedPromptsDen, 0),
    ]).toEqual([7616, 9677]);
  });

  it("'완료' 13개 부분합 = 641 / 966 = 66.4% (제품 책임자의 대조 기준)", () => {
    const done = parsed.sites.filter((s) => s.agencyStatus === "완료");
    expect(done).toHaveLength(13);
    const n = done.reduce((a, s) => a + s.targetHitPrompts, 0);
    const d = done.reduce((a, s) => a + s.measuredPrompts, 0);
    expect([n, d]).toEqual([641, 966]);
    expect(pct1(n, d)).toBe(66.4);
  });

  it("브랜드 부분합에도 헤드라인 풀이 적용된다 (Hyundai 43개가 아니라 42개)", () => {
    const hy = parsed.sites.filter((s) => s.brand === "Hyundai");
    expect(hy).toHaveLength(43);
    const pool = hy.filter((s) => s.inHeadlinePool);
    expect(pool).toHaveLength(42);
    const n = pool.reduce((a, s) => a + s.targetHitPrompts, 0);
    const d = pool.reduce((a, s) => a + s.measuredPrompts, 0);
    expect(pct2(n, d)).toBe(65.71);
    // 제외 유닛을 넣으면 발행값과 달라진다 — 규칙이 실제로 일을 하고 있다는 증거.
    const all = [
      hy.reduce((a, s) => a + s.targetHitPrompts, 0),
      hy.reduce((a, s) => a + s.measuredPrompts, 0),
    ] as const;
    expect(pct2(all[0], all[1])).not.toBe(65.71);
  });

  it("발행물 메타 — 회차는 측정일이 아니다", () => {
    expect(parsed.meta.roundDate).toBe("2026-09-11");
    expect(parsed.meta.asofCur).toBe("2026-09-10"); // 추출 시점은 하루 앞이다
    expect(parsed.meta.prevRoundDate).toBe("2026-09-04");
    expect(parsed.meta.cycleLabel).toBe("9/11 회차");
    expect(parsed.meta.cycleLabelEn).toBe("Sep 11 cycle");
    expect(parsed.meta.engines).toEqual(["chatgpt", "gemini"]);
    expect(parsed.meta.benchN).toBe(104);
    expect(parsed.meta.benchNAll).toBe(105);
    expect(parsed.meta.excludedFs).toEqual([71, 94, 97]);
    expect(parsed.meta.publishedOn).toBe("2026-09-15");
    expect(parsed.meta.sbDataVersion).toBe(SB_DATA_VERSION);
    expect(brandScopeOf(parsed.meta.brandScopeLabel)).toBe("Global");
  });

  it("고객 제외 요청 3개는 sites[] 에 행이 없다 (모수에 섞이지 않는다)", () => {
    const present = new Set(parsed.sites.map((s) => s.fileSeq));
    for (const fs of [71, 94, 97]) expect(present.has(fs)).toBe(false);
  });

  it("리포트 밖 사이트(fs 44·106)도 없다 — 발행 회차 집계에 더할 근거가 없다", () => {
    const present = new Set(parsed.sites.map((s) => s.fileSeq));
    for (const fs of [44, 106]) expect(present.has(fs)).toBe(false);
  });

  it("조인 축 — 국가는 가상 코드를 포함하고, 언어는 소문자다", () => {
    const byFs = new Map(parsed.sites.map((s) => [s.fileSeq, s]));
    expect(byFs.get(1)?.countryCode).toBe("MX");
    expect(byFs.get(1)?.langCode).toBe("es");
    expect(byFs.get(1)?.langLabel).toBe("ES");
    expect(byFs.get(109)?.countryCode).toBe("CPO");
    // dash.brand 가 null 인 유닛도 brand 는 채워진다(sites[].b 를 쓴다).
    expect(byFs.get(40)?.brand).toBe("Hyundai");
    expect(byFs.get(41)?.brand).toBe("Hyundai");
    expect(parsed.sites.every((s) => s.brand.length > 0)).toBe(true);
  });

  it("엔진 분자는 c6[0] 의 분할이 **아니다** — 엔진 필터를 발행값으로 답할 수 없는 근거", () => {
    const byFs = new Map<number, number>();
    for (const e of parsed.engineFacts) byFs.set(e.fileSeq, (byFs.get(e.fileSeq) ?? 0) + e.targetHitPrompts);
    const site1 = parsed.sites.find((s) => s.fileSeq === 1)!;
    expect(byFs.get(1)).toBe(90); // chatgpt 47 + gemini 43
    expect(site1.targetHitPrompts).toBe(66); // 합집합은 66
    // 105개 중 대다수가 그렇다 — 예외가 아니라 성질이다.
    const mismatched = parsed.sites.filter((s) => (byFs.get(s.fileSeq) ?? 0) !== s.targetHitPrompts);
    expect(mismatched.length).toBeGreaterThan(90);
    // 그리고 엔진별 **분모는 어디에도 없다**.
    expect(Object.keys(parsed.engineFacts[0])).not.toContain("measuredPrompts");
  });

  it("직전 회차 쌍이 전 사이트에 있다 (증감을 발행값끼리 뺄 수 있다)", () => {
    expect(parsed.sites.every((s) => s.prevTargetHitPrompts !== null && s.prevMeasuredPrompts !== null)).toBe(true);
    const pool = parsed.sites.filter((s) => s.inHeadlinePool);
    const n = pool.reduce((a, s) => a + (s.prevTargetHitPrompts ?? 0), 0);
    const d = pool.reduce((a, s) => a + (s.prevMeasuredPrompts ?? 0), 0);
    expect([n, d]).toEqual([5672, 9623]);
    expect(pct2(n, d)).toBe(58.94); // = prevAvg.g6
  });
});

describe("변이 — 검산이 실제로 감지한다", () => {
  const mutate = (fn: (root: Record<string, unknown>) => void) => {
    const root = clone();
    fn(root);
    return parsePublication(root);
  };

  it("**제외 유닛**의 분자를 바꾸면 풀 합은 그대로인데 전체 대조가 깨진다", () => {
    // 헤드라인 풀 밖이라 Σ(풀) 은 흔들리지 않는다 — 그래서 역산은 여전히 109 를 고른다.
    // 그 유닛이 검산 사각지대가 아니라는 것을 trend 의 **전체** 대조가 잡아 준다.
    const p = mutate((root) => {
      const sites = root.sites as Array<{ u: string; c6: number[] }>;
      sites.find((s) => s.u === "109")!.c6[0] += 1;
    });
    expect(p.headlinePool.excludedFileSeqs).toEqual([109]);
    expect(p.checks.find((c) => c.name.includes("Σc6(풀) → curAvg.k6"))?.ok).toBe(true);
    expect(() => assertChecksPass(p.checks)).toThrow(/ctl\.tp/);
  });

  it("풀 안 사이트의 분자를 바꾸면 역산이 실패한다 (조용히 통과하지 않는다)", () => {
    expect(() =>
      mutate((root) => {
        const sites = root.sites as Array<{ u: string; c6: number[] }>;
        sites.find((s) => s.u === "001")!.c6[0] += 1;
      }),
    ).toThrow(/역산 실패/);
  });

  it("'완료' 라벨을 하나 바꾸면 trend 대조가 깨진다", () => {
    const p = mutate((root) => {
      const sites = root.sites as Array<{ s: string }>;
      const done = sites.find((s) => s.s === "완료")!;
      done.s = "진행중";
    });
    expect(() => assertChecksPass(p.checks)).toThrow(/trend\[last\]/);
  });

  it("brandAvgAll 의 n 을 바꾸면 브랜드 대조가 깨진다", () => {
    const p = mutate((root) => {
      (root.brandAvgAll as Record<string, { n: number }>).Kia.n = 39;
    });
    expect(() => assertChecksPass(p.checks)).toThrow(/brandAvgAll\.Kia\.n/);
  });

  it("고객 제외 유닛이 sites[] 로 새면 검산이 잡는다", () => {
    // 합을 흔들지 않고 **유닛 번호만** 제외 목록의 것으로 바꾼다 — 역산은 그대로
    // 통과하므로, 이 누수를 잡는 것은 오직 excluded[] 대조뿐이다.
    const p = mutate((root) => {
      const sites = root.sites as Array<{ u: string }>;
      sites.find((s) => s.u === "001")!.u = "071";
    });
    expect(p.headlinePool.excludedFileSeqs).toEqual([109]);
    const leak = p.checks.find((c) => c.name.includes("excluded[] 유닛"));
    expect(leak?.ok).toBe(false);
    expect(leak?.actual).toContain("071".replace(/^0+/, ""));
    expect(() => assertChecksPass(p.checks)).toThrow(/excluded\[\]/);
  });

  it("분모를 np 와 어긋나게 하면 잡는다", () => {
    const p = mutate((root) => {
      const sites = root.sites as Array<{ u: string; np: number }>;
      sites.find((s) => s.u === "109")!.np += 5;
    });
    const den = p.checks.filter((c) => c.name.includes("분모")).filter((c) => !c.ok);
    expect(den.length).toBeGreaterThan(0);
  });
});

describe("형식 거부", () => {
  it("구버전(v2.4 — k5·c5) 은 명확한 오류로 거부한다", () => {
    const root = clone() as { sites: Array<Record<string, unknown>> };
    const s = root.sites[0];
    delete s.co;
    s.c5 = [10, 20];
    s.k5 = 50;
    expect(() => parsePublication(root)).toThrow(/구버전 sb-data/);
  });

  it("sites[] 가 없으면 거부한다", () => {
    expect(() => parsePublication({ bench: { n: 1, nAll: 1 } })).toThrow(/sites\[\] 가 없다/);
  });

  it("정수 쌍이 아니면 거부한다", () => {
    const root = clone() as { sites: Array<Record<string, unknown>> };
    root.sites[0].c6 = [1.5, 2];
    expect(() => parsePublication(root)).toThrow(/정수 쌍이 아니다/);
  });

  it("bench 요약이 없으면 거부한다", () => {
    const root = clone() as Record<string, unknown>;
    delete root.curAvg;
    expect(() => parsePublication(root)).toThrow(/vol\.2 형식이 아니다/);
  });

  it("모르는 brand 라벨은 던진다 (조용히 Global 로 적재하지 않는다)", () => {
    expect(() => brandScopeOf("알 수 없는 범위")).toThrow(/brand_scope 로 옮길 수 없다/);
  });
});

describe("반올림", () => {
  it("pct2 는 발행물 자릿수, pct1 은 카드 자릿수", () => {
    expect(pct2(5611, 9586)).toBe(58.53);
    expect(pct1(5611, 9586)).toBe(58.5);
    expect(pct2(641, 966)).toBe(66.36);
    expect(pct1(641, 966)).toBe(66.4);
  });

  it("분모 0 은 null — 0% 와 구분한다 (측정 대기)", () => {
    expect(pct1(0, 0)).toBeNull();
    expect(pct2(0, 0)).toBeNull();
    expect(pct1(0, 10)).toBe(0);
  });
});
