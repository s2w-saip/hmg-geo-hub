"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Eye, EyeOff, KeyRound, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// The password change form (2026-10-29). POST /api/hub/password replaces the password and the session cookie;
// the page then reloads at `next`. The rules the BFF applies are checked here first: 12 characters or more, not
// the current one, typed twice the same.

const MIN = 12;
type Failure = "wrongPassword" | "tooShort" | "same" | "mismatch" | "signedOut" | "unavailable" | "failed";

export function HubPasswordForm({ next, forced, loginHref }: { next: string; forced: boolean; loginHref: string }) {
  const t = useTranslations("hubPassword");
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const current = String(form.get("current") ?? "");
    const next_ = String(form.get("new") ?? "");
    const failureOf = next_.length < MIN ? "tooShort" : next_ === current ? "same" : next_ !== String(form.get("confirm") ?? "") ? "mismatch" : null;
    if (failureOf) {
      setFailure(failureOf);
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const res = await fetch("/api/hub/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, new: next_ }),
      });
      if (res.ok) {
        window.location.assign(next);
        return;
      }
      const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
      setFailure(
        code === "wrong_password" ? "wrongPassword" : code === "invalid_value" ? "tooShort" : res.status === 401 ? "signedOut" : res.status === 503 ? "unavailable" : "failed",
      );
    } catch {
      setFailure("failed");
    }
    setPending(false);
  }

  async function signOut() {
    await fetch("/api/hub/session", { method: "DELETE" }).catch(() => undefined);
    window.location.assign(loginHref);
  }

  const field = (name: "current" | "new" | "confirm", icon: "lock" | "key", autoComplete: string) => (
    <div className="relative">
      {icon === "lock" ? (
        <Lock className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      ) : (
        <KeyRound className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      )}
      <Input
        name={name}
        type={show ? "text" : "password"}
        aria-label={t(name === "current" && forced ? "issued" : name)}
        placeholder={t(name === "current" && forced ? "issued" : name)}
        autoComplete={autoComplete}
        required
        className="h-11 pr-10 pl-10"
      />
    </div>
  );

  return (
    <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-3" data-hub-password-form="">
      {field("current", "lock", "current-password")}
      {field("new", "key", "new-password")}
      {field("confirm", "key", "new-password")}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{t("rule", { min: MIN })}</span>
        <button type="button" onClick={() => setShow((v) => !v)} className="inline-flex items-center gap-1 transition-colors hover:text-foreground">
          {show ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}
          {t(show ? "hide" : "show")}
        </button>
      </div>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`error.${failure}`, { min: MIN })}
          {failure === "signedOut" ? (
            <>
              {" "}
              <a href={loginHref} className="font-semibold underline-offset-4 hover:underline">
                {t("signIn")}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} size="lg" className="mt-4 h-12 w-full font-semibold">
        {t("submit")}
      </Button>
      {forced ? (
        <button type="button" onClick={() => void signOut()} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {t("otherAccount")}
        </button>
      ) : (
        <a href={next} className="text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {t("cancel")}
        </a>
      )}
    </form>
  );
}
