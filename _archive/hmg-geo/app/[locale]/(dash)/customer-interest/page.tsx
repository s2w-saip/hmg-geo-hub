import { redirect } from "next/navigation";

// /customer-interest — redirect to first child (google-keywords).
// overview was deprecated 2026-06-11 (기획 폐기).
export default async function CustomerInterestRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/customer-interest/google-keywords`);
}
