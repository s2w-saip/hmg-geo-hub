import { redirect } from "next/navigation";

// /website/answer-analysis — redirect to first child (Mention). SNB owns the
// Mention/Citation split; the bare path lands on the default sub-page.
export default async function WebsiteAnswerAnalysisRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/website/answer-analysis/mention`);
}
