import { redirect } from "next/navigation";

// /projects/[id]/ai-funnel → redirect to first VISIBLE child (Conversion).
// Visibility (mock-only, 2026-06-23) and ACR (2026-07-01, 표준 전용) are hidden
// from the project SNB so the bare parent lands on the first in-menu stage.
export default async function ProjectAiFunnelRedirect({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  redirect(`/${locale}/projects/${id}/ai-funnel/conversion`);
}
