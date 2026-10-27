import { GoldAcr } from "@/components/gold-acr";
import { setRequestLocale } from "next-intl/server";

// Data and every calculation come from the API (screens, back/bff/screens/); this page only renders.
export default async function WebsiteAiFunnelAcrPage({
  params,
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <GoldAcr sp={await searchParams}/>;
}
