import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { READ_TIMING_LINE, countOf, timedRead } from "./read-timing";

// A0 계측 로그의 계약은 둘이다: **문법이 고정**이고, **값이 새지 않는다**.
// 둘 다 로그 문자열을 눈으로 보는 것으로는 지킬 수 없어(다음 사람이 name 자리에
// `${brand}` 를 넣으면 끝이다) 여기서 기계로 고정한다.

const lines: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  lines.length = 0;
  spy = vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
});
afterEach(() => spy.mockRestore());

describe("timedRead — 로그 문법", () => {
  it("성공한 read 는 한 줄, 정규식에 맞는다", async () => {
    await timedRead("kpi-competitors/mentions", null, Promise.resolve({ brands: [1, 2, 3] }), countOf.brands);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(READ_TIMING_LINE);
    expect(lines[0]).toContain("x-hmg-read(kpi-competitors/mentions)");
    expect(lines[0]).toContain("rows:3");
    // degradeAware 라벨이 없는 read 는 "고지하는 척" 을 하지 않는다.
    expect(lines[0]).toContain("degraded:na");
  });

  it("라벨이 있으면 degrade 판정이 true/false 로 찍힌다(요청 스코프 밖은 false)", async () => {
    await timedRead("x/y", "someLabel", Promise.resolve([]), countOf.array);
    expect(lines[0]).toMatch(READ_TIMING_LINE);
    expect(lines[0]).toContain("degraded:false");
  });

  it("행 수 추출기가 던져도 값을 찍지 않고 rows:err 로 닫는다", async () => {
    await timedRead("x/y", null, Promise.resolve({ brands: null }), () => {
      throw new Error("boom");
    });
    expect(lines[0]).toMatch(READ_TIMING_LINE);
    expect(lines[0]).toContain("rows:err");
  });

  it("음수·소수·NaN 행 수는 정규화된다(문법이 깨지지 않는다)", async () => {
    await timedRead("x/y", null, Promise.resolve(0), () => -3.7);
    await timedRead("x/y", null, Promise.resolve(0), () => Number.NaN);
    for (const l of lines) expect(l).toMatch(READ_TIMING_LINE);
    expect(lines[0]).toContain("rows:0");
    expect(lines[1]).toContain("rows:err");
  });
});

describe("timedRead — 관측만 한다(값·거부 전파)", () => {
  it("값을 그대로 돌려준다", async () => {
    const v = { brands: [] as unknown[] };
    expect(await timedRead("x/y", null, Promise.resolve(v), countOf.brands)).toBe(v);
  });

  it("거부를 그대로 다시 던지고, 예외 **메시지는 로그에 없다**", async () => {
    const secret = "brand=Hyundai country=KR user@example.com";
    await expect(
      timedRead("x/y", "lbl", Promise.reject(new Error(secret)), countOf.array),
    ).rejects.toThrow(secret);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(READ_TIMING_LINE);
    expect(lines[0]).not.toContain("Hyundai");
    expect(lines[0]).not.toContain("example.com");
  });
});

describe("누출 금지 — 값은 어느 경로로도 로그에 닿지 않는다", () => {
  it("read 결과에 담긴 필터·계정 값이 로그에 나타나지 않는다", async () => {
    await timedRead(
      "kpi-competitors/mentions",
      "standardMentions",
      Promise.resolve({
        brands: [{ name: "Hyundai" }, { name: "Kia" }],
        filters: { region: ["KR"], engine: ["chatgpt"] },
        user: "geo-ops@example.com",
      }),
      countOf.brands,
    );
    const line = lines[0];
    expect(line).toMatch(READ_TIMING_LINE);
    for (const leak of ["Hyundai", "Kia", "KR", "chatgpt", "example.com"]) {
      expect(line, leak).not.toContain(leak);
    }
  });
});

// ── 호출부 계약 — name 은 **리터럴**이어야 한다 ────────────────────────────
//
// 위 단언들은 이 모듈이 값을 안 찍는다는 것만 증명한다. 호출부가 `timedRead(\`${brand}\`, …)`
// 로 쓰면 그 방어는 통째로 무의미해지므로 소스를 직접 대조한다
// (`dashboard/degrade-labels.test.ts` 가 라벨 정합에 쓰는 것과 같은 자세).
//
// ⚠️ 호출부 목록을 **손으로 들고 있지 않는다** — 종전엔 page.tsx 두 개만 봤고, 그 목록은
// 조립이 페이지에서 읽기 계층(`lib/scope/server.ts`)으로 내려가는 순간 새 호출부를 통째로
// 놓쳤다(PR④ B1/B2 머지). 규율이 "고정된 두 파일"이 아니라 **`timedRead` 를 부르는 모든
// 파일**에 걸리도록 소스 트리를 훑어서 찾는다.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_DIRS = ["app", "lib", "components"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 주석 **줄**을 걷어낸다 — 이 파일의 스캐너는 `timedRead(` 를 문자열로 찾으므로, 코드를
 * 설명하느라 그 문자열을 적은 주석이 "호출부" 로 잡힌다. 통째 주석 줄(`//`·`*`·`/*`)만
 * 지우고 코드 줄은 손대지 않는다 — 코드 뒤 꼬리 주석에 적으면 여전히 실패하는데, 그건
 * 엄격한 쪽의 오답이라 받아들인다(적지 않으면 그만이다).
 */
