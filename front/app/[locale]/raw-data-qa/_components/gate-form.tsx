"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// 게이트 폼. 서버가 돌려주는 오류 코드를 그대로 사전 키에 매핑한다 — 오류 문구를
// 서버에서 만들지 않는 이유는 이 콘솔도 ko/en 사전을 따르기 때문이다.
const ERROR_KEYS: Record<string, string> = {
  "bad-credentials": "errorCredentials",
  "bad-name": "errorName",
  "rate-limited": "errorRateLimited",
};

export function GateForm({ locale }: { locale: string }) {
  const t = useTranslations("qaReview.gate");
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/qa/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password }),
      });
      if (res.ok) {
        // replace — 뒤로 가기로 게이트에 돌아와도 로그인 폼이 다시 뜨지 않게.
        router.replace(`/${locale}/raw-data-qa/answers`);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(ERROR_KEYS[data.error ?? ""] ?? "errorUnknown");
    } catch {
      setError("errorUnknown");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="qa-name">{t("name")}</Label>
        <Input
          id="qa-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
          maxLength={40}
          autoComplete="off"
          autoFocus
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="qa-password">{t("password")}</Label>
        <Input
          id="qa-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("passwordPlaceholder")}
          autoComplete="off"
          required
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(error)}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !name.trim() || !password} className="w-full">
        {busy ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
