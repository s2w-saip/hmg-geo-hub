/**
 * **호출부가 실제로 공용 `pageAll` 을 지나는지**를 실행으로 확인한다.
 *
 * 소스 grep 만으로는 "구조는 맞고 로직이 틀린" 결함을 못 잡는다 — 이 트랙에서
 * 상한 상수를 되돌리는 돌연변이로 실증됐다. 그래서 여기서는 스텁을 물려 **실제로
 * 몇 페이지를 당기는지**와 **어떤 label 로 PAGE CAP HIT 이 뜨는지**를 단언한다.
 * `PAGE CAP HIT` 문자열은 리포 전체에서 `lib/scope/paging.ts` 한 곳만 낸다 —
 * 그 로그가 뜨는 것 자체가 "이 호출부가 공용 헬퍼를 지났다"의 증거다.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PROMPT_MAX_PAGES } from "./paging";
import { aggregateMentions } from "./result-adapter";
import type { ScopeClient } from "./client";
import type { Paginated } from "./types";

/** 끝나지 않는 커서 소스 — 매 페이지 1건 + 항상 next_cursor. 상한을 반드시 친다. */
function endless<T>(make: (i: number) => T) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetch: async (): Promise<Paginated<T>> => {
      const i = calls++;
      return { data: [make(i)], next_cursor: `c${i + 1}` };
    },
  };
}

