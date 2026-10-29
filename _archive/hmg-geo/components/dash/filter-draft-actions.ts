/**
 * 필터 패널의 드래프트 핸들러 — **URL 왕복 없이 로컬 선택만 바꾸는** 동작 묶음.
 *
 * 계약(QA 2차 #5, 2026-09-10): 드롭다운 체크는 즉시 반영되고 서버 왕복은 `적용`
 * **1회뿐**이다. 칩 시절에는 클릭마다 `router.replace` 를 때려 왕복이 끝나야 체크가
 * 바뀌었고(= 고객 리포트 "도메인 카테고리 선택이 안 된다"), 클릭 수가 곧 왕복 수라
 * 경쟁사 다중 선택이 느렸다.
 *
 * 왜 패널 밖으로 뗐나 — 이 리포에는 jsdom·testing-library 가 없어 `renderToStaticMarkup`
 * 으로는 클릭을 돌릴 수 없고, 그래서 2026-09-11 검증에서 "toggle 안에 commit 을 심는"
 * 뮤테이션이 필터패널·인용 테스트 37/37 을 그대로 통과했다(계약 미보호). 상태 setter 와
 * commit 을 주입받는 순수 팩토리로 만들면 렌더러 없이 **호출 횟수**를 셀 수 있다
 * (`filter-draft-actions.test.ts`).
 *
 * ⚠️ `commit` 은 `적용`(그리고 패널이 직접 소유하는 `초기화`)만 부른다. 여기 어느
 * 토글에서도 부르지 않는다 — 그것이 이 파일의 존재 이유다.
 */

/** 축 → 선택값. 패널의 `Draft`(Partial<Record<DimensionGroup, string[]>>)와 같은 모양. */
export type FilterDraft = Partial<Record<string, string[]>>;
/** 동적 축(커스텀 태그) id → 선택값. */
export type FilterDynDraft = Record<string, string[]>;

export interface FilterDraftDeps<D extends FilterDraft, Y extends FilterDynDraft> {
  setDraft: (updater: (prev: D) => D) => void;
  setDynDraft: (updater: (prev: Y) => Y) => void;
  /**
   * 한 축이 바뀐 뒤의 draft 정규화 — 캐스케이드 prune·하위 축 정리·비활성이 된 축의
   * 선택 회수. 패널이 주입한다(카탈로그 행 등 렌더 스코프 의존).
   */
  normalizeDraft: (next: D, group: string) => D;
  /** 지금 화면의 draft 스냅샷 — `적용` 이 실어 나를 값. */
  readDraft: () => { draft: D; dyn: Y };
  /** URL 커밋(= 서버 왕복). **`적용` 에서만** 불린다. */
  commit: (draft: D, dyn: Y) => void;
}

export interface FilterDraftActions {
  toggleValue: (group: string, value: string) => void;
  clearGroup: (group: string) => void;
  toggleDyn: (id: string, value: string) => void;
  clearDyn: (id: string) => void;
  apply: () => void;
}

const toggled = (cur: readonly string[], value: string): string[] =>
  cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];

export function createFilterDraftActions<D extends FilterDraft, Y extends FilterDynDraft>(
  deps: FilterDraftDeps<D, Y>,
): FilterDraftActions {
  return {
    // 값 하나 토글 — 로컬 draft 만. 업데이터는 순수해야 한다(StrictMode 가 두 번 돌린다).
    toggleValue: (group, value) =>
      deps.setDraft((prev) =>
        deps.normalizeDraft(
          { ...prev, [group]: toggled(prev[group] ?? [], value) } as D,
          group,
        ),
      ),
    clearGroup: (group) =>
      deps.setDraft((prev) => deps.normalizeDraft({ ...prev, [group]: [] } as D, group)),
    toggleDyn: (id, value) =>
      deps.setDynDraft((prev) => ({ ...prev, [id]: toggled(prev[id] ?? [], value) })),
    clearDyn: (id) => deps.setDynDraft((prev) => ({ ...prev, [id]: [] })),
    // 유일한 왕복 지점.
    apply: () => {
      const { draft, dyn } = deps.readDraft();
      deps.commit(draft, dyn);
    },
  };
}
