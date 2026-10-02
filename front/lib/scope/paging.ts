/**
 * scope 커서 페이지네이션의 **공용 원시함수**.
 *
 * ── 왜 `lib/scope/` 루트인가 (레이어 근거) ────────────────────────────────
 * 이 함수는 `lib/scope/server.ts`(게이트웨이)·`lib/scope/result-adapter.ts`
 * (라이브 집계)·`lib/scope/mirror/sync.ts`(미러 싱크)·`scripts/**` 가 모두 쓴다.
 * 원래 있던 `mirror/sync.ts` 에 두면 **게이트웨이 → 미러 싱크** 로 의존 방향이
 * 뒤집히고(sync.ts 는 DB 리포지토리·tracked dictionary 까지 끌고 온다), 페이징
 * 헬퍼 하나 때문에 그 전부가 import 클로저에 들어온다.
 *
 * 그래서 `types.ts`·`http.ts`·`engines.ts`·`text-trim.ts` 와 같은 **의존성 없는
 * 리프 모듈** 자리인 `lib/scope/` 루트에 둔다. 이 파일은 타입 하나만 import 한다 —
 * `server-only` 도 없어서 `scripts/**` 와 vitest 에서 그대로 쓸 수 있다.
 * (`mirror-cache-generation.test.ts` 가 server.ts 의 import 클로저를 캐시 키로
 * 쓰므로, 그 클로저를 불필요하게 부풀리지 않는 것 자체가 이 리포의 관례다.)
 */
import type { Paginated } from "./types";

export class ScopeDeadlineExceededError extends Error {
  constructor() {
    super("Scope read deadline exceeded");
    this.name = "ScopeDeadlineExceededError";
  }
}

export function assertScopeDeadline(deadlineAt?: number): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new ScopeDeadlineExceededError();
  }
}

export interface PagedFetch<T> {
  items: T[];
  /** 상한을 다 쓰고도 next_cursor 가 남아 있었는가 = **잘렸다**. */
  truncated: boolean;
  /** 실제로 당긴 페이지 수 (상한 이하). */
  pages: number;
  /**
   * 호출부의 `stopAfterPage` 가 참을 돌려 **의도적으로** 멈췄다. 이 경우 커서가 남아
   * 있어도 `truncated` 가 아니다 — 절단(상한 소진)과 조기 종료(호출부 판단)를 섞으면
   * PAGE CAP HIT 감시가 거짓 경보를 내거나, 반대로 진짜 절단을 가린다.
   */
  stoppedEarly: boolean;
  /**
   * 멈춘 자리의 다음 커서(절단·조기 종료일 때만, 끝까지 읽었으면 undefined).
   * 다음 호출이 `startCursor` 로 넘겨 **이어 읽을** 수 있다 — 한 틱 상한을 넘는 창을 여러
   * 틱에 나눠 읽는 미러 프롬프트 증분 경로(sync.ts)가 쓴다.
   */
  nextCursor?: string;
}

/**
 * 커서 페이지네이션 전량 수집 — **상한은 호출부가 정하고, 소진하면 시끄럽다.**
 *
 * 2026-08-30 실측 사고: 미러 싱크의 상한이 `maxPages = 50`(× limit 100 = 5,000)
 * 하나로 세 호출부에 공유돼 있었고, **소진해도 정상 완료와 구분되지 않았다.**
 * 표준 루트 프롬프트가 12,012 로 불어나자 매 패스가 앞 5,000 개만 가져왔다 —
 * 커서는 패스 사이에 지속되지 않으므로 20분 뒤 다음 패스도 **같은 5,000** 을
 * 다시 가져온다. 그래서 `scope_prompts.regions` 가 정확히 5,000 에서 멈췄다.
 *
 * ⚠️ 그리고 그건 **한 곳이 아니었다.** 전수 조사에서 같은 형태(경계 있는 for 루프 +
 * `if (!page.next_cursor) break;`)가 **8곳**에서 나왔다 — `result-adapter.ts` 에
 * 있던 이 함수의 사본(maxPages 30)과 `server.ts::listRootPrompts`(20 = 2,000)를
 * 포함해서다. 룰만 세우고 기존 위반을 남기면 다음 사람이 그걸 복사한다.
 *
 * 그래서 이 함수는 ① 상한을 **호출부마다 명시**받고(기본값 없음 — 조용히 물려받는
 * 경로를 없앤다) ② 소진 시 `truncated: true` 를 반환하고 ③ `console.warn` 으로
 * 로그에 남긴다. 미러 싱크는 여기에 더해 `MirrorSyncResult.pageCapHits` 로 크론
 * 응답 JSON 에까지 올린다.
 */
