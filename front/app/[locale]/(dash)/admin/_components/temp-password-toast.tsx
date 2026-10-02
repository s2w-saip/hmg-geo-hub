"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

// One-shot toast for displaying a freshly-generated temp password. The value
// lives only in this component's state — once dismissed, it's gone. Nothing
// persists it (no localStorage, no cookies). See design D5.
export function TempPasswordToast({
  email,
  password,
  onClose,
}: {
  email: string;
  password: string;
  onClose: () => void;
}) {
  const t = useTranslations("admin.create");
  const [copied, setCopied] = useState(false);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-6"
    >
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-soft-xl">
        <h2 className="text-sm font-semibold text-foreground">
          {t("tempPasswordToast")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{email}</p>
        <div className="mt-4 flex items-center gap-2 rounded-md border bg-muted px-3 py-2 font-mono text-sm text-foreground">
          <span className="flex-1 break-all">{password}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(password);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                // Fallback: select + manual copy. Best-effort UX.
              }
            }}
          >
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {t("tempPasswordHint")}
        </p>
        <div className="mt-5 flex justify-end">
          <Button type="button" size="sm" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </div>
    </div>
  );
}
