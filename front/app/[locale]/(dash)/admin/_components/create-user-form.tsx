"use client";

import { useId, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { createUser } from "../_actions";
import { TempPasswordToast } from "./temp-password-toast";
import { BRAND_OPTIONS, ScopeMultiSelect, useScopeCascade } from "./edit-user-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OperatorScope, Role } from "@/lib/auth/types";

const ROLES: Role[] = ["hq", "region", "country", "admin", "vendor", "website"];
const OPERATORS: OperatorScope[] = ["none", "assigned", "global"];

// Email-only creation form. On success we render TempPasswordToast which holds
// the generated password in memory until the admin dismisses it — no other
// surface (cache, log, server response after dismiss) retains it.
//
// withRoleScope (api source, decision D10): the backend creates the account with its role and
// scope in one step (an account needs a role, and a non-admin one a scope), so the form also
// asks for role, operator and scope. The fields travel in the same FormData.
export function CreateUserForm({ withRoleScope = false }: { withRoleScope?: boolean } = {}) {
  const t = useTranslations("admin.create");
  const tEdit = useTranslations("admin.edit");
  const tRoles = useTranslations("roles");
  const tErrors = useTranslations("admin.errors");
  const [pending, start] = useTransition();
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [toast, setToast] = useState<{ email: string; password: string } | null>(
    null,
  );
  const [role, setRole] = useState<Role>("country");
  const [operator, setOperator] = useState<OperatorScope>("none");
  const [scopeAll, setScopeAll] = useState(false);
  const cascade = useScopeCascade({ brands: [], regions: [], countries: [] });
  const roleId = useId();
  const operatorId = useId();
  const allId = useId();
  const isAdminRole = role === "admin";
  const isVendor = role === "vendor";

  return (
    <>
      <form
        className="flex flex-wrap items-end gap-3"
        action={(formData) => {
          setErrorKey(null);
          if (withRoleScope) {
            formData.set("role", role);
            formData.set("operator", isVendor ? "none" : operator);
            formData.set("scopeAll", String(isAdminRole || scopeAll));
            for (const b of cascade.brands) formData.append("brands", b);
            for (const r of cascade.regions) formData.append("regions", r);
            for (const c of cascade.countries) formData.append("countries", c);
          }
          start(async () => {
            const res = await createUser(formData);
            if (res.ok) {
              setToast({ email: res.email, password: res.tempPassword });
            } else {
              setErrorKey(res.errorKey);
            }
          });
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground">{t("emailLabel")}</span>
          <Input
            type="email"
            name="email"
            required
            placeholder={t("emailPlaceholder")}
            className="h-8 w-64"
          />
        </label>
        {withRoleScope ? (
          <>
            <div className="flex flex-col gap-1 text-xs">
              <Label htmlFor={roleId} className="text-xs font-medium">
                {tEdit("role")}
              </Label>
              <Select value={role} onValueChange={(v) => setRole(v as Role)} disabled={pending}>
                <SelectTrigger id={roleId} className="h-8 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {tRoles(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1 text-xs">
              <Label htmlFor={operatorId} className="text-xs font-medium">
                {tEdit("operator.label")}
              </Label>
              <Select
                value={isVendor ? "none" : operator}
                onValueChange={(v) => setOperator(v as OperatorScope)}
                disabled={pending || isVendor}
              >
                <SelectTrigger id={operatorId} className="h-8 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPERATORS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {tEdit(`operator.${o}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex basis-full flex-col gap-2 text-xs">
              <span className="font-medium text-foreground">{tEdit("scope.label")}</span>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={allId}
                  checked={isAdminRole || scopeAll}
                  onCheckedChange={(v) => setScopeAll(v === true)}
                  disabled={pending || isAdminRole}
                />
                <Label htmlFor={allId} className="text-xs font-normal">
                  {tEdit("scope.all")}
                </Label>
              </div>
              {!(isAdminRole || scopeAll) ? (
                <div className="grid max-w-md min-w-0 grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 pl-6">
                  <span className="text-muted-foreground">{tEdit("scope.brands")}</span>
                  <ScopeMultiSelect
                    label={tEdit("scope.brands")}
                    options={BRAND_OPTIONS}
                    selected={cascade.brands}
                    onChange={cascade.setBrands}
                    disabled={pending}
                  />
                  <span className="text-muted-foreground">{tEdit("scope.regions")}</span>
                  <ScopeMultiSelect
                    label={tEdit("scope.regions")}
                    options={cascade.regionOptions}
                    selected={cascade.regions}
                    onChange={cascade.setRegions}
                    disabled={pending || cascade.brands.length === 0}
                  />
                  <span className="text-muted-foreground">{tEdit("scope.countries")}</span>
                  <ScopeMultiSelect
                    label={tEdit("scope.countries")}
                    options={cascade.countryOptions}
                    selected={cascade.countries}
                    onChange={cascade.setCountries}
                    disabled={pending || cascade.regions.length === 0}
                  />
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t("submitting") : t("submit")}
        </Button>
        {errorKey && (
          <p className="text-xs text-destructive">
            {/* errorKey looks like "admin.errors.invalidEmail" — slice the prefix */}
            {tErrors(errorKey.replace(/^admin\.errors\./, ""))}
          </p>
        )}
      </form>
      {toast && (
        <TempPasswordToast
          email={toast.email}
          password={toast.password}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}
