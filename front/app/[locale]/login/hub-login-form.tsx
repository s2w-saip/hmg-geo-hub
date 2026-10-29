"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Eye, EyeOff, Lock, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// HUB login of the local mode (2026-10-27): an account signs in, which every local page needs (2026-10-28).
// POST /api/hub/session sets the httpOnly session cookie; the page then reloads at `next` so every server
// component reads the new session, or at the password change when an administrator issued the password.

type Failure = "invalid" | "rateLimited" | "unavailable" | "failed";

export function HubLoginForm({ next, passwordHref }: { next: string; passwordHref: string }) {
  const t = useTranslations("hubLogin");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const res = await fetch("/api/hub/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: String(form.get("login") ?? ""), password: String(form.get("password") ?? "") }),
      });
      if (res.ok) {
        const out = (await res.json().catch(() => null)) as { user?: { mustChangePassword?: boolean } } | null;
        window.location.assign(out?.user?.mustChangePassword ? passwordHref : next);
        return;
      }
      setFailure(res.status === 401 || res.status === 422 ? "invalid" : res.status === 429 ? "rateLimited" : res.status === 503 ? "unavailable" : "failed");
    } catch {
      setFailure("failed");
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-3">
      <div className="relative">
        <User className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input name="login" aria-label={t("login")} placeholder={t("login")} autoComplete="username" required className="h-11 pl-10" />
      </div>
      <div className="relative">
        <Lock className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          name="password"
          type={showPassword ? "text" : "password"}
          aria-label={t("password")}
          placeholder={t("password")}
          autoComplete="current-password"
          required
          className="h-11 pr-10 pl-10"
        />
        <button
          type="button"
          onClick={() => setShowPassword((prev) => !prev)}
          aria-label={t(showPassword ? "passwordHide" : "passwordShow")}
          className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
        >
          {showPassword ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`error.${failure}`)}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} size="lg" className="mt-4 h-12 w-full font-semibold tracking-[0.18em] uppercase">
        {t("submit")}
      </Button>
    </form>
  );
}
