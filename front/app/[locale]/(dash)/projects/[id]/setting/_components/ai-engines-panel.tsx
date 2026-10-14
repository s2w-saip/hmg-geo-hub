"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiEngineCheckboxes } from "@/components/dash/ai-engine-checkboxes";
import { aiEngineLabel, sameAiEngines, type AiEngineId } from "@/lib/scope/engines";
import { updateProjectEngines } from "../_actions";

export type EngineHistoryEntry = {
  id: string;
  engines: string[];
  changedAt: string; // ISO
};

// Setting > General > AI 엔진 — 답변을 수집할 엔진 선택 + 변경 이력.
//   - `initial` 은 유효 엔진(레거시 NULL 은 서버가 기본 2종으로 풀어 넘김).
//   - `explicit=false`(레거시) 면 아직 저장된 적이 없다는 안내를 띄운다 — 같은
//     값이라도 한 번 저장하면 명시값·이력이 생긴다.
//   - 이력은 저장 시점의 전체 선택 집합을 날짜별로 나열(최신순).
//   - `kept` 는 화면 어휘(AI_ENGINES) 밖 저장 엔진(#16). 컨트롤을 그리지 않고 들고만
//     있다가 저장 때 그대로 돌려보낸다(전엔 저장 때 사라졌다). 수집 중단 안내는
//     `keptCollects`(api 원천: 백엔드 스케줄이 kept 까지 잡는다)일 때만 kept 를 합쳐 판단한다.
//     legacy 는 Scope 에 어휘 안 엔진만 밀어 체크박스 0개면 실제로 멈추므로 종전대로다.
export function AiEnginesPanel({
  projectId,
  initial,
  explicit,
  kept = [],
  keptCollects = false,
  history,
  disabled,
}: {
  projectId: string;
  initial: AiEngineId[];
  explicit: boolean;
  kept?: string[];
  keptCollects?: boolean;
  history: EngineHistoryEntry[];
  disabled?: boolean;
}) {
  const t = useTranslations("projectDetail.setting.aiEngines");
  const [engines, setEngines] = useState<AiEngineId[]>(initial);
  const [saved, setSaved] = useState<AiEngineId[]>(initial);
  const [savedExplicit, setSavedExplicit] = useState(explicit);
  const [rows, setRows] = useState<EngineHistoryEntry[]>(history);
  const [keptEngines, setKeptEngines] = useState<string[]>(kept);
  const [pending, startTransition] = useTransition();

  const dirty = !savedExplicit || !sameAiEngines(engines, saved);
  // 목업 표기 `2026.06.23` — 로케일 무관 고정 포맷(ko `2026. 08. 03.` 식 Intl 출력과
  // 다르게). 시간대는 브라우저 로컬.
  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())}`;
  };
  // 목업은 오래된 것부터(06.23 → 07.30 → 08.03) 나열 — 서버는 최신순으로 주므로
  // 표시에서 뒤집는다. 로컬 낙관 추가분도 같은 규칙.
  const rowsAsc = [...rows].sort((a, b) => a.changedAt.localeCompare(b.changedAt));

  function onSave() {
    startTransition(async () => {
      const r = await updateProjectEngines(projectId, engines, keptEngines);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const next = r.value.engines as AiEngineId[];
      const nextKept = r.value.kept ?? [];
      setSaved(next);
      setSavedExplicit(true);
      setEngines(next);
      setKeptEngines(nextKept);
      if (r.value.changed) {
        setRows((prev) => [
          { id: `local-${Date.now()}`, engines: [...next, ...nextKept], changedAt: new Date().toISOString() },
          ...prev,
        ]);
      }
      if (next.length + (keptCollects ? nextKept.length : 0) === 0) toast.warning(t("savedNone"));
      // API source (U9-N7): the Scope schedule is an outbox job, applied after the save. This
      // branch is a documented addition to design 3.5 (U9-N7 in lib/hgh/adapters/projects.ts);
      // legacy results carry no queued field, so legacy toasts are unchanged.
      else if (r.value.queued) toast.success(t("savedQueued"));
      else if (r.value.pushed) toast.success(t("saved"));
      else toast.success(t("savedNotPushed"));
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <AiEngineCheckboxes
            idPrefix="ps-engine"
            value={engines}
            onChange={setEngines}
            disabled={disabled || pending}
          />
          {!savedExplicit ? (
            <p className="text-xs text-muted-foreground">{t("legacyHint")}</p>
          ) : null}
          {engines.length + (keptCollects ? keptEngines.length : 0) === 0 ? (
            <p className="text-xs text-destructive">{t("noneWarning")}</p>
          ) : null}
        </div>
        {!disabled ? (
          <Button type="button" onClick={onSave} disabled={pending || !dirty}>
            <Save className="h-4 w-4" aria-hidden />
            {t("save")}
          </Button>
        ) : null}
      </div>

      <div className="rounded-md border border-border/70 bg-muted/30 p-4">
        <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground">
          {t("history.title")}
        </p>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("history.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rowsAsc.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                <span className="w-24 shrink-0 tabular-nums text-muted-foreground">
                  {fmtDate(row.changedAt)}
                </span>
                {row.engines.length === 0 ? (
                  <span className="text-muted-foreground">{t("history.none")}</span>
                ) : (
                  row.engines.map((id) => (
                    <span key={id} className="text-foreground">
                      {aiEngineLabel(id)}
                    </span>
                  ))
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
