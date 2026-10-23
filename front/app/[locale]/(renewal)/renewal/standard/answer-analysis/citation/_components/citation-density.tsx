"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { RnSegmented } from "@/components/renewal-ui";

// 보기 밀도 (기본 | 촘촘) of the renewal Citation page. With the section quick-nav gone
// (2026-10-22) the control bar held only this toggle, so the bar went and the toggle sits in
// the page header next to 링크 복사; the provider wraps the page so header and body share it.

const Ctx = createContext<{ dense: boolean; setDense: (v: boolean) => void }>({ dense: false, setDense: () => {} });

export function RnCitationDensityProvider({ children }: { children: ReactNode }) {
  const [dense, setDense] = useState(false);
  const value = useMemo(() => ({ dense, setDense }), [dense]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCitationDensity() {
  return useContext(Ctx);
}

export function RnCitationDensityToggle() {
  const { dense, setDense } = useCitationDensity();
  const t = useTranslations("renewal.citation.density");
  return (
    <RnSegmented
      label={t("label")}
      value={dense ? "dense" : "normal"}
      onChange={(v) => setDense(v === "dense")}
      items={[
        { value: "normal", label: t("normal") },
        { value: "dense", label: t("dense") },
      ]}
    />
  );
}
