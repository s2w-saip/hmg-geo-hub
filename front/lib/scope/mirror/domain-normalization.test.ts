// 인용 도메인 정규화가 **리포에 한 벌만** 존재하도록 강제한다.
//
// 배경(2026-08-24 RCA): `TWO_LEVEL_TLDS` 하드코딩 사본이 **3벌**이었고 서로 달랐다
// (lib/geo-catalog 24개 · lib/scope/mirror/sync.ts 8개 · lib/scope/result-adapter.ts 8개).
// 저장 경로인 sync.ts 가 가장 작은 사본을 써서 `scope_citations.domain` 에 잘린 값을
// 넣었고, 읽기 경로에 재계산이 없어 71,825행(3.04%)이 영구 손상됐다. 실호스트 3,122종이
// 접미사 207종으로 붕괴했고 그중 39,447행(54.9%)이 HMG 국가별 공식 사이트였다.
//
// 이 파일이 막는 것은 "그 결함의 재발"이 아니라 **그 결함의 원인(사본)** 이다.
// 사본이 없으면 8→24 같은 부분 확장으로 어긋날 여지 자체가 없다.
//
// 정본: lib/public-suffix (PSL 스냅샷 + registrableDomainOfHost).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { registrableDomainOfHost } from "@/lib/public-suffix";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCAN_DIRS = ["lib", "app", "components", "scripts", "hooks", "i18n"];
const SCAN_EXT = new Set([".ts", ".tsx", ".mts", ".mjs", ".js"]);

/** 정본 구현 자신 — 여기서만 접미사 데이터를 갖는 것이 허용된다. */
const ALLOWED = [
  path.join("lib", "public-suffix"),
  path.join("scripts", "generate-public-suffixes.ts"),
  // 이 테스트 파일 자신(아래 패턴 문자열을 본문에 담고 있다)
  path.join("lib", "scope", "mirror", "domain-normalization.test.ts"),
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (SCAN_EXT.has(path.extname(name))) out.push(full);
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(REPO_ROOT, d));
  return out;
}

function isAllowed(file: string): boolean {
  const rel = path.relative(REPO_ROOT, file);
  return ALLOWED.some((a) => rel === a || rel.startsWith(`${a}${path.sep}`) || rel.startsWith(a));
}

/** 코드 줄만 본다 — 주석은 RCA 서술에 이 이름들을 그대로 인용한다. */
function codeLines(src: string): { line: string; no: number }[] {
  const out: { line: string; no: number }[] = [];
  let inBlock = false;
  src.split("\n").forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    const block = line.indexOf("/*");
    if (block !== -1) {
      const end = line.indexOf("*/", block + 2);
      if (end === -1) {
        inBlock = true;
        line = line.slice(0, block);
      } else {
        line = line.slice(0, block) + line.slice(end + 2);
      }
    }
    const slash = line.indexOf("//");
    if (slash !== -1) line = line.slice(0, slash);
    if (line.trim()) out.push({ line, no: i + 1 });
  });
  return out;
}

