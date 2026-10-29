import { redirect } from "next/navigation";

// /admin/standards — redirect to first child (표준 프롬프트). SNB now owns
// the 2-child nav via ADMIN_SUB_ITEMS (2026-06-04 admin SNB reorg).
export default async function AdminStandardsRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/admin/standards/prompts`);
}
