"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  updateStandardPromptText,
  updateStandardPromptLabels,
  updateStandardPromptRegions,
  type CatalogLabelsPatch,
} from "../../_actions";
import { sameRegions } from "@/lib/standards/prompt-regions";
import type { StandardPromptRow } from "./prompt-list";

// 카탈로그 단건 편집 (catalog-prompt-audit). 본문 + 라벨 축. 저장은 변경된
// 부분만 액션으로 보낸다 — text는 updateStandardPromptText(id 유지 in-place),
// 라벨은 updateStandardPromptLabels. 실패는 인라인 에러(관례: toast 아님).
// promptType/category는 카탈로그 UI에서 폐기된 축이라 여기서도 받지 않는다
// (벌크 xlsx 경로는 계속 지원).

const LABEL_FIELDS = [
  "brand",
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "depth4",
  "funnelStage",
] as const;

type LabelField = (typeof LABEL_FIELDS)[number];

export function PromptEditDialog({
  row,
  markets,
  open,
  onOpenChange,
}: {
  row: StandardPromptRow;
  /** 선택 가능한 시장 — 서버가 루트 프로젝트 실황에서 내려준다(하드코딩 금지). */
  markets: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("adminStandardPrompts.list");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(row.text);
  const [labels, setLabels] = useState<Record<LabelField, string>>(() => fromRow(row));
  // 시장 미지정(상속)과 "빈 선택"은 저장 시맨틱이 같다 — 둘 다 null 로 접는다.
  const [regions, setRegions] = useState<string[]>(() => row.regions ?? []);
  const [lang, setLang] = useState(() => row.lang ?? "");

  // 다른 행으로 다이얼로그를 재사용할 때 폼 상태를 그 행 값으로 리셋.
  useEffect(() => {
    setText(row.text);
    setLabels(fromRow(row));
    setRegions(row.regions ?? []);
    setLang(row.lang ?? "");
    setError(null);
  }, [row]);

  function fromRow(r: StandardPromptRow): Record<LabelField, string> {
    return {
      brand: r.brand ?? "",
      brandPresence: r.brandPresence ?? "",
      listType: r.listType ?? "",
      depth1: r.depth1 ?? "",
      depth2: r.depth2 ?? "",
      depth3: r.depth3 ?? "",
      depth4: r.depth4 ?? "",
      funnelStage: r.funnelStage ?? "",
    };
  }

  function labelsPatch(): CatalogLabelsPatch {
    const patch: CatalogLabelsPatch = {};
    for (const f of LABEL_FIELDS) {
      const cur = (row[f] ?? "") as string;
      const next = labels[f].trim();
      if (cur !== next) patch[f] = next === "" ? null : next;
    }
    return patch;
  }

  function onSave() {
    setError(null);
    const textChanged = text.trim() !== row.text;
    const patch = labelsPatch();
    const regionsChanged = !sameRegions(row.regions, regions);
    const langChanged = (row.lang ?? "") !== lang.trim().toUpperCase();
    if (!textChanged && Object.keys(patch).length === 0 && !regionsChanged && !langChanged) {
      onOpenChange(false);
      return;
    }
    startTransition(async () => {
      if (textChanged) {
        const res = await updateStandardPromptText(row.id, text);
        if (!res.ok) {
          setError(res.error || t("editFailed"));
          return;
        }
      }
      if (Object.keys(patch).length > 0) {
        const res = await updateStandardPromptLabels(row.id, patch);
        if (!res.ok) {
          setError(res.error || t("editFailed"));
          return;
        }
      }
      if (regionsChanged || langChanged) {
        // 빈 선택 = null = 미지정(상속). 서버가 같은 규칙으로 정규화하고 어휘를
        // 다시 검증한다 — 클라이언트 목록을 상한으로 믿지 않는다.
        const res = await updateStandardPromptRegions(row.id, {
          ...(regionsChanged ? { regions: regions.length > 0 ? regions : null } : {}),
          ...(langChanged ? { lang: lang.trim() || null } : {}),
        });
        if (!res.ok) {
          setError(res.error || t("editFailed"));
          return;
        }
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("editTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sp-edit-text" className="text-xs font-medium">
              {t("editText")}
            </Label>
            <Textarea
              id="sp-edit-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              className="text-sm"
            />
            {row.scopePromptId ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("editTextMeasuredNote")}
              </p>
            ) : null}
          </div>
          {/* 시장 멀티셀렉트 — 어휘는 서버가 내려준 루트 프로젝트 실황이다.
              하드코딩하면 scope 검증(어휘 밖 400)과 갈린다. */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium">{t("editMarkets")}</Label>
            {markets.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{t("editMarketsEmpty")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {markets.map((m) => {
                  const on = regions.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setRegions((prev) =>
                          prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m],
                        )
                      }
                      className={
                        "rounded-full border px-2.5 py-1 text-[11px] transition-colors " +
                        (on
                          ? "border-brand-700 bg-brand-700 text-white"
                          : "border-border bg-transparent text-muted-foreground hover:bg-muted")
                      }
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("editMarketsHint")}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sp-edit-lang" className="text-xs font-medium">
              {t("editLang")}
            </Label>
            <Input
              id="sp-edit-lang"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              maxLength={2}
              className="h-8 w-24 text-sm uppercase"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("editLangHint")}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {LABEL_FIELDS.map((f) => (
              <div key={f} className="flex flex-col gap-1">
                <Label htmlFor={`sp-edit-${f}`} className="text-[11px] text-muted-foreground">
                  {t(`editField.${f}`)}
                </Label>
                <Input
                  id={`sp-edit-${f}`}
                  value={labels[f]}
                  onChange={(e) => setLabels((prev) => ({ ...prev, [f]: e.target.value }))}
                  className="h-8 text-sm"
                />
              </div>
            ))}
          </div>
          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("editCancel")}
          </Button>
          <Button type="button" size="sm" onClick={onSave} disabled={isPending}>
            {isPending ? t("editSaving") : t("editSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
