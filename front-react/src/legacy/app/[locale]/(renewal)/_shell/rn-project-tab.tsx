"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useLocale, useTranslations } from "use-intl";
import { ChevronsUpDown, X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { RnIconButton, RnSearchField, RnSkeleton, cx } from "@/components/renewal-ui";
import { countryName } from "@/lib/geo-catalog/country-name";
import { projectHref, projectMatches, projectLabel, type ProjectRow } from "../renewal/projects/_components/project-model";

// The project tab's card (menu option D, 2026-11-03): which project this tab holds, and the switch to another one in
// the same tab, on the same menu. The sidebar sits in the renewal layout, which Next.js does not re-render when the
// tab moves to another project, so the project's layout (renewal/projects/[id]/layout.tsx) hands its rows over through
// this store (the original shell's project-meta-broadcast pattern). The server paints the card's skeleton.

export interface RnProjectTabData {
  id: string;
  rows: ProjectRow[];
}

let current: RnProjectTabData | null = null;
const listeners = new Set<() => void>();

export function useRnProjectTab(): RnProjectTabData | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
}

export function RnProjectTabBroadcast({ data }: { data: RnProjectTabData }) {
  useEffect(() => {
    current = data;
    for (const l of listeners) l();
    return () => {
      if (current === data) { current = null; for (const l of listeners) l(); }
    };
  }, [data]);
  return null;
}

/** "한국 · 프롬프트 81 · 10-06 측정" — the Gold values the project is told apart by. */
function useProjectMeta() {
  const t = useTranslations("renewal.projects.tab");
  const locale = useLocale();
  return (r: ProjectRow) => {
    const countries = r.countries.length ? r.countries.map((c) => countryName(c, locale)).join(" · ") : t("noCountry");
    const prompts = r.prompts.toLocaleString(locale);
    return r.last_measured_day ? t("meta", { countries, prompts, date: r.last_measured_day.slice(5) }) : t("metaUnmeasured", { countries, prompts });
  };
}

export function RnProjectCard({ id, page, menu }: { id: string; page: string; menu: string }) {
  const t = useTranslations("renewal.projects.tab");
  const data = useRnProjectTab();
  const meta = useProjectMeta();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const row = data?.id === id ? data.rows.find((r) => r.id === id) : undefined;
  return (
    <div data-rn-project-card={id} className="my-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 rounded-[10px] bg-rn-page py-2 pr-1.5 pl-3 shadow-[inset_0_0_0_1px_var(--color-rn-line)]">
      {row ? (
        <span className="flex min-w-0 flex-col leading-[1.35]" title={row.id}>
          <b className={cx("truncate text-rn-13 text-rn-ink", !row.name && "font-mono")}>{projectLabel(row)}</b>
          <small className="truncate text-rn-11 text-rn-muted">{meta(row)}</small>
        </span>
      ) : (
        <span className="flex flex-col gap-1.5" aria-label={t("loading")}>
          <RnSkeleton className="h-3.5 w-20" />
          <RnSkeleton className="h-3 w-32" />
        </span>
      )}
      <button
        ref={button}
        type="button"
        aria-label={t("switch")}
        title={t("switch")}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!data}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "grid size-[30px] cursor-pointer place-items-center rounded-md text-rn-muted hover:bg-rn-surface hover:text-rn-ink focus-visible:outline-2 focus-visible:outline-rn-navy disabled:cursor-default disabled:opacity-50",
          open && "bg-rn-surface text-rn-ink",
        )}
      >
        <ChevronsUpDown className="size-4" aria-hidden />
      </button>
      {open && data ? <ProjectSwitch anchor={button} rows={data.rows} id={id} page={page} menu={menu} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** The switch: every project, found by ID, first prompt or country; a pick opens the same menu of that project here. */
function ProjectSwitch({
  anchor,
  rows,
  id,
  page,
  menu,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  rows: ProjectRow[];
  id: string;
  page: string;
  menu: string;
  onClose: () => void;
}) {
  const t = useTranslations("renewal.projects.tab");
  const tList = useTranslations("renewal.projects");
  const locale = useLocale();
  const meta = useProjectMeta();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const listed = rows.filter((r) => projectMatches(r, query, (c) => countryName(c, locale)));

  useEffect(() => {
    const r = anchor.current?.closest("[data-rn-project-card]")?.getBoundingClientRect();
    if (r) setAt({ left: r.right + 12, top: Math.max(12, Math.min(r.top - 8, window.innerHeight - 560)) });
    panel.current?.querySelector("input")?.focus();
    const close = () => {
      onClose();
      anchor.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [anchor, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-labelledby={titleId}
      data-rn-project-switch=""
      style={at ? { left: at.left, top: at.top } : { visibility: "hidden" }}
      className="fixed z-50 flex max-h-[min(560px,calc(100dvh-24px))] w-[420px] flex-col rounded-rn-card bg-rn-surface text-rn-13 shadow-rn-3 ring-1 ring-rn-line"
    >
      <div className="flex items-center gap-2 py-2.5 pr-2 pl-4">
        <b id={titleId} className="text-rn-15 text-rn-ink">
          {t("switchTitle")}
        </b>
        <span className="text-rn-12 text-rn-muted tabular-nums">{t("switchCount", { count: listed.length.toLocaleString(locale) })}</span>
        <RnIconButton label={t("close")} className="ml-auto" onClick={onClose}>
          <X className="size-4" aria-hidden />
        </RnIconButton>
      </div>
      <div className="px-3 pb-2">
        <RnSearchField id="rn-project-switch-search" value={query} onChange={setQuery} placeholder={tList("searchPlaceholder")} label={tList("searchLabel")} />
      </div>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto border-t border-rn-line p-1.5">
        {listed.length === 0 ? <li className="p-3 text-rn-12 text-rn-muted">{tList("emptyFiltered")}</li> : null}
        {listed.map((r) => (
          <li key={r.id}>
            <Link
              prefetch={false}
              href={projectHref(r.id, page)}
              aria-current={r.id === id ? "true" : undefined}
              onClick={onClose}
              data-rn-project-pick={r.id}
              className={cx(
                "grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 rounded-lg px-2.5 py-2 no-underline hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy",
                r.id === id && "bg-rn-navy/8",
              )}
            >
              <b className={cx("truncate text-rn-13 text-rn-ink", !r.name && "font-mono")}>{projectLabel(r)}</b>
              <span className="truncate text-right text-rn-12 text-rn-muted">{meta(r)}</span>
              <span className={cx("col-span-2 truncate text-rn-12", r.first_prompt ? "text-rn-muted" : "text-rn-faint")}>{r.first_prompt ?? tList("noPrompt")}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="m-0 border-t border-rn-line px-4 py-2.5 text-rn-12 text-rn-muted">{t("switchHint", { menu })}</p>
    </div>,
    document.body,
  );
}
