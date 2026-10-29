// summary 읽기 킬스위치 — summary_settings 의 read_enabled / read_screens (v4.1 §8-4, PR① A5).
// 실행: bash (내부 작업 파일) <워크트리> npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/read-switch.ts <모드>
//   on | off                     read_enabled 전역 스위치
//   screens all                  read_screens = '[]'  (= 전 화면 허용)
//   screens '["S4.dashboard"]'   그 화면만 사실표, 나머지는 미러 폴백
//   status                       현재 값 출력
// 캐시: mirrorCache 는 경로별 키(summary-website-* / 종전)라 on 은 즉시, off 는 종전 키가 살아 있어 즉시 폴백된다.
//       스위치 자체의 프로세스 내 메모는 30초(summary-settings.ts MEMO_TTL_MS).
//
// ⚠️ 화면 키는 **읽기 계열**을 가리킨다 — 어휘·의미의 정본은 lib/summary/read/screens.ts 머리 주석.
//    여기서는 그 어휘로 **엄격 검증**한다: 미지 키는 거절해 DB 에 들어가지 못하게 한다.
//    런타임 파서는 미지 키뿐인 값을 **전 화면 차단**(미러 폴백)으로 읽으므로(R3),
//    쓰기 쪽에서 막는 것이 오타로 화면이 통째로 폴백되는 사고를 미리 끊는 유일한 관문이다.
//
// ⚠️ `S4.subkpi`(PR③-a B6)는 **값이 바뀌는 키**다 — 켜면 S4 카드의 엔진 일관성 배지가
//    미러 → 회차 스냅샷으로 갈리고 숫자가 달라진다. 성능 스위치가 아니라 **승인 대상**.
//    수치·원인의 정본은 **lib/summary/read/screens.ts 의 예외 블록 한 곳뿐**이다
//    (같은 표를 여기 복제하지 마라 — 갈린다).
//    켜는 명령(현행값 + 한 키):
//      screens '["S4.dashboard","S1.dashboard","S3.citation","S6.citation","S4.subkpi"]'
//
// ✅ `screens all`(= `'[]'`)은 전 화면 허용이지만 **값 변경 키는 켜지 않는다**
//    (PR③ 통합 2026-09-11 — `SUMMARY_SCREEN_OPT_IN` 합류). 오늘 그 목록은 **다섯**이다:
//      `S1.brandTrend` · `S1.firstPosition` · `S4.subkpi` · `S2.mention` · `S5.mention`
//    앞 셋은 산식·모수가 바뀌고, 뒤 둘(T8 누적 → 회차 집합 SUM)은 켜는 조건이 코드가
//    아니라 **GGMD 확인(P-5)** 이다. 켜려면 배열에 이름을 적어야 한다 —
//    초판의 "`all` 을 쓰지 마라" 임시 제약은 해제됐다.

import postgres from "postgres";
import { SUMMARY_SCREEN_KEYS, parseScreenAllowlist } from "@/lib/summary/read/screens";

const USAGE = `usage: read-switch.ts on|off|status|screens <all|'["S4.dashboard",…]'>
  screen keys: ${SUMMARY_SCREEN_KEYS.join(" ")}`;

const mode = process.argv[2];
if (!["on", "off", "status", "screens"].includes(mode ?? "")) {
  console.error(USAGE);
  process.exit(1);
}

/** `screens` 인자 → 저장할 문자열. 미지 키·형식 오류는 여기서 죽는다(쓰기 전). */
function screensValue(arg: string | undefined): string {
  if (!arg) throw new Error(USAGE);
  if (arg === "all") return "[]";
  let parsed: unknown;
  try {
    parsed = JSON.parse(arg);
  } catch {
    throw new Error(`not JSON: ${arg}\n${USAGE}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`not a JSON array: ${arg}\n${USAGE}`);
  const known = new Set<string>(SUMMARY_SCREEN_KEYS);
  const bad = parsed.filter((v) => typeof v !== "string" || !known.has(v));
  if (bad.length) throw new Error(`unknown screen key: ${bad.map((b) => JSON.stringify(b)).join(", ")}\n${USAGE}`);
  const uniq = [...new Set(parsed as string[])];
  if (uniq.length === 0) return "[]";
  return JSON.stringify(uniq);
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ssl: "require" });
try {
  if (mode === "on" || mode === "off") {
    const v = mode === "on" ? "1" : "0";
    const r = await sql`UPDATE summary_settings SET value = ${v}, updated_at = now() WHERE key = 'read_enabled' RETURNING key, value, updated_at`;
    if (r.length !== 1) throw new Error(`expected 1 row updated, got ${r.length}`);
  } else if (mode === "screens") {
    const v = screensValue(process.argv[3]);
    const r = await sql`UPDATE summary_settings SET value = ${v}, updated_at = now() WHERE key = 'read_screens' RETURNING key, value, updated_at`;
    if (r.length !== 1) throw new Error(`expected 1 row updated, got ${r.length}`);
  }
  const rows = await sql`SELECT key, value, updated_at FROM summary_settings ORDER BY key`;
  for (const r of rows) console.log(`${r.key} = ${r.value}  (${r.updated_at.toISOString()})`);
  // 상태 출력에서 "무엇이 허용되나" 가 한눈에 보여야 한다 — '[]' 의 의미가 문자
  // 그대로가 아니고(전 화면 허용), 그 밖의 해석 불가 원문은 전 화면 차단이기 때문.
  // 그래서 여기서 문자열을 다시 해석하지 않고 **런타임 파서를 그대로 부른다** —
  // 두 벌로 두면 콘솔이 "허용" 이라고 하는데 앱은 미러로 도는 상태가 생긴다(R3).
  const raw = rows.find((r) => r.key === "read_screens")?.value ?? null;
  const { list, warn } = parseScreenAllowlist(raw);
  if (warn) console.log(`  ⚠️ read_screens: ${warn}`);
  console.log(
    list.allowAll
      ? "→ screens: 전 화면 허용 (제한 없음)"
      : list.screens.size === 0
        ? "→ screens: **전 화면 차단** — 모든 화면이 미러 폴백 (되돌리기: read-switch.ts screens all)"
        : `→ screens: ${[...list.screens].join(", ")} 만 사실표 (나머지는 미러 폴백)`,
  );
} finally { await sql.end(); }
