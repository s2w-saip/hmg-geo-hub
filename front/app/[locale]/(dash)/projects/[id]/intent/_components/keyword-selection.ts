// Pure selection helpers for the Google Keyword view's 선택 삭제 flows.
//
// These are extracted from google-keyword-view.tsx rather than inlined because
// they are the parts with real edge cases (which tab survives a bulk delete;
// which hidden rows a restore is allowed to touch) and the repo's safety net is
// unit-tested pure functions — same reasoning as scope-policy's isInScope.

export type KeywordTab = { id: string; label: string };

/**
 * The tab to activate after `removed` tabs are deleted.
 *
 * Keeps the user near where they were: prefer the closest surviving tab to the
 * LEFT of the active one, else the closest to the right. Returns "" when every
 * tab is gone (the view then falls back to the search-first empty state).
 *
 * When the active tab itself survives, it stays active — deleting other tabs
 * must not move the user.
 */
export function nextActiveAfterRemoval(
  tabs: readonly KeywordTab[],
  removed: ReadonlySet<string>,
  active: string,
): string {
  if (!removed.has(active)) return active;

  const idx = tabs.findIndex((k) => k.id === active);
  // active isn't in tabs at all — nothing sensible to preserve, take the first
  // survivor so the view never points at a deleted id.
  if (idx === -1) return tabs.find((k) => !removed.has(k.id))?.id ?? "";

  const left = [...tabs.slice(0, idx)].reverse().find((k) => !removed.has(k.id));
  if (left) return left.id;
  const right = tabs.slice(idx + 1).find((k) => !removed.has(k.id));
  return right?.id ?? "";
}

/**
 * Drop `keys` from the hidden set — used by 제거 취소.
 *
 * `hidden` spans every (tab, country) pair because SERP row ids are positional
 * and only unique once namespaced, so a restore must name exactly the keys it
 * owns. Clearing the whole set here would resurrect other tabs' removed rows.
 */
export function restoreHidden(
  hidden: ReadonlySet<string>,
  keys: ReadonlySet<string>,
): Set<string> {
  return new Set([...hidden].filter((k) => !keys.has(k)));
}
