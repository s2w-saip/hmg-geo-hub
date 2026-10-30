"use client";

// Admin › 인용 출처 분류 › 시드 · 공식 소셜 · 코드표 (2026-10-30): what the three HUB-owned lists share — the published
// list pill, error text, the state mark, the history section of a sheet.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Database, Loader2 } from "lucide-react";
import { RnPill, cx } from "@/components/renewal-ui";
import { RnTimeline } from "../../../../_components/prompt-list";
import { SourceRequestError, type SourceCategory } from "./source-overrides-api";
import type { ListEvent, ListPublished } from "./source-lists-api";

/** Category labels by slug (citationCategories messages), the code table's name for a slug the front does not know. */
export function useCategoryLabel(categories: readonly SourceCategory[]) {
  const tc = useTranslations("citationCategories");
  return useCallback(
    (slug: string | null | undefined) => {
      if (!slug) return "—";
      if (tc.has(slug as "other")) return tc(slug as "other");
      return categories.find((c) => c.slug === slug)?.name ?? slug;
    },
    [tc, categories],
  );
}

export function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** HUB 데이터 DB · (Gold round) · the upstream list the external API serves. */
export function ListPills({ family, published, asOf }: { family: string; published: ListPublished | null; asOf?: string | null }) {
  const t = useTranslations("hubSourceLists");
  const locale = useLocale();
  return (
    <>
      <RnPill>
        <Database className="size-3 text-rn-muted" aria-hidden />
        {t("storePill")}
      </RnPill>
      {asOf ? <RnPill>{t("roundPill", { date: asOf })}</RnPill> : null}
      {published ? (
        <RnPill title={t("publishedTip", { family, seq: published.changeSeq, at: formatTime(published.recordedAt, locale) })}>
          <span data-hub-list-published={published.changeSeq}>{t("publishedPill", { version: published.version, items: published.items })}</span>
        </RnPill>
      ) : null}
    </>
  );
}

const KNOWN = ["invalid_value", "not_found", "unauthorized", "forbidden", "source_unavailable"];

export function useListError() {
  const t = useTranslations("hubSourceLists");
  return useCallback(
    (e: unknown) => {
      const err = e instanceof SourceRequestError ? e : new SourceRequestError(0, "failed");
      return t(`error.${KNOWN.includes(err.code) ? (err.code as "failed") : "failed"}`, { fields: (err.details?.fields ?? []).join(", ") || "—" });
    },
    [t],
  );
}

const STATE_DOT: Record<string, string> = {
  applied: "bg-rn-navy",
  pending: "border-[1.5px] border-rn-navy",
  shadowed: "border-[1.5px] border-rn-muted bg-rn-inset",
  upstream: "border border-dashed border-rn-muted",
};

/** A state against Gold: a dot and a label, the explanation as the hover tip; "—" when there is nothing to compare. */
export function StateMark({ state, label, tip, attr }: { state: string | null; label: string; tip: string; attr: string }) {
  if (!state) {
    return (
      <span className="text-rn-12 text-rn-faint" data-rn-tip={tip} {...{ [attr]: "" }}>
        —
      </span>
    );
  }
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1.5 text-rn-12", state === "applied" ? "text-rn-ink" : "text-rn-ink-2")} data-rn-tip={tip} {...{ [attr]: state }}>
      <i aria-hidden className={cx("inline-block size-2 shrink-0 rounded-full", STATE_DOT[state])} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** A sheet's history: loads when the row (or its last change) changes. */
export function HistorySection<T extends { history: ListEvent[] }>({
  load,
  version,
  eventLabel,
  fieldLabel,
  value,
}: {
  load: () => Promise<T>;
  /** changes when the row changed (its updatedAt): reload */
  version: string;
  eventLabel: (action: string) => string;
  fieldLabel: (field: string) => string;
  value: (field: string, v: unknown) => string | null;
}) {
  const t = useTranslations("hubSourceLists");
  const errorText = useListError();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    load().then(
      (d) => live && (setData(d), setError(null)),
      (e) => live && setError(e ?? new Error("failed")),
    );
    return () => {
      live = false;
    };
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const events = (data?.history ?? []).map((e) => ({
    key: String(e.id),
    label: eventLabel(e.action),
    at: e.at,
    actor: e.actor ? e.actor.displayName || e.actor.login : t("system"),
    changes: Object.fromEntries(Object.entries(e.changes).map(([field, [before, after]]) => [field, { old: value(field, before), new: value(field, after) }])),
  }));
  let body: ReactNode;
  if (error) {
    body = (
      <p role="alert" className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-ink-2">
        {errorText(error)}
      </p>
    );
  } else if (!data) {
    body = (
      <p className="flex items-center gap-2 text-rn-13 text-rn-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  } else {
    body = events.length ? <RnTimeline events={events} fieldLabel={fieldLabel} /> : <p className="m-0 text-rn-12 text-rn-muted">{t("noHistory")}</p>;
  }
  return (
    <section data-hub-list-timeline="">
      <h3 className="m-0 mb-3 text-rn-13 font-bold text-rn-ink">{t("history")}</h3>
      {body}
    </section>
  );
}

// the heads that cannot sort; same look as RnSortHead
export const LIST_TH_PLAIN = "sticky -top-1 z-[1] h-[38px] border-b border-rn-line-2 bg-rn-surface px-3 font-semibold";
