"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { inviteMember } from "../_actions";

// Invite form for the Members tab. Owner-only — the parent page already
// gated render on Owner status, so the form just calls the action. On
// validation failure (bad email, duplicate, etc.) we surface the action's
// returned message via sonner toast and clear the input on success.
//
// Permission ("Viewer 고정") is intentionally NOT exposed in the form per
// the v22 flow #4 spec — the field is fixed at the action layer.
export function InviteForm({ projectId }: { projectId: string }) {
  const t = useTranslations("projectDetail.member.invite");
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email.trim()) return;
    startTransition(async () => {
      const result = await inviteMember(projectId, email);
      if (result.ok) {
        toast.success(t("success"));
        setEmail("");
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor="invite-email">{t("emailLabel")}</Label>
        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("emailPlaceholder")}
          disabled={pending}
          required
        />
      </div>
      <Button type="submit" disabled={pending || !email.trim()}>
        <UserPlus className="h-4 w-4" aria-hidden />
        {t("submit")}
      </Button>
    </form>
  );
}
