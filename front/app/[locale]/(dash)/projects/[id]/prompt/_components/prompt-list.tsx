"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  X,
  Play,
  Tags,
  Plus,
  Trash2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  deletePrompt,
  deletePromptCascade,
  executePrompts,
  getPromptLifecycleImpact,
  pausePrompt,
  resumePrompt,
  setPromptCustomFieldValue,
  setPromptCustomFieldValueBulk,
  clearPromptCustomFieldValue,
  addCustomField,
  deleteCustomFieldHard,
  type PromptLifecycleImpact,
} from "../_actions";
import { PromptIO } from "./prompt-io";
import type { CustomFieldRow } from "./custom-fields-panel";

export type PromptType =
  | "comparison"
  | "recommendation"
  | "information"
  | "other";
export type PromptStatus =
  | "draft"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "paused";

export type PromptRow = {
  id: string;
  text: string;
  promptType: PromptType | null;
  category: string | null;
  brand: string | null;
  status: PromptStatus;
  // null이면 scope에 아직 안 올라갔다 — queued인데 이 값이 없으면 RUN 회수 대상
  // (executePrompts와 동일 판정, _actions.ts:407-409 참고).
  scopePromptId: string | null;
  // fieldId -> assigned free-text value.
  customValues: Record<string, string>;
};

const STATUS_ORDER: Record<PromptStatus, number> = {
  draft: 0,
  queued: 1,
  running: 2,
  done: 3,
  failed: 4,
  paused: 5,
};

type SortDir = "asc" | "desc" | null;
type SortState = { key: string; dir: SortDir };