describe("eTLD 정규화 구현은 리포에 하나뿐이다", () => {
  const files = sourceFiles().filter((f) => !isAllowed(f));

  it("스캔 대상이 실제로 잡혔다 (경로가 틀리면 이 테스트는 아무것도 막지 못한다)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(path.join("lib", "scope", "mirror", "sync.ts")))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join("lib", "geo-catalog", "owned.ts")))).toBe(true);
  });

  it("하드코딩 접미사 목록 상수를 다시 만들지 않는다", () => {
    // 이름으로 잡는 1차 그물. 사본 3벌이 전부 이 이름이었다.
    const NAMED = /\b(?:TWO_LEVEL|MULTI_PART|SECOND_LEVEL|KNOWN)_(?:TLD|TLDS|SUFFIX|SUFFIXES)\b/;
    const hits: string[] = [];
    for (const f of files) {
      for (const { line, no } of codeLines(readFileSync(f, "utf8"))) {
        if (NAMED.test(line)) hits.push(`${path.relative(REPO_ROOT, f)}:${no}`);
      }
    }
    expect(hits, "lib/public-suffix 만이 접미사 목록을 가질 수 있다").toEqual([]);
  });

  it("접미사 문자열을 3개 이상 모아 둔 리터럴 뭉치를 만들지 않는다", () => {
    // 이름을 바꿔 우회하는 것을 막는 2차 그물 — 목록의 '모양'을 본다.
    // "co.kr" 류 public suffix 리터럴이 좁은 창 안에 3개 이상 모이면 실패.
    const SUFFIX_LITERAL = /["'`](com|co|ne|or|go|ac|net|org|gov|edu|gouv)\.[a-z]{2,3}["'`]/g;
    const WINDOW = 6;
    const hits: string[] = [];
    for (const f of files) {
      const lines = codeLines(readFileSync(f, "utf8"));
      for (let i = 0; i < lines.length; i += 1) {
        const chunk = lines.slice(i, i + WINDOW).map((l) => l.line).join("\n");
        const found = new Set(chunk.match(SUFFIX_LITERAL) ?? []);
        if (found.size >= 3) {
          hits.push(
            `${path.relative(REPO_ROOT, f)}:${lines[i]!.no} → ${[...found].join(", ")}`,
          );
          i += WINDOW;
        }
      }
    }
    expect(hits, "접미사 목록은 lib/public-suffix 의 PSL 스냅샷만 가진다").toEqual([]);
  });

  it("`parts.slice(-3)` 휴리스틱을 다시 쓰지 않는다", () => {
    // 사본 3벌이 공유하던 그 한 줄: TWO_LEVEL_TLDS.has(last2) ? parts.slice(-3) : last2
    const HEURISTIC = /\.slice\(\s*-3\s*\)\s*\.join\(\s*["'`]\.["'`]\s*\)/;
    const hits: string[] = [];
    for (const f of files) {
      for (const { line, no } of codeLines(readFileSync(f, "utf8"))) {
        if (HEURISTIC.test(line)) hits.push(`${path.relative(REPO_ROOT, f)}:${no}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("미러 저장 경로가 정본 정규화를 쓴다", () => {
  const syncSrc = readFileSync(path.join(REPO_ROOT, "lib/scope/mirror/sync.ts"), "utf8");

  it("sync.ts 가 lib/public-suffix 에서 registrableDomainOfHost 를 가져온다", () => {
    expect(syncSrc).toMatch(
      /import\s*\{\s*registrableDomainOfHost\s*\}\s*from\s*"@\/lib\/public-suffix";/,
    );
  });

  it("citation.domain 을 그 함수로 채운다 (저장 시점 절단 방지)", () => {
    expect(syncSrc).toMatch(/domain:\s*host\s*\?\s*registrableDomainOfHost\(host\)\s*:\s*null/);
  });

  // sync.ts 의 hostFromUrl + registrableDomainOfHost 조합이 실제로 무엇을 저장하는지.
  // 값은 2026-08-24 미러에서 실제로 잘려 있던 호스트다.
  it.each([
    ["https://www.hyundai.com.mx/modelos", "hyundai.com.mx"],
    ["https://hyundaimobil.co.id/", "hyundaimobil.co.id"],
    ["https://www.kiavietnam.com.vn/xe/", "kiavietnam.com.vn"],
    ["https://kia-israel.co.il/", "kia-israel.co.il"],
    ["https://www.car365.go.kr/", "car365.go.kr"],
    ["https://genesis.com.pr/es/", "genesis.com.pr"],
    ["https://english.visitkorea.or.kr/", "visitkorea.or.kr"],
    ["https://www.hyundai.com/kr/ko", "hyundai.com"],
    // host 자체가 public suffix 라 eTLD+1 이 존재하지 않는 경우 — 저장값은
    // **host 자신**이어야 한다. registrableDomain() 은 여기서 null 을 주므로,
    // registrableDomainOfHost 의 `?? host` 폴백이 없으면 미러가 정상 행을 NULL 로
    // 덮는다. 2026-08-24 백필 실측으로 741행이 이 형태였다
    // (gov.br 329 · gov.kr 294 · gov.uk 164 · gov.hk 105 · gov.si 60 …).
    ["https://www.gov.uk/government/organisations", "gov.uk"],
    ["https://www.gov.br/pt-br/", "gov.br"],
    ["https://www.gov.kr/portal/", "gov.kr"],
    // 반대로, 접미사처럼 생겼지만 PSL 상 진짜 등록가능 도메인인 것들은 그대로 둔다
    // (백필 실측 576행: go.com · ac.fi · web.de · net.hr · ind.br …).
    ["https://abcnews.go.com/US/story", "go.com"],
    ["https://www.web.de/magazine", "web.de"],
  ])("%s → %s", (url, want) => {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    expect(registrableDomainOfHost(host)).toBe(want);
  });
});
