"use client";

import { useEffect, useId, useMemo, useState, useTransition } from "react";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { deleteUser, updateUserProfile } from "../_actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { GEO_BRANDS, countryName } from "@/lib/geo-catalog";
import { rhqRegionsForBrand, rhqLabel, countriesForRhq } from "@/lib/rhq";
import type { Role, OperatorScope } from "@/lib/auth/types";

// Shape of the slice of profile we let the admin edit. Kept independent of the
// full ProfileRow so the parent (a server component) can pass exactly what the
// dialog needs without leaking timestamps or other read-only fields.
export interface EditableUser {
  id: string;
  email: string | null;
  role: Role;
  scopeAll: boolean;
  brands: string[] | null;
  regions: string[] | null;
  countries: string[] | null;
  operator: OperatorScope;
}

interface Props {
  user: EditableUser;
  /** Current session's user id — used to block self-deletion and gate self-edit. */
  selfId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ROLES: Role[] = ["hq", "region", "country", "admin", "vendor", "website"];
const OPERATORS: OperatorScope[] = ["none", "assigned", "global"];

// Scope options come from the geo-catalog (webgeo_final_list.xlsx) so assignment
// matches the canonical Brand / Region / Country list — no more free-text typos.
// Country stores the ISO code (= scope_answers.region) but displays the name.
const BRAND_OPTIONS = GEO_BRANDS.map((b) => ({ value: b, label: b }));

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function EditUserDialog({ user, selfId, open, onOpenChange }: Props) {
  const t = useTranslations("admin.edit");
  const tRoles = useTranslations("roles");
  const tErrors = useTranslations("admin.errors");
  const tToast = useTranslations("admin.toast");

  const isSelf = user.id === selfId;

  // Form state — initialized from props every time the dialog opens so the
  // editor always reflects the latest server-side row.
  const [role, setRole] = useState<Role>(user.role);
  const [operator, setOperator] = useState<OperatorScope>(user.operator);
  const [scopeAll, setScopeAll] = useState(user.scopeAll);
  const [brands, setBrands] = useState<string[]>(user.brands ?? []);
  const [regions, setRegions] = useState<string[]>(user.regions ?? []);
  const [countries, setCountries] = useState<string[]>(user.countries ?? []);

  const locale = useLocale();
  const lang = locale === "en" ? "en" : "ko";

  // 캐스케이드: 브랜드 > 권역 > 국가. 권역 옵션은 선택된 브랜드의 RHQ 권역에서만
  // 파생(브랜드 미선택 → 빈 목록 → 셀렉트 비활성). 값=권역 id, 라벨=locale 표시명.
  const regionOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { value: string; label: string }[] = [];
    for (const b of brands) {
      for (const r of rhqRegionsForBrand(b)) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        opts.push({ value: r.id, label: rhqLabel(r.id, lang) ?? r.id });
      }
    }
    return opts;
  }, [brands, lang]);

  // 국가 옵션은 선택된 권역의 ISO 국가에서만 파생(권역 미선택 → 빈 목록 → 비활성).
  const countryOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const rid of regions) for (const c of countriesForRhq(rid)) seen.add(c);
    return [...seen]
      .map((code) => ({ value: code, label: countryName(code, locale) }))
      .sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [regions, locale]);

  // 상위 선택이 바뀌면 하위의 무효 선택을 정리(캐스케이드 pruning).
  const setBrandsCascade = (next: string[]) => {
    const validRegions = new Set(next.flatMap((b) => rhqRegionsForBrand(b).map((r) => r.id)));
    const keptRegions = regions.filter((r) => validRegions.has(r));
    const validCountries = new Set(keptRegions.flatMap((r) => countriesForRhq(r)));
    setBrands(next);
    setRegions(keptRegions);
    setCountries((cs) => cs.filter((c) => validCountries.has(c)));
  };
  const setRegionsCascade = (next: string[]) => {
    const validCountries = new Set(next.flatMap((r) => countriesForRhq(r)));
    setRegions(next);
    setCountries((cs) => cs.filter((c) => validCountries.has(c)));
  };
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePending, startDelete] = useTransition();

  // Reset whenever the user prop changes (e.g. after a save → revalidatePath
  // refreshes the parent list and the dialog re-renders with fresh data).
  useEffect(() => {
    setRole(user.role);
    setOperator(user.operator);
    setScopeAll(user.scopeAll);
    setBrands(user.brands ?? []);
    setRegions(user.regions ?? []);
    setCountries(user.countries ?? []);
    setError(null);
    setConfirmingDelete(false);
  }, [user]);

  // vendor (외부 수행사) is operator-OFF permanently — mirror the server rule in
  // the UI: selecting vendor forces operator back to none.
  const isVendor = role === "vendor";
  useEffect(() => {
    if (isVendor && operator !== "none") setOperator("none");
  }, [isVendor, operator]);

  const roleId = useId();
  const operatorId = useId();
  const allId = useId();

  const dirty =
    role !== user.role ||
    operator !== user.operator ||
    scopeAll !== user.scopeAll ||
    !arraysEqual(brands, user.brands ?? []) ||
    !arraysEqual(regions, user.regions ?? []) ||
    !arraysEqual(countries, user.countries ?? []);

  function handleSave() {
    setError(null);
    start(async () => {
      const res = await updateUserProfile(user.id, {
        role,
        operator: isVendor ? "none" : operator,
        scope: { scopeAll, brands, regions, countries },
      });
      if (res.ok) {
        toast.success(tToast("saveSuccess"));
        onOpenChange(false);
      } else {
        setError(tErrors(res.errorKey.replace(/^admin\.errors\./, "")));
      }
    });
  }

  function handleDelete() {
    setError(null);
    startDelete(async () => {
      const res = await deleteUser(user.id);
      if (res.ok) {
        toast.success(tToast("deleteSuccess"));
        onOpenChange(false);
      } else {
        setError(tErrors(res.errorKey.replace(/^admin\.errors\./, "")));
        setConfirmingDelete(false);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Block accidental dismissal on stray clicks outside the dialog (D7) —
        // explicit cancel/close/ESC is the only way out.
        onPointerDownOutside={(e) => e.preventDefault()}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{user.email ?? user.id}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !pending) handleSave();
          }}
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={roleId} className="text-xs font-medium">
              {t("role")}
            </Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as Role)}
              disabled={pending}
            >
              <SelectTrigger id={roleId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => {
                  // Self-protection mirror of the server-side rule: an admin
                  // editing their own row may not pick a non-admin option.
                  const blocksSelfDemote =
                    isSelf && user.role === "admin" && r !== "admin";
                  return (
                    <SelectItem
                      key={r}
                      value={r}
                      disabled={blocksSelfDemote}
                      title={
                        blocksSelfDemote ? tErrors("cannotDemoteSelf") : undefined
                      }
                    >
                      {tRoles(r)}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {isSelf && user.role === "admin" && (
              <p className="text-[10px] text-muted-foreground">
                {tErrors("cannotDemoteSelf")}
              </p>
            )}
          </div>

          {/* Operator (cost-gate) authority — orthogonal to role. vendor is
              locked to none (외부 수행사 = 운영자 영구 OFF). */}
          <div className="flex flex-col gap-2">
            <Label htmlFor={operatorId} className="text-xs font-medium">
              {t("operator.label")}
            </Label>
            <Select
              value={operator}
              onValueChange={(v) => setOperator(v as OperatorScope)}
              disabled={pending || isVendor}
            >
              <SelectTrigger id={operatorId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPERATORS.map((o) => (
                  <SelectItem key={o} value={o}>
                    {t(`operator.${o}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              {isVendor ? t("operator.vendorLocked") : t("operator.hint")}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <span className="text-xs font-medium text-foreground">
              {t("scope.label")}
            </span>
            <div className="flex items-center gap-2">
              <Checkbox
                id={allId}
                checked={scopeAll}
                onCheckedChange={(v) => setScopeAll(v === true)}
                disabled={pending}
              />
              <Label htmlFor={allId} className="text-xs font-normal">
                {t("scope.all")}
              </Label>
            </div>

            {!scopeAll && (
              <div className="grid min-w-0 grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 pl-6">
                <span className="text-xs text-muted-foreground">{t("scope.brands")}</span>
                <ScopeMultiSelect
                  label={t("scope.brands")}
                  options={BRAND_OPTIONS}
                  selected={brands}
                  onChange={setBrandsCascade}
                  disabled={pending}
                />
                <span className="text-xs text-muted-foreground">{t("scope.regions")}</span>
                <ScopeMultiSelect
                  label={t("scope.regions")}
                  options={regionOptions}
                  selected={regions}
                  onChange={setRegionsCascade}
                  disabled={pending || brands.length === 0}
                />
                <span className="text-xs text-muted-foreground">{t("scope.countries")}</span>
                <ScopeMultiSelect
                  label={t("scope.countries")}
                  options={countryOptions}
                  selected={countries}
                  onChange={setCountries}
                  disabled={pending || regions.length === 0}
                />
              </div>
            )}
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!dirty || pending}
              title={!dirty ? t("noChanges") : undefined}
            >
              {pending ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>

        {/* Danger zone — visually separated, two-step confirm. Disabled when
            editing the current session's own row so an admin can't lock
            themselves out (mirrors the server-side check in deleteUser). */}
        <section className="mt-2 flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-xs font-semibold text-destructive">
              {t("dangerZone.title")}
            </h3>
            <span className="text-[10px] text-muted-foreground">
              {t("dangerZone.deleteHint")}
            </span>
          </div>

          {isSelf ? (
            <p className="text-xs text-muted-foreground">
              {t("dangerZone.selfBlocked")}
            </p>
          ) : !confirmingDelete ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
              disabled={deletePending}
              className="self-start"
            >
              {t("dangerZone.deleteLabel")}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deletePending}
              >
                {deletePending
                  ? t("dangerZone.deleting")
                  : t("dangerZone.confirm")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingDelete(false)}
                disabled={deletePending}
              >
                {t("dangerZone.cancel")}
              </Button>
            </div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

// Compact multi-select (catalog-driven) for a scope axis. Shows the selected
// labels (or the axis label when empty) + a count badge; the dropdown holds a
// checkbox list that stays open for fast multi-pick. Stores option `value`
// (e.g. ISO code for country); displays `label`.
function ScopeMultiSelect({
  label,
  options,
  selected,
  onChange,
  disabled,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const count = selected.length;
  const summary =
    count === 0
      ? label
      : selected
          .map((v) => options.find((o) => o.value === v)?.label ?? v)
          .join(", ");

  function toggle(v: string) {
    onChange(
      selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v],
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "inline-flex h-8 w-full items-center justify-between gap-1.5 rounded-md border px-2.5 text-xs transition-colors disabled:opacity-50",
            count > 0
              ? "border-brand-700 bg-brand-700/5 text-foreground"
              : "border-input bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="min-w-0 truncate text-left">{summary}</span>
          <span className="flex shrink-0 items-center gap-1">
            {count > 0 ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-700 px-1 text-[10px] font-semibold tabular-nums text-white">
                {count}
              </span>
            ) : null}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-60 w-56 overflow-y-auto">
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={selected.includes(o.value)}
            onCheckedChange={() => toggle(o.value)}
            onSelect={(e) => e.preventDefault()}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
