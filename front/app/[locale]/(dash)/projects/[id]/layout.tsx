import type { ReactNode } from "react";
import { setRequestLocale } from "next-intl/server";
import { ProjectMetaBroadcast } from "@/components/dash/project-meta-broadcast";
import { requireProjectPage, toSnbMeta } from "@/lib/hgh/adapters/project-gate";

// Project detail wrapper: the gate (screen shared/project-gate; a missing project is notFound) and
// the project meta broadcast to the SNB header, which this layout re-renders on soft navigation.
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const project = await requireProjectPage(locale, id);
  return <div className="flex flex-col gap-6"><ProjectMetaBroadcast meta={toSnbMeta(project)} />{children}</div>;
}
