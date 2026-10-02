"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Search-and-pick over the entity list (merge target, parent brand). The list can hold
// thousands of rows, so the picker shows at most MAX matches of the typed text.

export interface PickerOption {
  entityId: string;
  name: string;
  hint?: string | null;
}

const MAX = 8;

export function EntityPicker({
  id,
  options,
  value,
  onChange,
  exclude,
  disabled,
}: {
  id: string;
  options: PickerOption[];
  value: string | null;
  onChange: (entityId: string | null) => void;
  exclude?: string;
  disabled?: boolean;
}) {
  const t = useTranslations("adminEcat.picker");
  const [q, setQ] = useState("");
  const byId = useMemo(() => new Map(options.map((o) => [o.entityId, o])), [options]);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const out: PickerOption[] = [];
    for (const o of options) {
      if (o.entityId === exclude) continue;
      if (o.name.toLowerCase().includes(s) || o.entityId.startsWith(s)) out.push(o);
      if (out.length >= MAX) break;
    }
    return out;
  }, [options, q, exclude]);

  if (value) {
    const o = byId.get(value);
    return (
      <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
        <span className="font-medium">{o?.name ?? value}</span>
        {o?.hint ? <span className="text-muted-foreground">{o.hint}</span> : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 w-6 p-0"
          onClick={() => onChange(null)}
          disabled={disabled}
          aria-label={t("clear")}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Input
        id={id}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("placeholder")}
        className="h-8 text-xs"
        disabled={disabled}
      />
      {matches.length ? (
        <ul className="max-h-48 overflow-auto rounded-md border border-border bg-background text-xs">
          {matches.map((o) => (
            <li key={o.entityId}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-bg-subtle"
                onClick={() => {
                  onChange(o.entityId);
                  setQ("");
                }}
              >
                <span className="font-medium">{o.name}</span>
                {o.hint ? <span className="text-muted-foreground">{o.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : q.trim() ? (
        <p className="text-[11px] text-muted-foreground">{t("noMatch")}</p>
      ) : null}
    </div>
  );
}
