import { redirect } from "next/navigation";

// /projects/[id]/intent — redirect to its first child (google-keyword). The
// SNB carries the 4depth split now (Google Keyword / Social Scraping) so
// the bare /intent URL just lands the user on the default sub-page.
export default async function ProjectIntentRedirect({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  redirect(`/${locale}/projects/${id}/intent/google-keyword`);
}
