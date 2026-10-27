import { GoldProjectMetadata } from "@/components/gold-project-metadata";
import { setRequestLocale } from "next-intl/server";

// Data and every calculation come from the API (screen projects/detail, back/bff/screens/); this page only renders.
export default async function ProjectSettingPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  return <GoldProjectMetadata id={id} kind="setting"/>;
}
