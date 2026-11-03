"use client";

import { useState, type Dispatch, type SetStateAction } from "react";

/**
 * useState of a server answer that the component then replaces with its own reads (a list read again after a save):
 * a new answer of the page's takes its place. The shells re-read the page once the service week moved
 * (components/service-week/sync.ts: router.refresh()), which keeps a client component's state, so a list kept in
 * useState(initial) went on with the round before under a chip naming the new week (review r2-7, 2026-11-03). The rest
 * of the component's state stays (its picks, an open sheet, a form being filled in), unlike a remount by key.
 * An answer is told apart by identity: each server render hands a new one, the component's own renders the same one.
 * It is taken during the render, so no frame of the list before it is drawn.
 */
export function useServedState<T>(served: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState(served);
  const [seen, setSeen] = useState(served);
  if (seen !== served) {
    setSeen(served);
    setState(served);
  }
  return [seen !== served ? served : state, setState];
}
