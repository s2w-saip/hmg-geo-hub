import { setRequestLocale } from "next-intl/server";
import { GoldProjects } from "@/components/gold-projects";

// Data and every calculation come from the API (screen projects/list, back/bff/screens/); this page only renders.
export default async function ProjectsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <GoldProjects />;
}