// 적용된 프롬프트 — 엑셀형 테이블(프롬프트=행 · 태그=열). 헤더 클릭 3단계 정렬
// (오름→내림→해제), 커스텀 태그는 "+ 열"로 추가(=태그 생성)·헤더 ×로 삭제,
// 셀은 인라인 편집(datalist 재사용)+일괄 태깅+상태무관. 브랜드/카테고리는 값이
// 있을 때만 조건부 열로 노출(WBS 4.1.5 v2, 2026-07-28).
export function PromptList({
  projectId,
  prompts,
  customFields,
  canEdit,
  locale,
}: {
  projectId: string;
  prompts: PromptRow[];
  customFields: CustomFieldRow[];
  canEdit: boolean;
  locale: string;
}) {
  const t = useTranslations("projectDetail.prompt.list");
  const tCf = useTranslations("projectDetail.prompt.customFields");
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: "", dir: null });
  // 일괄 태깅 — 선택된 프롬프트 id 집합 + 적용할 태그/값.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkFieldId, setBulkFieldId] = useState<string>("");
  const [bulkValue, setBulkValue] = useState("");
  // 태그 열 추가 폼
  const [addOpen, setAddOpen] = useState(false);
  const [addLabel, setAddLabel] = useState("");
  // Tag column pending force-delete confirmation (열+값 함께 삭제).
  const [deleteTarget, setDeleteTarget] = useState<CustomFieldRow | null>(null);
  // 열(태그)·행 낙관적 오버레이 — 생성/삭제 즉시 반영(revalidate 대기 없이).
  const [addedFields, setAddedFields] = useState<CustomFieldRow[]>([]);
  const [removedFieldIds, setRemovedFieldIds] = useState<Set<string>>(new Set());
  const [removedPromptIds, setRemovedPromptIds] = useState<Set<string>>(new Set());
  // 라이프사이클(측정 중지/재개/완전 삭제) 팝업 대상 + 상태 낙관적 오버레이.
  const [lifecycleTarget, setLifecycleTarget] = useState<PromptRow | null>(null);
  const [statusOverlay, setStatusOverlay] = useState<
    Record<string, PromptStatus>
  >({});

  const activeCustomFields = useMemo(() => {
    const base = customFields.filter((f) => !f.archived);
    const merged = [
      ...base,
      ...addedFields.filter((a) => !base.some((b) => b.id === a.id)),
    ];
    return merged.filter((f) => !removedFieldIds.has(f.id));
  }, [customFields, addedFields, removedFieldIds]);

  // Optimistic overlay for custom-tag values (revalidate 지연 대비).
  const [valueOverlay, setValueOverlay] = useState<
    Record<string, Record<string, string | null>>
  >({});
  const effectivePrompts = useMemo(() => {
    let base = removedPromptIds.size
      ? prompts.filter((p) => !removedPromptIds.has(p.id))
      : prompts;
    if (Object.keys(statusOverlay).length > 0) {
      base = base.map((p) =>
        statusOverlay[p.id] ? { ...p, status: statusOverlay[p.id] } : p,
      );
    }
    if (Object.keys(valueOverlay).length === 0) return base;
    return base.map((p) => {
      const patch = valueOverlay[p.id];
      if (!patch) return p;
      const customValues = { ...p.customValues };
      for (const [fieldId, value] of Object.entries(patch)) {
        if (value === null) delete customValues[fieldId];
        else customValues[fieldId] = value;
      }
      return { ...p, customValues };
    });
  }, [prompts, valueOverlay, removedPromptIds, statusOverlay]);

  // 조건부 코어 열 — 값이 하나라도 있으면 열 노출(안 쓰는 프로젝트는 숨김).
  const showBrand = useMemo(
    () => effectivePrompts.some((p) => p.brand),
    [effectivePrompts],
  );
  const showCategory = useMemo(
    () => effectivePrompts.some((p) => p.category),
    [effectivePrompts],
  );

  // 열 정의 — 프롬프트·상태 고정 + (조건부)브랜드·카테고리 + 태그 열들.
  type Col =
    | { key: "text" | "status" | "brand" | "category"; kind: "core" }
    | { key: string; kind: "tag"; field: CustomFieldRow };
  const columns: Col[] = useMemo(() => {
    const core: Col[] = [
      { key: "text", kind: "core" },
      { key: "status", kind: "core" },
      ...(showBrand ? ([{ key: "brand", kind: "core" }] as Col[]) : []),
      ...(showCategory ? ([{ key: "category", kind: "core" }] as Col[]) : []),
    ];
    const tags: Col[] = activeCustomFields.map((f) => ({
      key: f.id,
      kind: "tag",
      field: f,
    }));
    return [...core, ...tags];
  }, [showBrand, showCategory, activeCustomFields]);

  // 태그당 이미 쓰인 값 → datalist 제안(재사용·오타 방지).
  const valuesByField = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of activeCustomFields) {
      const set = new Set<string>();
      for (const p of effectivePrompts) {
        const v = p.customValues[f.id];
        if (v) set.add(v);
      }
      m.set(f.id, [...set].sort((a, b) => a.localeCompare(b)));
    }
    return m;
  }, [activeCustomFields, effectivePrompts]);

  function cellSortValue(p: PromptRow, key: string): string | number {
    if (key === "text") return p.text.toLowerCase();
    if (key === "status") return STATUS_ORDER[p.status];
    if (key === "brand") return (p.brand ?? "").toLowerCase();
    if (key === "category") return (p.category ?? "").toLowerCase();
    return (p.customValues[key] ?? "").toLowerCase();
  }

  const sorted = useMemo(() => {
    if (!sort.dir) return effectivePrompts;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...effectivePrompts].sort((a, b) => {
      const va = cellSortValue(a, sort.key);
      const vb = cellSortValue(b, sort.key);
      // 빈 값은 항상 뒤로 (정렬 방향 무관)
      const ea = va === "" ? 1 : 0;
      const eb = vb === "" ? 1 : 0;
      if (ea !== eb) return ea - eb;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }, [effectivePrompts, sort]);

  // RUN 대상 = draft + 회수 대상(queued인데 scope에 안 올라간 행) — executePrompts의
  // 판정과 동일해야 한다(_actions.ts:407-409). 안 맞추면 백엔드가 처리할 수 있는데도
  // 버튼이 비활성인 채로 남는다(2026-08-20 고아 6건 RUN 불가 실증).
  const draftCount = effectivePrompts.filter(
    (p) => p.status === "draft" || (p.status === "queued" && !p.scopePromptId),
  ).length;
  const visibleIds = useMemo(() => sorted.map((p) => p.id), [sorted]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function onSort(key: string) {
    setSort((prev) =>
      prev.key !== key
        ? { key, dir: "asc" }
        : prev.dir === "asc"
          ? { key, dir: "desc" }
          : prev.dir === "desc"
            ? { key: "", dir: null }
            : { key, dir: "asc" },
    );
  }

  function toggleSelect(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function toggleSelectAll(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
  function onBulkApply() {
    const ids = [...selected];
    const value = bulkValue.trim();
    if (!bulkFieldId || !value || ids.length === 0) return;
    startTransition(async () => {
      const r = await setPromptCustomFieldValueBulk(projectId, ids, bulkFieldId, value);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setValueOverlay((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = { ...next[id], [bulkFieldId]: value };
        return next;
      });
      toast.success(t("bulk.applied", { count: r.value.count }));
      setBulkValue("");
      setSelected(new Set());
    });
  }

  function onAddColumn() {
    const label = addLabel.trim();
    if (!label) return;
    startTransition(async () => {
      const r = await addCustomField(projectId, { label });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setAddedFields((prev) => [...prev, { id: r.value.id, label, archived: false }]);
      toast.success(tCf("created"));
      setAddLabel("");
      setAddOpen(false);
    });
  }
  // 값이 있으면 확인 다이얼로그를 먼저, 없으면 즉시 삭제.
  function requestDeleteColumn(field: CustomFieldRow) {
    if (usedFieldIds.has(field.id)) {
      setDeleteTarget(field);
      return;
    }
    doDeleteColumn(field);
  }
  function doDeleteColumn(field: CustomFieldRow) {
    setDeleteTarget(null);
    startTransition(async () => {
      const r = await deleteCustomFieldHard(projectId, field.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setRemovedFieldIds((prev) => new Set(prev).add(field.id));
      toast.success(tCf("deletedToast"));
    });
  }

  function onExecute() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await executePrompts(projectId, locale);
      if (r && !r.ok) toast.error(r.error);
    });
  }

  // 열별 사용 여부(삭제 가드) — 값이 하나라도 있으면 완전삭제 불가(보관/미사용만 삭제).
  const usedFieldIds = useMemo(() => {
    const s = new Set<string>();
    for (const p of effectivePrompts)
      for (const [fid, v] of Object.entries(p.customValues)) if (v) s.add(fid);
    return s;
  }, [effectivePrompts]);

  function SortIcon({ colKey }: { colKey: string }) {
    if (sort.key !== colKey || !sort.dir)
      return <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />;
    return sort.dir === "asc" ? (
      <ArrowUp className="h-3 w-3" aria-hidden />
    ) : (
      <ArrowDown className="h-3 w-3" aria-hidden />
    );
  }
  function colLabel(col: Col): string {
    if (col.kind === "tag") return col.field.label;
    return t(`col.${col.key}`);
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-3">
        {canEdit ? (
          <div className="flex items-center justify-between">
            <Badge variant="secondary" className="font-normal">
              {t("draftCount", { count: draftCount })}
            </Badge>
            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <DialogTrigger asChild>
                <Button type="button" size="sm" disabled={pending || draftCount === 0}>
                  <Play className="h-4 w-4" aria-hidden />
                  {t("execute")}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("confirm.title")}</DialogTitle>
                  <DialogDescription>
                    {t("confirm.description", { count: draftCount })}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setConfirmOpen(false)}
                  >
                    {t("confirm.cancel")}
                  </Button>
                  <Button type="button" disabled={pending} onClick={onExecute}>
                    <Play className="h-4 w-4" aria-hidden />
                    {t("confirm.execute")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        ) : null}

        {/* 태그 열 강제 삭제 확인 — 값이 있는 경우에만 열림 */}
        <Dialog
          open={deleteTarget !== null}
          onOpenChange={(o) => {
            if (!o) setDeleteTarget(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{tCf("deleteConfirm.title")}</DialogTitle>
              <DialogDescription>
                {tCf("deleteConfirm.description", {
                  label: deleteTarget?.label ?? "",
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setDeleteTarget(null)}
              >
                {tCf("deleteConfirm.cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => deleteTarget && doDeleteColumn(deleteTarget)}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                {tCf("deleteConfirm.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 툴바 — 태그 열 추가 + 엑셀 가져오기/내보내기 */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {canEdit ? (
              addOpen ? (
                <div className="flex items-center gap-1.5">
                  <Input
                    id="cf-label"
                    value={addLabel}
                    onChange={(e) => setAddLabel(e.target.value)}
                    placeholder={tCf("labelPlaceholder")}
                    disabled={pending}
                    className="h-8 w-44"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        onAddColumn();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending || !addLabel.trim()}
                    onClick={onAddColumn}
                  >
                    {tCf("create")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setAddOpen(false);
                      setAddLabel("");
                    }}
                  >
                    {tCf("cancel")}
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {t("addColumn")}
                </Button>
              )
            ) : null}
          </div>
          <PromptIO projectId={projectId} canImport={canEdit} />
        </div>

        {/* datalist(태그당 1개) — 셀·일괄 입력 공유 */}
        {activeCustomFields.map((f) => (
          <datalist key={f.id} id={`cf-vals-${f.id}`}>
            {(valuesByField.get(f.id) ?? []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        ))}

        {/* 일괄 태깅 — 선택분에 태그값 한 번에 적용 */}
        {canEdit && activeCustomFields.length > 0 && sorted.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              {selected.size > 0 ? t("bulk.selected", { count: selected.size }) : t("bulk.selectHint")}
            </span>
            {selected.size > 0 ? (
              <>
                <Tags className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <Select value={bulkFieldId} onValueChange={setBulkFieldId}>
                  <SelectTrigger size="sm" className="min-w-[8rem]">
                    <SelectValue placeholder={t("bulk.tagPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {activeCustomFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={bulkValue}
                  onChange={(e) => setBulkValue(e.target.value)}
                  placeholder={t("bulk.valuePlaceholder")}
                  list={bulkFieldId ? `cf-vals-${bulkFieldId}` : undefined}
                  disabled={pending || !bulkFieldId}
                  className="h-8 w-44"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onBulkApply();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={pending || !bulkFieldId || !bulkValue.trim()}
                  onClick={onBulkApply}
                >
                  {t("bulk.apply")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setSelected(new Set())}
                >
                  {t("bulk.clear")}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        {prompts.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {t("empty")}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border">
                  {canEdit ? (
                    <th className="sticky left-0 z-20 w-8 bg-card px-3 py-2">
                      <Checkbox
                        checked={allVisibleSelected}
                        onCheckedChange={(v) => toggleSelectAll(v === true)}
                        aria-label={t("bulk.selectAll")}
                      />
                    </th>
                  ) : null}
                  {columns.map((col, i) => (
                    <th
                      key={col.key}
                      className={`px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase ${i === 0 ? "sticky left-8 z-10 bg-card" : ""}`}
                    >
                      <span className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onSort(col.key)}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          {colLabel(col)}
                          <SortIcon colKey={col.key} />
                        </button>
                        {col.kind === "tag" && canEdit ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => requestDeleteColumn(col.field)}
                                aria-label={tCf("deleteButton")}
                                className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                              >
                                <Trash2 className="h-3 w-3" aria-hidden />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>{tCf("deleteButton")}</TooltipContent>
                          </Tooltip>
                        ) : null}
                      </span>
                    </th>
                  ))}
                  {canEdit ? <th className="w-8 px-2 py-2" /> : null}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length + (canEdit ? 2 : 0)}
                      className="px-4 py-6 text-center text-sm text-muted-foreground"
                    >
                      {t("noMatch")}
                    </td>
                  </tr>
                ) : (
                  sorted.map((p) => (
                    <tr key={p.id} className="border-b border-border/60 last:border-0">
                      {canEdit ? (
                        <td className="sticky left-0 z-10 bg-card px-3 py-2 align-top">
                          <Checkbox
                            checked={selected.has(p.id)}
                            onCheckedChange={(v) => toggleSelect(p.id, v === true)}
                            aria-label={t("bulk.selectOne")}
                          />
                        </td>
                      ) : null}
                      {columns.map((col, i) => (
                        <td
                          key={col.key}
                          className={`px-3 py-2 align-top ${i === 0 ? "sticky left-8 z-10 min-w-[16rem] max-w-[28rem] bg-card" : ""}`}
                        >
                          {col.kind === "core" && col.key === "text" ? (
                            <span className="text-foreground">{p.text}</span>
                          ) : col.kind === "core" && col.key === "status" ? (
                            <StatusBadge status={p.status} t={t} />
                          ) : col.kind === "core" ? (
                            <span className="text-muted-foreground">
                              {(col.key === "brand" ? p.brand : p.category) ?? "–"}
                            </span>
                          ) : canEdit ? (
                            <CustomFieldValueControl
                              key={`${col.key}:${p.customValues[col.key] ?? ""}`}
                              projectId={projectId}
                              promptId={p.id}
                              field={col.field}
                              value={p.customValues[col.key]}
                              suggestionsId={`cf-vals-${col.key}`}
                              onSaved={(value) =>
                                setValueOverlay((prev) => ({
                                  ...prev,
                                  [p.id]: { ...prev[p.id], [col.key]: value },
                                }))
                              }
                            />
                          ) : (
                            <span className="text-muted-foreground">
                              {p.customValues[col.key] ?? "–"}
                            </span>
                          )}
                        </td>
                      ))}
                      {canEdit ? (
                        <td className="px-2 py-2 align-top">
                          {p.status === "draft" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              disabled={pending}
                              onClick={() => {
                                startTransition(async () => {
                                  const r = await deletePrompt(projectId, p.id);
                                  if (r.ok) {
                                    setRemovedPromptIds((prev) => new Set(prev).add(p.id));
                                    toast.success(t("deleteSuccess"));
                                  } else toast.error(r.error);
                                });
                              }}
                              aria-label={t("delete")}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <X className="h-4 w-4" aria-hidden />
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              disabled={pending}
                              onClick={() => setLifecycleTarget(p)}
                              aria-label={t("lifecycle.open")}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden />
                            </Button>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {lifecycleTarget ? (
          <PromptLifecycleDialog
            projectId={projectId}
            prompt={lifecycleTarget}
            onClose={() => setLifecycleTarget(null)}
            onStatusChange={(id, status) =>
              setStatusOverlay((prev) => ({ ...prev, [id]: status }))
            }
            onDeleted={(id) =>
              setRemovedPromptIds((prev) => new Set(prev).add(id))
            }
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

// 측정된(비-draft) 프롬프트의 라이프사이클 팝업 — 실측 영향(답변/언급/인용 수)
// 미리보기 후 [측정 중지|재개] 또는 [완전 삭제 → 2단계 재확인]. 완전 삭제는
// 되돌릴 수 없고 과거 지표가 소급 변경되므로 destructive 2단계로만 도달한다.
function PromptLifecycleDialog({
  projectId,
  prompt,
  onClose,
  onStatusChange,
  onDeleted,
}: {
  projectId: string;
  prompt: PromptRow;
  onClose: () => void;
  onStatusChange: (id: string, status: PromptStatus) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("projectDetail.prompt.list.lifecycle");
  const [pending, startTransition] = useTransition();
  const [impact, setImpact] = useState<PromptLifecycleImpact | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<"main" | "confirm">("main");

  useEffect(() => {
    let alive = true;
    getPromptLifecycleImpact(projectId, prompt.id).then((r) => {
      if (!alive) return;
      if (r.ok) setImpact(r.value);
      else setLoadError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [projectId, prompt.id]);

  const paused = prompt.status === "paused";
  const shared = (impact?.sharedRows ?? 0) > 0;

  function onPauseResume() {
    startTransition(async () => {
      const r = paused
        ? await resumePrompt(projectId, prompt.id)
        : await pausePrompt(projectId, prompt.id);
      if (r.ok) {
        onStatusChange(prompt.id, paused ? "done" : "paused");
        toast.success(t(paused ? "resumedToast" : "pausedToast"));
        onClose();
      } else toast.error(r.error);
    });
  }

  function onHardDelete() {
    startTransition(async () => {
      const r = await deletePromptCascade(projectId, prompt.id);
      if (r.ok) {
        onDeleted(prompt.id);
        toast.success(t("deletedToast"));
        onClose();
      } else toast.error(r.error);
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {step === "main" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("title")}</DialogTitle>
              <DialogDescription className="line-clamp-3 text-pretty">
                {prompt.text}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              {loadError ? (
                <p className="text-destructive">{loadError}</p>
              ) : !impact ? (
                <p className="text-muted-foreground">{t("loading")}</p>
              ) : (
                <>
                  <p>
                    {t("impact", {
                      answers: impact.answers,
                      mentions: impact.mentions,
                      citations: impact.citations,
                    })}
                  </p>
                  {shared ? (
                    <p className="text-amber-700">
                      {t("sharedWarning", { count: impact.sharedRows })}
                    </p>
                  ) : null}
                  <p className="text-muted-foreground">
                    {t(paused ? "resumeHint" : "pauseHint")}
                  </p>
                </>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={pending}
              >
                {t("cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => setStep("confirm")}
                disabled={pending || !impact}
              >
                {t("hardDelete")}
              </Button>
              <Button
                type="button"
                onClick={onPauseResume}
                disabled={pending || !impact || (shared && !paused)}
              >
                {paused ? t("resume") : t("pause")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("confirmTitle")}</DialogTitle>
              <DialogDescription className="text-pretty">
                {t("confirmDescription", { answers: impact?.answers ?? 0 })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep("main")}
                disabled={pending}
              >
                {t("back")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={onHardDelete}
                disabled={pending}
              >
                {t("confirmDelete")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: PromptStatus;
  t: (k: string) => string;
}) {
  const styles: Record<PromptStatus, string> = {
    draft: "bg-muted text-muted-foreground",
    queued: "bg-amber-100 text-amber-700",
    running: "bg-blue-100 text-blue-700",
    done: "bg-emerald-100 text-emerald-700",
    failed: "bg-destructive/10 text-destructive",
    paused: "bg-slate-200 text-slate-600",
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={`inline-block shrink-0 cursor-help rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${styles[status]}`}
        >
          {t(`status.${status}`)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-pretty">
        {t(`statusDescription.${status}`)}
      </TooltipContent>
    </Tooltip>
  );
}

// 셀 인라인 편집 — blur 저장, 비우면 값 삭제. 같은 태그의 기존 값 datalist 제안.
function CustomFieldValueControl({
  projectId,
  promptId,
  field,
  value,
  suggestionsId,
  onSaved,
}: {
  projectId: string;
  promptId: string;
  field: CustomFieldRow;
  value: string | undefined;
  suggestionsId?: string;
  onSaved: (value: string | null) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(value ?? "");

  function onBlur() {
    const trimmed = text.trim();
    if (trimmed === (value ?? "")) return;
    startTransition(async () => {
      const r = trimmed
        ? await setPromptCustomFieldValue(projectId, promptId, field.id, trimmed)
        : await clearPromptCustomFieldValue(projectId, promptId, field.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      onSaved(trimmed || null);
    });
  }

  return (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={onBlur}
      placeholder={field.label}
      list={suggestionsId}
      disabled={pending}
      className="h-7 w-32 text-[12px]"
    />
  );
}
