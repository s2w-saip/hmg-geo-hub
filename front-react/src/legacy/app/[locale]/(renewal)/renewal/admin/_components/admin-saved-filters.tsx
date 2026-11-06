"use client";

// The saved filters of an admin list screen (2026-11-02, last review F7): the GA4 · account screens' rules in one place.
// The default (★) opens when the page is opened without filters and says so until the filters change; a pick from the
// list applies its query. The screen keeps its own filter state and query (its URL mirror).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { RnNote } from "@/components/renewal-ui";
import { RnSavedFiltersSection, useSavedFilters, type SavedFilter, type SavedFiltersSource } from "../../_components/saved-filters";

export function useAdminSavedFilters({
  source,
  query,
  filtered,
  apply,
  summarize,
}: {
  source: SavedFiltersSource;
  /** The screen's filter query now. */
  query: string;
  /** Whether a filter or a search narrows the list now (a query may carry a tab without narrowing). */
  filtered: boolean;
  /** Sets the screen's filters from a saved query ("" = no filters). */
  apply: (query: string) => void;
  /** A saved query in words (the picked values and the search). */
  summarize: (query: string) => string;
}): { section: ReactNode; note: ReactNode } {
  const ts = useTranslations("renewal.saved");
  const saved = useSavedFilters(source);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openedWith, setOpenedWith] = useState<{ name: string; query: string } | null>(null);
  const openedFiltered = useRef(filtered);
  const auto = useRef(false);
  useEffect(() => {
    if (!saved.ready || auto.current) return;
    auto.current = true;
    if (openedFiltered.current) return;
    const star = saved.items.find((p) => p.isDefault);
    if (!star) return;
    apply(star.query);
    setActiveId(star.id);
    setOpenedWith({ name: star.name, query: star.query });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.ready]);
  // the note names the default only while its filters stand
  useEffect(() => {
    if (openedWith && query !== openedWith.query) setOpenedWith(null);
  }, [query, openedWith]);

  const section = (
    <RnSavedFiltersSection
      saved={saved}
      activeId={activeId}
      onActivate={(item: SavedFilter | null) => {
        if (!item) {
          setActiveId(null);
          return;
        }
        apply(item.query);
        setActiveId(item.id);
        setOpenedWith(null);
      }}
      currentQuery={query}
      summarize={summarize}
      hrefOf={(q) => `${window.location.origin}${window.location.pathname}${q ? `?${q}` : ""}`}
    />
  );
  const note = openedWith ? (
    <RnNote>
      <span>{ts("openedWithDefault", { name: openedWith.name })}</span>
      <button
        type="button"
        className="cursor-pointer font-semibold text-rn-navy underline-offset-4 hover:underline"
        onClick={() => {
          setOpenedWith(null);
          apply("");
        }}
      >
        {ts("viewWithout")}
      </button>
    </RnNote>
  ) : null;
  return { section, note };
}
