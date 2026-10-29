import { redirect } from "next/navigation";

// /standard/ai-funnel — redirect to first VISIBLE child (ACR). Visibility is
// hidden from the SNB (mock-only, 2026-06-23) so the bare parent path lands on
// the first stage that's actually in the menu.
export default async function StandardAiFunnelRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/standard/ai-funnel/acr`);
}
