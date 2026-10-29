import { redirect } from "next/navigation";

// /website/ai-funnel — redirect to first visible child. ACR + Visibility are
// hidden from the 웹사이트 SNB (ACR lives in 표준 only), so the bare parent lands
// on Conversion, the first in-menu stage.
export default async function WebsiteAiFunnelRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/website/ai-funnel/conversion`);
}
