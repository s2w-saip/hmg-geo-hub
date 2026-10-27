import { setRequestLocale } from "next-intl/server";
import { GoldProject } from "@/components/gold-projects";

// Data and every calculation come from the API (screen projects/detail, back/bff/screens/); this page only renders.
export default async function ProjectDashboardPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  return <GoldProject id={id} />;
}
