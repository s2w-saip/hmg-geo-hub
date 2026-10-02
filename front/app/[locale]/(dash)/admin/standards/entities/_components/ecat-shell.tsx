import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import type { EcatGate } from "../_ecat-data";
import { EcatNav, Notice } from "./ecat-shared";

// Page frame of the entity version sub pages: header, sub navigation, and the notice that
// replaces the content when versions are not available (legacy source, before the v1 cutover,
// backend unavailable).

export async function EcatShell({ gate, title, children }: { gate: EcatGate; title: string; children?: ReactNode }) {
  const t = await getTranslations("adminEcat.page");
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={title} description={t("subtitle")} />
      <EcatNav />
      {gate.kind === "ready" ? (
        children
      ) : (
        <Notice tone={gate.kind === "unavailable" ? "danger" : "info"} testId="ecat-gate">
          {t(gate.kind)}
        </Notice>
      )}
    </div>
  );
}
