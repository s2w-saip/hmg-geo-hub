/**
 * 사실표 생성기 코어의 **테넌트 경계** — 소스 grep 으로 집행한다.
 *
 * 설계 v4.1 §7-5 / PR① T8: `lib/summary/generate/*` 는 표면 공통 뼈대이고, HMG 상수를
 * 알면 안 된다. 값이 필요하면 인자로 받거나 `lib/summary/tenant/hmg.ts` 를 거친다.
 * 왜 grep 인가 — 이 경계는 런타임 동작이 아니라 **의존 방향**이라, 컴파일이 통과해도
 * 조용히 깨진다. 한 줄 import 를 잡는 데 필요한 것은 타입 검사가 아니라 문자열 검사다.
 *
 * 이 테스트가 막지 않는 것: 코어가 `lib/db/repositories/*` 의 판정 SQL 빌더를 쓰는 것은
 * **의도된 것이다**(규칙을 두 벌로 옮겨 적지 않기 위한 §7-5의 요구).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const CORE_DIR = "lib/summary/generate";
const TENANT_FILE = "lib/summary/tenant/hmg.ts";

/** 코어가 직접 import 하면 안 되는 테넌트 모듈(플랜 T8 요구 목록 그대로). */
const FORBIDDEN = [
  "@/lib/scope/hmg-brands",
  "@/lib/geo-catalog/owned",
  "@/lib/scope/non-competitor-brands",
  "@/lib/scope/hidden-regions",
  "@/lib/geo-catalog/official-social",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/**
 * import 절만 뽑는다 — 주석·문자열에 모듈명이 나오는 것은 위반이 아니다.
 * 여러 줄 import(`import {\n a,\n b,\n} from "x"`)를 놓치면 경계가 조용히 뚫리므로
 * 개행을 허용하되 다음 `from` 전까지만 먹는다.
 */
function importedModules(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\n;])\s*(?:import|export)\b(?:(?!\bfrom\b)[\s\S])*?\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  const bare = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g;
  while ((m = bare.exec(src))) out.push(m[1]);
  const dyn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dyn.exec(src))) out.push(m[1]);
  return out;
}

describe("생성기 코어 — 테넌트 경계", () => {
  const files = walk(CORE_DIR);

  it("코어 파일이 존재한다", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)("코어가 %s 를 import 하지 않는다", (mod) => {
    const violations = files.filter((f) => importedModules(readFileSync(f, "utf8")).includes(mod));
    expect(violations).toEqual([]);
  });

  it("코어가 원 DB 클라이언트(@/lib/db)를 잡지 않는다", () => {
    // docs/development-guide.md data-access-security — 커넥션은 실행 스크립트가 잡아 넘긴다.
    const violations = files.filter((f) => importedModules(readFileSync(f, "utf8")).includes("@/lib/db"));
    expect(violations).toEqual([]);
  });

  /**
   * PR② T3 수용 기준 ① — `own_variant` 유도가 코어로 새지 않았는가.
   * import 만 보면 놓친다: 코어가 `"Hyundai"` 를 문자열로 적어도 컴파일·import 검사는 통과한다.
   * `OWN_VARIANT_ALL`("ALL")은 테넌트 브랜드명이 아니므로 코어 상수다(fold.ts 주석).
   */
  const TENANT_TOKENS = [
    "HMG_BRANDS",
    "UMBRELLA_BRAND",
    "HMG_BRAND_ENTITY_IDS",
    "GEO_OWNED_BASES",
    "Hyundai",
    "Genesis",
    // "Kia" 는 3글자라 우연 일치가 나올 수 있어 단어 경계로 본다.
  ];
  // 토큰 검사는 **구현 파일의 코드만** 본다.
  //  · 테스트 제외 — 코어 테스트가 변형 키 픽스처로 브랜드명을 쓰는 것(`fold.test.ts` 의 `key: "Kia"`)은
  //    의존이 아니라 표본이고, 테스트의 import 는 위 검사가 이미 막는다.
  //  · 주석 제외 — 경계는 **의존 방향**이지 어휘가 아니다. 위 import 검사의 머리 주석과 같은 자세로,
  //    "왜 이 분기가 있는지"를 설명하려면 실측 사례(브랜드명 포함)를 적을 수 있어야 한다.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const srcFiles = files.filter((f) => !f.endsWith(".test.ts"));

  it.each([...TENANT_TOKENS, "Kia"])("코어 구현 코드에 테넌트 토큰 %s 가 없다", (tok) => {
    const re = new RegExp(`\\b${tok}\\b`);
    const violations = srcFiles.filter((f) => re.test(stripComments(readFileSync(f, "utf8"))));
    expect(violations).toEqual([]);
  });

  it("테넌트 seam 이 금지 모듈 전부를 실제로 대신 들고 있다", () => {
    // 경계가 "그냥 아무도 안 쓴다" 로 통과하지 않게, seam 쪽 존재를 함께 고정한다.
    const tenant = importedModules(readFileSync(TENANT_FILE, "utf8"));
    for (const mod of FORBIDDEN.filter((m) => m !== "@/lib/geo-catalog/official-social")) {
      expect(tenant, `${mod} 는 테넌트 seam 이 들고 있어야 한다`).toContain(mod);
    }
  });
});