function prompt(i: number) {
  return {
    prompt_id: `p${i}`,
    project_id: "proj",
    text: `q${i}`,
    funnel_stage: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}
function run(i: number) {
  return {
    measurement_run_id: `r${i}`,
    project_id: "proj",
    trigger: "manual",
    status: "completed",
    targets: ["chatgpt"],
    regions: ["KR"],
    total_jobs: 0,
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T01:00:00Z",
  };
}
function job(i: number) {
  return {
    job_id: `j${i}`,
    prompt_id: "p0",
    target: "chatgpt",
    region: "KR",
    status: "completed",
    analysis: { resolved_mentions: [] },
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

/** 이번 케이스에서 뜬 PAGE CAP HIT 로그 중 label 이 매치하는 것. */
function capHits(pattern: string): string[] {
  return warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes("PAGE CAP HIT") && m.includes(pattern));
}

describe("result-adapter — 사본 pageAll 제거 후 공용 헬퍼를 지난다", () => {
  it("프롬프트: 종전 사본 상한 30 이 아니라 PROMPT_MAX_PAGES 를 쓴다", async () => {
    const prompts = endless(prompt);
    const client = {
      listMeasurementRuns: async () => ({ data: [], next_cursor: null }),
      listRunJobs: async () => ({ data: [], next_cursor: null }),
      listPrompts: prompts.fetch,
      listResults: async () => ({ results: [] }),
    } as unknown as ScopeClient;

    await aggregateMentions(client, "proj");

    // 사본이 남아 있었다면 30 에서 멈춘다. 공용 헬퍼를 지나야 PROMPT_MAX_PAGES 다.
    expect(prompts.calls).toBe(PROMPT_MAX_PAGES);
    expect(prompts.calls).toBeGreaterThan(30);
    expect(capHits("live prompts(project=proj)")).toHaveLength(1);
  });

  it("runs: 라이브 상한 30 을 유지한다 (미러의 50 으로 끌려가지 않는다)", async () => {
    const runs = endless(run);
    const client = {
      listMeasurementRuns: runs.fetch,
      listRunJobs: async () => ({ data: [], next_cursor: null }),
      listPrompts: async () => ({ data: [], next_cursor: null }),
      listResults: async () => ({ results: [] }),
    } as unknown as ScopeClient;

    await aggregateMentions(client, "proj");

    // 라이브는 사용자 요청 경로라 요청량을 늘리지 않는 것이 이번 변경의 의도다.
    expect(runs.calls).toBe(30);
    expect(capHits("live runs(project=proj)")).toHaveLength(1);
  });

  it("jobs: 라이브 상한 30 을 유지하고 run 별 label 로 구분된다", async () => {
    const jobs = endless(job);
    const client = {
      listMeasurementRuns: async () => ({ data: [run(0)], next_cursor: null }),
      listRunJobs: jobs.fetch,
      listPrompts: async () => ({ data: [], next_cursor: null }),
      listResults: async () => ({ results: [] }),
    } as unknown as ScopeClient;

    await aggregateMentions(client, "proj");

    expect(jobs.calls).toBe(30);
    expect(capHits("live jobs(project=proj run=r0)")).toHaveLength(1);
  });
});

// ── 회귀 그물 ─────────────────────────────────────────────────────────────
// 스크립트(scripts/**)는 모듈 로드 시점에 env 검사·postgres() 연결·process.exit
// 부수효과가 있어 테스트에서 import 할 수 없다. 그 호출부까지 행위로 덮을 수는
// 없으므로, **"결함의 모양이 어디에도 남아 있지 않다"** 를 실행되는 단언으로 만든다.
// (이 리포에는 소스를 읽어 판정하는 테스트의 선례가 있다 —
//  lib/scope/mirror-cache-generation.test.ts 가 server.ts 의 import 클로저를 읽는다.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(REPO_ROOT, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(REPO_ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(rel);
    }
  };
  for (const root of ["lib", "scripts", "app"]) walk(root);
  return out;
}

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("회귀 그물 — 커서 페이징은 공용 헬퍼 밖에 존재하지 않는다", () => {
  /**
   * `next_cursor` 를 직접 만지는 파일의 허용 목록. 새 파일이 여기 걸리면
   * 메모리에서 완주하는 경로는 `pageAll` 로 합친다. 영속 체크포인트처럼
   * 페이지별 커밋이 계약인 경로는 별도의 재개·절단 실패 시험을 요구한다.
   */
  const CURSOR_ALLOWLIST: Record<string, string> = {
    "lib/scope/paging.ts": "공용 헬퍼 본체",
    "lib/scope/types.ts": "Paginated 타입 선언",
    "lib/scope/mock.ts": "mock 클라이언트가 응답을 만든다 (소비가 아니라 생산)",
    "lib/scope/server.ts": "listProjects는 pageAll로 upstream을 읽고 권한 필터 후 별도 cursor 생산; server.project-access.test.ts에서 hidden page·범위별 재개·절단 실패 검증",
    "lib/scope/mirror/bulk-plan.ts": "영속 계획의 cursor/ID/fingerprint 검증; bulk-plan.test.ts에서 반복·절단·중복 거부",
    "lib/scope/mirror/bulk-run.ts": "페이지와 DB checkpoint를 같은 tx로 커밋; bulk-run.test.ts에서 중간 재개·응답 유실 검증",
    "lib/scope/mirror/bulk-discovery.ts": "페이지 등록 후 파일 cursor 저장; bulk-discovery.test.ts에서 재시작·예산 중단·반복 cursor 및 head/deep 공정성 검증",
    "lib/scope/mirror/bulk-recheck.ts": "상태별 조회 cursor/digest를 기존 progress에 저장; bulk-recheck.test.ts에서 worker 재개·절단·필터/순서 위반 거부 검증",
    "scripts/db/split-ioniq-project.ts":
      "동명 프로젝트를 찾으면 즉시 멈추는 listProjects 조기종료 검색 — " +
      "프롬프트 페이징이 아니고 전량 수집도 아니라 pageAll 로 합치면 요청량이 늘어난다",
  };

  it("허용 목록 밖의 파일은 next_cursor 를 직접 다루지 않는다", () => {
    const offenders = sourceFiles().filter(
      (f) => read(f).includes("next_cursor") && !(f in CURSOR_ALLOWLIST),
    );
    expect(offenders).toEqual([]);
  });

  it("상한 있는 for 루프 + next_cursor(=조용한 절단)의 모양이 남아 있지 않다", () => {
    // 2026-08-30 전수 조사에서 8곳에서 나온 바로 그 형태:
    //   for (let i = 0; i < N; i++) { … if (!page.next_cursor) break; … }
    const SILENT = /for\s*\(\s*let\s+\w+\s*=\s*0\s*;[^)]*\)\s*\{[\s\S]{0,600}?next_cursor/;
    const offenders = sourceFiles().filter(
      (f) => f !== "lib/scope/paging.ts" && SILENT.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("프롬프트를 페이징하는 파일은 전부 pageAll 을 import 한다", () => {
    /** listPrompts 를 부르지만 페이징하지 않는 파일 — 이유를 적어 남긴다. */
    const NO_PAGING: Record<string, string> = {
      "lib/scope/client.ts": "ScopeClient 인터페이스 선언",
      "lib/scope/http.ts": "HTTP 클라이언트 구현 — 한 페이지를 그대로 반환",
      "lib/scope/mock.ts": "mock 구현 — 한 페이지를 그대로 반환",
      "scripts/scope/verify-public-api.ts": "엔드포인트 1회 호출 스모크 체크 (수집 아님)",
    };
    const missing = sourceFiles()
      .filter((f) => read(f).includes("listPrompts(") && !(f in NO_PAGING))
      .filter((f) => !/from ["'][^"']*paging["']/.test(read(f)));
    expect(missing).toEqual([]);
  });
});
