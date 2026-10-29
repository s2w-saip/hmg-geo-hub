"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { createUser } from "../_actions";
import { TempPasswordToast } from "./temp-password-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Email-only creation form. On success we render TempPasswordToast which holds
// the generated password in memory until the admin dismisses it — no other
// surface (cache, log, server response after dismiss) retains it.
export function CreateUserForm() {
  const t = useTranslations("admin.create");
  const tErrors = useTranslations("admin.errors");
  const [pending, start] = useTransition();
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [toast, setToast] = useState<{ email: string; password: string } | null>(
    null,
  );

  return (
    <>
      <form
        className="flex flex-wrap items-end gap-3"
        action={(formData) => {
          setErrorKey(null);
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
