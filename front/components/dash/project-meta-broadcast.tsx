"use client";

import { useEffect, useSyncExternalStore } from "react";

// Why this exists: the SNB lives in the (dash) layout, which Next.js does
// NOT re-render on client-side navigation (shared layouts persist). So the
// server-fetched projectMeta prop is only correct on a hard load — soft
// navigating from the project list into a detail page leaves it null and
// the SNB project header never appeared. The project [id] layout, however,
// IS re-rendered per project navigation, so it broadcasts the meta into
// this tiny external store and the sidebar subscribes.

export type ProjectMetaForSnb = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string | null; // ISO, null when the source does not supply it
};

let current: ProjectMetaForSnb | null = null;
const listeners = new Set<() => void>();

function setSnbProjectMeta(meta: ProjectMetaForSnb | null) {
  current = meta;
  for (const l of listeners) l();
}

export function useSnbProjectMeta(): ProjectMetaForSnb | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    // Server snapshot: null — SSR paints the header from the layout's
    // server-fetched prop instead.
    () => null,
  );
}

export function ProjectMetaBroadcast({ meta }: { meta: ProjectMetaForSnb }) {
  const { id, name, description, createdAt } = meta;
  useEffect(() => {
    setSnbProjectMeta({ id, name, description, createdAt });
    return () => setSnbProjectMeta(null);
  }, [id, name, description, createdAt]);
  return null;
}
