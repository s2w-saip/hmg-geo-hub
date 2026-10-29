import { redirect } from "next/navigation";

// /standard/answer-analysis — redirect to first child. SNB now owns the
// Mention/Citation split (2026-06-04 standard SNB reorg) so the bare path
// just lands on the default sub-page.
export default async function StandardAnswerAnalysisRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/standard/answer-analysis/mention`);
}
