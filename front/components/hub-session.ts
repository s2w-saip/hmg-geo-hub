"use client";

import { useCallback } from "react";

// Sign-out of the local mode's HUB login (2026-10-27): clears the session cookie (DELETE /api/hub/session)
// and goes to the login, which every local page needs (2026-10-28).
export function useHubLogout(locale: string): () => Promise<void> {
  return useCallback(async () => {
    try {
      await fetch("/api/hub/session", { method: "DELETE" });
    } finally {
      window.location.assign(`/${locale}/login`);
    }
  }, [locale]);
}
