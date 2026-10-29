import { redirect } from "next/navigation";

// /projects/[id]/analysis — redirect to first child (mention). The 4depth
// (mention / citation) lives in SNB now instead of in-page tabs.
export default async function ProjectAnalysisRedirect({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  redirect(`/${locale}/projects/${id}/analysis/mention`);
}
