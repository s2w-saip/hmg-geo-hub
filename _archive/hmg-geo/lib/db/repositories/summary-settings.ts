import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { columnAvailable } from "@/lib/db/column-availability";

// 사실표(summary_*) 조회 스위치 — 설계 v4.1 §8-4.
//
// 스위치를 **DB 행**으로 두는 이유: Vercel env 는 재배포 없이 바뀌지 않고, 바뀌어도
// `mirrorCache`(unstable_cache TTL 1800s)에 이미 캐시된 사실표 결과가 최대 30분
// 잔존한다. 행이면 admin 토글 + revalidateTag 로 즉시 내릴 수 있다.
//
// 읽기는 요청당 1회지만 한 렌더에서 위젯 6개가 게이트를 각각 부르므로 프로세스 내
// 30초 메모이즈를 둔다(캐시 잔존 30분과 자릿수가 다르다 — 킬스위치 지연이 30초).

const READ_ENABLED_KEY = "read_enabled";
/** 스위치 계열(read_enabled·read_screens)이 공유하는 프로세스 내 메모 TTL. */
export const MEMO_TTL_MS = 30_000;

let memo: { value: boolean; expiresAt: number } | null = null;
let inflight: Promise<boolean> | null = null;

/** 테스트 전용 — 메모 상태 초기화. */
export function resetSummarySettingsForTests(): void {
  memo = null;
  inflight = null;
}

/** 테스트 전용 — DB 없이 스위치 값을 고정한다. */
export function setSummaryReadEnabledForTests(value: boolean): void {
  memo = { value, expiresAt: Number.MAX_SAFE_INTEGER };
}

async function probeReadEnabled(): Promise<boolean> {
  try {
    const rows = (await getDb().execute(sql`
      SELECT value FROM summary_settings WHERE key = ${READ_ENABLED_KEY} LIMIT 1
    `)) as unknown as Array<{ value: string | null }>;
    // 행이 없거나 '1' 이 아니면 꺼진 것으로 본다 — 기본값은 항상 폴백이다.
    const value = rows[0]?.value === "1";
    memo = { value, expiresAt: Date.now() + MEMO_TTL_MS };
    return value;
  } catch {
    // 표 미적용(마이그레이션 전 배포)·DB 오류 → 꺼진 것으로. 짧은 TTL 로 재판정.
    memo = { value: false, expiresAt: Date.now() + MEMO_TTL_MS };
    return false;
  } finally {
    inflight = null;
  }
}

/** `summary_settings.read_enabled = '1'` 인가. 실패·미적용은 전부 false(폴백). */
export function readEnabled(): Promise<boolean> {
  if (memo && memo.expiresAt > Date.now()) return Promise.resolve(memo.value);
  if (inflight) return inflight;
  inflight = probeReadEnabled();
  return inflight;
}

// ── read_screens (A5) — 화면 단위 스위치의 **원문**만 여기서 읽는다 ─────────
// 어휘·파싱·기본값 방향은 `lib/summary/read/screens.ts` 가 정본이다(이 파일은
// 리포지터리 계층이라 raw DB 클라이언트를 쥔다 — 파서까지 여기 두면 게이트 코드가
// 리포지터리에 섞인다).
const READ_SCREENS_KEY = "read_screens";
let screensMemo: { value: string | null; expiresAt: number } | null = null;
let screensInflight: Promise<string | null> | null = null;

/** 테스트 전용 — read_screens 메모 초기화. */
export function resetSummaryScreensSettingForTests(): void {
  screensMemo = null;
  screensInflight = null;
}

async function probeReadScreens(): Promise<string | null> {
  try {
    const rows = (await getDb().execute(sql`
      SELECT value FROM summary_settings WHERE key = ${READ_SCREENS_KEY} LIMIT 1
    `)) as unknown as Array<{ value: string | null }>;
    const value = rows[0]?.value ?? null;
    screensMemo = { value, expiresAt: Date.now() + MEMO_TTL_MS };
    return value;
  } catch {
    // 표 미적용·DB 오류 → null. 파서가 이것을 "전 화면 허용"으로 읽는다
    // (read_enabled 와 방향이 반대인 이유는 screens.ts 머리 주석).
    screensMemo = { value: null, expiresAt: Date.now() + MEMO_TTL_MS };
    return null;
  } finally {
    screensInflight = null;
  }
}

/** `summary_settings.read_screens` 원문(JSON 문자열). 요청당 1회·30초 메모. */
export function readScreensRaw(): Promise<string | null> {
  if (screensMemo && screensMemo.expiresAt > Date.now()) return Promise.resolve(screensMemo.value);
  if (screensInflight) return screensInflight;
  screensInflight = probeReadScreens();
  return screensInflight;
}

/**
 * 0059 의 회차 원장·사실표를 쓸 수 있는가. 표 전체가 한 마이그레이션(= 한 트랜잭션)
 * 에서 생기므로 대표 컬럼 하나만 본다 — `anchorRegistryAvailable`(0053)·
 * `dropRegistryAvailable`(0054) 와 같은 자세. 표가 없으면 `to_regclass` 가 NULL 이라
 * 프로브가 false 를 돌려주고 조회는 **무조건 미러 폴백**이다.
 *
 * 이 리포는 머지 = 무인 배포이고 마이그레이션은 사람이 따로 적용하므로, 코드가
 * 원장 없는 DB 에 먼저 갈 수 있다(그 반대도).
 */
export function summaryLedgerAvailable(): Promise<boolean> {
  return columnAvailable("summary_cycle_runs", "attributed_by");
}

/**
 * 0060 의 **유닛 고유 플래그**(보고서 v2.4 정합)를 쓸 수 있는가.
 * `summary_answers.unit_owned` / `unit_target` / `report_fs`,
 * `summary_domain_citations.unit_owned_citations`,
 * `summary_prompt_dim.unit_base` / `report_fs` 가 한 마이그레이션에서 함께 생기므로
 * 대표 컬럼 하나만 본다(0052~0054 와 같은 자세). 없으면 종전 판정 경로로 폴백한다.
 */
export function summaryUnitFlagsAvailable(): Promise<boolean> {
  return columnAvailable("summary_answers", "unit_owned");
}

/**
 * 보고서가 제외한 유닛(`website_prompts.file_seq`) — `summary_settings.website_excluded_fs`
 * (JSON 정수 배열). 발행 리포트의 `excluded`(Kia China·Ukraine·Kazakhstan 등)와 같은 모수를
 * 화면이 쓰게 한다. 실패·미설정·파싱 불가 = 빈 배열(제외 없음). 30초 메모.
 */
let excludedMemo: { value: number[]; expiresAt: number } | null = null;
export async function websiteExcludedUnits(): Promise<number[]> {
  if (excludedMemo && excludedMemo.expiresAt > Date.now()) return excludedMemo.value;
  let value: number[] = [];
  try {
    const rows = (await getDb().execute(
      sql`SELECT value FROM summary_settings WHERE key = 'website_excluded_fs'`,
    )) as unknown as Array<{ value: string }>;
    const parsed: unknown = rows[0]?.value ? JSON.parse(rows[0].value) : [];
    if (Array.isArray(parsed)) value = parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    value = [];
  }
  excludedMemo = { value, expiresAt: Date.now() + MEMO_TTL_MS };
  return value;
}

