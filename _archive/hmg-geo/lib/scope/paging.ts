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
  opts: { maxPages: number; label: string; deadlineAt?: number },
): Promise<PagedFetch<T>> {
  const out: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (let i = 0; i < opts.maxPages; i++) {
    assertScopeDeadline(opts.deadlineAt);
    const page = await fetchPage(cursor);
    // A timed-out page is never presented as a complete source to a writer.
    assertScopeDeadline(opts.deadlineAt);
    pages++;
    out.push(...page.data);
    cursor = page.next_cursor ?? undefined;
    if (!cursor) break;
  }
  const truncated = cursor != null;
  if (truncated) {
    console.warn(
      `[scope] PAGE CAP HIT — ${opts.label}: stopped at ${pages} page(s) / ` +
        `${out.length} item(s) with next_cursor still set. This source was ` +
        `read TRUNCATED; raise its cap or switch it to an incremental cursor.`,
    );
  }
  return { items: out, truncated, pages };
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
 */
export const PROMPT_MAX_PAGES = 50;
