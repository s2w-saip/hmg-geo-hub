"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, Link2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  QA_REVIEW_STATES,
  QA_SURFACES,
  isQaFilterActive,
  qaFilterToQuery,
  type QaFilter,
  type QaFilterOptionsShape,
} from "@/lib/qa/filters";

// 필터 바. 모든 축이 URL 쿼리로 나가므로 **링크를 복사해 주는 것이 곧 일감 분배**다.
// 그래서 "필터 링크 복사"가 부가 기능이 아니라 이 화면의 1급 동작이다(설계 §8.2).

type Props = {
  filter: QaFilter;
  options: QaFilterOptionsShape;
};

export function QaFilterBar({ filter, options }: Props) {
  const t = useTranslations("qaReview.list");
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(filter.q ?? "");
  const [copied, setCopied] = useState(false);

  // 서버가 준 필터가 바뀌면(뒤로 가기 등) 검색 입력도 따라간다.
  useEffect(() => setQ(filter.q ?? ""), [filter.q]);

  function apply(next: QaFilter) {
    const qs = qaFilterToQuery(next).toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  // 다중 선택 축의 토글 — 이미 있으면 빼고, 없으면 넣는다.
  function toggle<K extends "surface" | "state" | "brand" | "country" | "engine" | "lang" | "reviewer">(
    key: K,
    value: string,
  ) {
    const current = (filter[key] as string[] | undefined) ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    apply({ ...filter, [key]: next.length ? next : undefined } as QaFilter);
  }

  // 검색어는 300ms 디바운스 — 타이핑마다 서버를 때리면 십수만 행 ILIKE 가 쌓인다.
  useEffect(() => {
    if ((filter.q ?? "") === q) return;
    const id = setTimeout(() => apply({ ...filter, q: q.trim() || undefined }), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 클립보드 권한이 없으면 조용히 넘어간다 — 주소창에서 직접 복사할 수 있다.
    }
  }

  const active = isQaFilterActive(filter);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ChipGroup
          label={t("filterSurface")}
          values={QA_SURFACES}
          selected={filter.surface ?? []}
          labelFor={(v) =>
            ({ standard: t("surfaceStandard"), website: t("surfaceWebsite"), project: t("surfaceProject") })[
              v as "standard" | "website" | "project"
            ]
          }
          onToggle={(v) => toggle("surface", v)}
        />
        <ChipGroup
          label={t("filterState")}
          values={QA_REVIEW_STATES}
          selected={filter.state ?? []}
          labelFor={(v) =>
            ({ unreviewed: t("stateUnreviewed"), ok: t("stateOk"), issue: t("stateIssue") })[
              v as "unreviewed" | "ok" | "issue"
            ]
          }
          onToggle={(v) => toggle("state", v)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <MultiSelect
          label={t("filterBrand")}
          options={options.brand}
          selected={filter.brand ?? []}
          onToggle={(v) => toggle("brand", v)}
        />
        <MultiSelect
          label={t("filterCountry")}
          options={options.country}
          selected={filter.country ?? []}
          onToggle={(v) => toggle("country", v)}
        />
        <MultiSelect
          label={t("filterEngine")}
          options={options.engine}
          selected={filter.engine ?? []}
          onToggle={(v) => toggle("engine", v)}
        />
        <MultiSelect
          label={t("filterLang")}
          options={options.lang}
          selected={filter.lang ?? []}
          onToggle={(v) => toggle("lang", v)}
        />
        <MultiSelect
          label={t("filterReviewer")}
          options={options.reviewer}
          selected={filter.reviewer ?? []}
          onToggle={(v) => toggle("reviewer", v)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("filterSearch")}
          className="h-8 w-56"
        />
        <Input
          type="date"
          value={filter.from ?? ""}
          onChange={(e) => apply({ ...filter, from: e.target.value || undefined })}
          aria-label={t("filterFrom")}
          className="h-8 w-36"
        />
        <Input
          type="date"
          value={filter.to ?? ""}
          onChange={(e) => apply({ ...filter, to: e.target.value || undefined })}
          aria-label={t("filterTo")}
          className="h-8 w-36"
        />
        <ToggleChip
          on={filter.hasNotes === true}
          label={t("filterHasNotes")}
          onClick={() => apply({ ...filter, hasNotes: filter.hasNotes ? undefined : true })}
        />
        <ToggleChip
          on={filter.noMentions === true}
          label={t("filterNoMentions")}
          onClick={() => apply({ ...filter, noMentions: filter.noMentions ? undefined : true })}
        />

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={copyLink} title={t("linkHint")}>
            {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
            {copied ? t("copied") : t("copyLink")}
          </Button>
          {active ? (
            <Button variant="ghost" size="sm" onClick={() => apply({})}>
              <RotateCcw className="size-3.5" />
              {t("filterReset")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ChipGroup({
  label,
  values,
  selected,
  labelFor,
  onToggle,
}: {
  label: string;
  values: readonly string[];
  selected: readonly string[];
  labelFor: (v: string) => string;
  onToggle: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {values.map((v) => (
        <ToggleChip
          key={v}
          on={selected.includes(v)}
          label={labelFor(v)}
          onClick={() => onToggle(v)}
        />
      ))}
    </div>
  );
}

function ToggleChip({
  on,
  label,
  onClick,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        on
          ? "border-brand-700 bg-brand-700 text-white"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

// 값이 수십 개까지 갈 수 있어 native <details> 로 접는다 — Radix Select 는
// 다중 선택을 지원하지 않고, Popover 를 쓰면 이 화면 하나 때문에 의존이 늘어난다.
function MultiSelect({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: readonly string[];
  selected: readonly string[];
  onToggle: (v: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <details className="group relative">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1 rounded-md border px-2.5 py-1 text-xs",
          selected.length
            ? "border-brand-700 text-brand-700"
            : "border-border text-muted-foreground",
        )}
      >
        {label}
        {selected.length ? ` (${selected.length})` : ""}
      </summary>
      <div className="absolute z-20 mt-1 max-h-72 w-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onToggle(o)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted"
          >
            {/* 체크는 자리를 항상 차지한다 — 토글할 때 라벨이 좌우로 튀지 않게. */}
            <Check
              className={cn(
                "size-3 shrink-0",
                selected.includes(o) ? "opacity-100" : "opacity-0",
              )}
            />
            <span className="truncate">{o}</span>
          </button>
        ))}
      </div>
    </details>
  );
}