export async function pageAll<T>(
  fetchPage: (cursor?: string) => Promise<Paginated<T>>,
  opts: {
    maxPages: number;
    label: string;
    deadlineAt?: number;
    /**
     * 페이지를 하나 받을 때마다(다음 커서가 남아 있을 때만) 부른다. 참이면 거기서 멈춘다
     * — 미러 싱크의 run 목록 조기 종료(lib/scope/mirror/sync.ts scanRunList)가 쓴다.
     * 페이징 자체는 계속 이 함수 한 곳에만 둔다(paging.call-sites.test.ts 회귀 그물).
     */
    stopAfterPage?: (page: readonly T[]) => boolean;
    /** 이전 호출의 `nextCursor` — 주면 거기서부터 읽는다(없으면 첫 페이지). */
    startCursor?: string;
    /** 호출부가 `nextCursor` 를 저장해 이어 읽는다 — 상한 소진을 절단 경고로 내지 않는다. */
    resumable?: boolean;
  },
): Promise<PagedFetch<T>> {
  const out: T[] = [];
  let cursor: string | undefined = opts.startCursor;
  let pages = 0;
  let stoppedEarly = false;
  for (let i = 0; i < opts.maxPages; i++) {
    assertScopeDeadline(opts.deadlineAt);
    const page = await fetchPage(cursor);
    // A timed-out page is never presented as a complete source to a writer.
    assertScopeDeadline(opts.deadlineAt);
    pages++;
    out.push(...page.data);
    cursor = page.next_cursor ?? undefined;
    if (!cursor) break;
    if (opts.stopAfterPage?.(page.data)) {
      stoppedEarly = true;
      break;
    }
  }
  const truncated = cursor != null && !stoppedEarly;
  if (truncated && opts.resumable) {
    // 이어 읽기 경로: 한 틱 상한에서 끊고 커서를 남기는 것이 **설계된 동작**이다(절단 아님).
    console.warn(
      `[scope] PAGE BUDGET — ${opts.label}: stopped at ${pages} page(s) / ${out.length} item(s); ` +
        `the caller persists the cursor and resumes next pass.`,
    );
  } else if (truncated) {
    console.warn(
      `[scope] PAGE CAP HIT — ${opts.label}: stopped at ${pages} page(s) / ` +
        `${out.length} item(s) with next_cursor still set. This source was ` +
        `read TRUNCATED; raise its cap or switch it to an incremental cursor.`,
    );
  }
  return { items: out, truncated, pages, stoppedEarly, nextCursor: cursor };
}

/**
 * `listPrompts` 페이지 상한 — **프롬프트를 페이징하는 모든 곳이 이 값을 쓴다.**
 *
 * 프롬프트는 텍스트 위주로 가볍고 **총량이 유한**하다. 근거(2026-08-30 실측):
 * ⚠️ **2026-08-30 실측으로 300 에서 50 으로 되돌렸다 — 라이브 장애를 냈다.**
 *
 * 300 으로 올린 근거는 "루트 12,012 = 121 페이지를 한 패스에 다 돌자" 였다.
 * 그런데 미러 싱크의 시간 예산(`SYNC_BUDGET_MS` 250s)은 **프로젝트 사이에서만**
 * 검사된다 — 한 프로젝트의 페이징 루프 **안에서는 멈출 수 없다.** 그래서 표준
 * 루트 하나의 프롬프트 순회가 121 왕복으로 늘어나자 예산 검사 지점에 도달하기
 * 전에 크론 `maxDuration` 300s 를 넘겼다.
 *
 * 실측(Vercel 런타임 로그): 상한 50 일 때 `200 + "budget exhausted (250000ms)
 * — 16x project(s) deferred"`(정상 하차)였는데, 300 배포 직후부터 **연속 504
 * "Task timed out after 300 seconds"** 로 바뀌었고 미러 싱크가 2시간 멈췄다.
 *
 * 틀린 전제는 "프롬프트는 텍스트 위주라 가볍다" 였다. 무거운 것은 페이로드가
 * 아니라 **왕복 횟수**다 — 왕복당 2초면 121 왕복 = 242초로, 그것만으로 예산을
 * 통째로 먹는다.
 *
 * 그래서 상한을 올리는 것은 이 문제의 해법이 아니다. 루트가 5,000 을 넘는 지금
 * 이 값은 **의도적으로 절단한다** — 다만 #131 이 넣은 `PAGE CAP HIT` 경고와
 * `pageCapHits` 덕분에 그 절단은 이제 **보인다**(예전에는 조용했다).
 *
 * 제대로 된 해법은 둘 중 하나이고, 별건으로 다룬다:
 *   ① 페이징 루프 **안에서도** 시간 예산을 검사하고, 남은 커서를 저장해 다음
 *      패스가 이어받는다(증분 커서).
 *   ② `updated_at` 워터마크 기반 증분 동기화 — 매 패스 전량 재수집을 그만둔다.
 *
 * → 2026-09-28 미러 싱크에 ② 를 넣었다(`lib/scope/mirror/sync.ts` planPromptRead ·
 *   docs/mirror-incremental-sync.md). 이 상한은 이제 **첫 실행·강제 재싱크의 안전망**이다.
 */
export const PROMPT_MAX_PAGES = 50;