function stripCommentLines(src: string): string {
  return src
    .split("\n")
    .map((l) => (/^\s*(?:\/\/|\*|\/\*)/.test(l) ? "" : l))
    .join("\n");
}

/** `timedRead(` 를 실제로 부르는 파일 전부 — [리포 상대경로, 주석 제거한 소스]. */
const CALLSITES: Array<[string, string]> = SCAN_DIRS.flatMap((d) => walk(`${REPO_ROOT}/${d}`))
  .map(
    (f) =>
      [f.slice(REPO_ROOT.length + 1), stripCommentLines(readFileSync(f, "utf8"))] as [string, string],
  )
  .filter(([, src]) => /\btimedRead\s*\(/.test(src));

/** 첫 인자(read 이름)를 전부 뽑는다 — 리터럴이 아니면 `null`. */
function readNames(src: string): Array<string | null> {
  return [...src.matchAll(/timedRead\(\s*([^\s,]+)/g)].map((m) => {
    const a = m[1];
    return /^"[a-zA-Z0-9._/:-]+"$/.test(a) ? a.slice(1, -1) : null;
  });
}

describe("호출부 — 계측이 실제로 걸려 있고, 인자가 리터럴이다", () => {
  it("소스 트리에서 호출부를 실제로 찾아낸다(스캔이 조용히 0건이 되지 않는다)", () => {
    expect(CALLSITES.length, CALLSITES.map(([f]) => f).join(", ")).toBeGreaterThanOrEqual(2);
    // 조립이 읽기 계층으로 내려간 뒤로 경쟁사 경계의 계측은 여기 산다.
    expect(CALLSITES.map(([f]) => f)).toContain("lib/scope/server.ts");
  });

  it("경쟁사 경계 read + 웹 경계 2 read 가 전부 timedRead 를 지난다", () => {
    const names = new Set(CALLSITES.flatMap(([, src]) => readNames(src)));
    for (const n of [
      // 두 분기가 **함께** 쓰는 둘 + off 분기(넷 병렬) 둘.
      "kpi-competitors/mentions",
      "kpi-competitors/citationDomains",
      "kpi-competitors/brandTrend",
      "kpi-competitors/firstPosition",
      // on 분기(`S1.competitors`)의 회차 축 2단 — 이름이 갈려야 두 모양을 비교할 수 있다.
      "kpi-competitors/competitorBrandTrend",
      "kpi-competitors/competitorFirstPosition",
      // 웹사이트 지면.
      "summary-deltas/subKpis",
      "summary-deltas/trend",
    ]) {
      expect([...names], n).toContain(n);
    }
  });

  // ── 게이트 프로브도 read 와 같은 등급이다 (PR⑤ U3) ────────────────────────
  //
  // 접힘 프로브는 요청마다 무조건 DB 를 치는데 `foldGated` 의 첫 인자라 A0 계측 밖에
  // 있었다 — 그래서 pgss mean 461 ms · 요청 DB 버퍼의 46% 를 먹는 문장이 **로그에
  // 한 줄도 안 남긴 채** 두 PR 을 지나갔다(§2-4). 그 자리를 여기서 못박는다.
  it("게이트 프로브(접힘) 4갈래가 전부 timedRead 를 지난다", () => {
    const names = new Set(CALLSITES.flatMap(([, src]) => readNames(src)));
    for (const n of [
      "fold/global.own", // S1 카드·GEO·S3 인용
      "fold/global.own-domains", // kpi-extras(코어 추이)
      "fold/global.own-domains-brands", // kpi-competitors — 이 사건의 장본인
      "fold/website.own", // 웹사이트 지면
    ]) {
      expect([...names], n).toContain(n);
    }
  });

  it("`timedRead(` 의 첫 인자는 전부 따옴표 리터럴이다(템플릿·변수 금지)", () => {
    let calls = 0;
    for (const [file, src] of CALLSITES) {
      for (const m of src.matchAll(/timedRead\(\s*([^\s,]+)/g)) {
        calls++;
        expect(m[1], `${file}: ${m[1]}`).toMatch(/^"[a-zA-Z0-9._/:-]+"$/);
      }
    }
    expect(calls, "호출부 수").toBeGreaterThanOrEqual(8);
  });

  it("read 이름은 서로 다르다(같은 이름 두 read = 귀속 불가)", () => {
    const names = CALLSITES.flatMap(([, src]) => readNames(src));
    expect(new Set(names).size, names.join(", ")).toBe(names.length);
  });

  it("두 번째 인자(degrade 라벨)는 리터럴 또는 null 이다", () => {
    for (const [file, src] of CALLSITES) {
      for (const m of src.matchAll(/timedRead\(\s*"[^"]+",\s*([^\s,]+)/g)) {
        expect(m[1], `${file}: ${m[1]}`).toMatch(/^(?:"[a-zA-Z]+"|null)$/);
      }
    }
  });
});

// ── 게이트 프로브 계측이 **호출부에 실제로 걸려 있는가** (PR⑤ U3 검증 지적 K③) ──
//
// 위 "게이트 프로브 4갈래" 테스트만으로는 부족하다. 스캐너는 `timedRead("<리터럴>"` 의
// **문자열 존재**만 보는데, 그 리터럴 4개는 `server.ts` 의 `timedFoldProbe` 함수 본문에
// 산다. 그래서 **호출부 3곳을 전부 지워도** 그 테스트는 통과한다(실측 2026-09-11:
// 세 호출을 떼고 `vitest run lib/perf` 23/23 · `tsc` 0 · `lint` 0 — 가드가 아무것도
// 막지 못했다). U3 의 목적이 "계측 없이 조용히 다시 자라는 것을 로그에서 보이게" 인데
// 그 목적을 정작 이 가드가 못 지킨다.
//
// 그래서 여기서는 **문자열이 아니라 배선**을 본다: `server.ts` 안에서 접힘 프로브를
// 부르는 자리가 **하나도 빠짐없이** `timedFoldProbe(...)` 로 감싸여 있는가.
// 감싸는 것을 빼면 실패하고, 새 프로브 호출부를 계측 없이 추가해도 실패한다.
const SERVER_TS = "lib/scope/server.ts";
const SERVER_SRC = stripCommentLines(readFileSync(`${REPO_ROOT}/${SERVER_TS}`, "utf8"));

/** `open` 위치의 여는 괄호부터 짝이 맞는 닫는 괄호까지를 잘라 낸다(셀 본문 한정용). */
function balanced(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}

/** React `cache()` 셀 하나의 본문 — 선언에서 짝 맞는 괄호까지. */
function cellBody(name: string): string {
  const at = SERVER_SRC.indexOf(`const ${name} = cache(`);
  expect(at, `${SERVER_TS}: \`const ${name} = cache(\` 를 못 찾았다`).toBeGreaterThan(-1);
  return balanced(SERVER_SRC, SERVER_SRC.indexOf("(", at + `const ${name} = `.length));
}

describe("게이트 프로브 — 계측이 호출부에 걸려 있다(문자열이 아니라 배선)", () => {
  it("`trendFoldPresent(` 호출은 전부 `timedFoldProbe(...)` 안에 있다", () => {
    // import 문에는 `(` 가 없으므로 아래 정규식이 잡는 것은 **호출**뿐이다.
    const calls = [...SERVER_SRC.matchAll(/\btrendFoldPresent\(/g)];
    // 감싼 것: 같은 문장(`;` 를 넘지 않는 범위) 안에서 timedFoldProbe 가 앞선다.
    const wrapped = [...SERVER_SRC.matchAll(/\btimedFoldProbe\([^;]*?\btrendFoldPresent\(/g)];
    expect(calls.length, `${SERVER_TS}: 접힘 프로브 호출 수`).toBe(3);
    expect(
      wrapped.length,
      `${SERVER_TS}: 계측되지 않은 접힘 프로브 호출이 ${calls.length - wrapped.length}곳 있다`,
    ).toBe(calls.length);
  });

  it("`timedFoldProbe(` 호출은 정확히 3회다(정의 1줄 제외)", () => {
    const all = [...SERVER_SRC.matchAll(/\btimedFoldProbe\(/g)].length;
    const defs = [...SERVER_SRC.matchAll(/function\s+timedFoldProbe\(/g)].length;
    expect(defs, "정의는 한 벌이다").toBe(1);
    expect(all - defs, `${SERVER_TS}: timedFoldProbe 호출 수`).toBe(3);
  });

  it("세 캐시 셀이 각각 자기 안에서 프로브를 계측한다", () => {
    // 셀 안이어야 문장 1개당 로그 1줄이다 — `foldGated` 호출부에 걸면 같은 셀을
    // 기다리는 호출부 수만큼 줄이 늘고 두 번째부터 0 ms 로 찍혀 귀속이 흐려진다.
    for (const cell of [
      "cachedGlobalFoldPresent",
      "cachedGlobalSeriesFoldPresent",
      "cachedWebsiteFoldPresent",
    ]) {
      const body = cellBody(cell);
      expect(body, `${cell}: 계측(timedFoldProbe) 이 셀 안에 없다`).toContain("timedFoldProbe(");
      expect(body, `${cell}: 프로브 호출이 셀 안에 없다`).toContain("trendFoldPresent(");
    }
  });
});
