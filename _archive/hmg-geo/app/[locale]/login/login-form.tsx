"use client";

import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Mail, Lock, Eye, EyeOff } from "lucide-react";
import { login, type LoginState } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Login form modeled after account.hyundai.com — icon-prefixed inputs, a
// show/hide password toggle on the right of the password field, an
// uppercase tracking-wide LOGIN button at the bottom. No "find ID" /
// "reset password" links since we don't have those features in v1; if
// they're added later they slot in above the submit button.
export function LoginForm() {
  const t = useTranslations("login");
  const locale = useLocale();
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    login,
    {},
  );
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="mt-8 flex flex-col gap-3">
      <input type="hidden" name="locale" value={locale} />

      <div className="relative">
        <Mail
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id="email"
          name="email"
          type="email"
          aria-label={t("email")}
          placeholder={t("email")}
          autoComplete="email"
          required
          className="h-11 pl-10"
        />
      </div>

      <div className="relative">
        <Lock
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id="password"
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
          aria-label={t(
            showPassword ? "passwordToggleHide" : "passwordToggleShow",
          )}
          className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
        >
          {showPassword ? (
            <Eye className="h-4 w-4" aria-hidden />
          ) : (
            <EyeOff className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>

      {state.error && (
        <p className="text-sm text-destructive">{t("error")}</p>
      )}

      <Button
        type="submit"
        disabled={pending}
        size="lg"
        className="mt-4 h-12 w-full font-semibold tracking-[0.18em] uppercase"
      >
        {t("submit")}
      </Button>
    </form>
  );
}
