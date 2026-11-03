import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { screenGet } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import { RnProjectTabBroadcast } from "../../../_shell/rn-project-tab";
import type { ProjectRow } from "../_components/project-model";

// A project tab (menu option D, 2026-11-03): a project Gold has (screen projects/list; else 404), handed to the
// sidebar's card with every project for its switch. Re-rendered when the tab moves to another project.
export default async function RenewalProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  let rows: ProjectRow[];
  try {
    rows = (await screenGet<{ items: ProjectRow[] }>("projects/list")).items;
  } catch (e) {
    throwForPage(e, locale);
  }
  if (!rows.some((r) => r.id === id)) notFound();
  return (
    <>
      <RnProjectTabBroadcast data={{ id, rows }} />
      {children}
    </>
  );
}
