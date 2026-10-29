import { setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { projectRepository } from "@/lib/db/repositories/projects";
import { getSiteByScopeProjectId } from "@/lib/db/repositories/website-sites";

// Scope 컨설턴트 콘솔(/console)의 진입점 — 콘솔은 scope project_id 만 알고
// 들어오므로, 로컬 프로젝트로 해석해 상세로 넘긴다. 프로젝트 접근 권한
// (멤버십/role)은 리다이렉트 대상인 /projects/[id] 가 그대로 집행한다.
export default async function ProjectByScopeRedirect({
  params,
}: {
  params: Promise<{ locale: string; scopeId: string }>;
}) {
  const { locale, scopeId } = await params;
  setRequestLocale(locale);

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const project = await projectRepository.getByScopeProjectId(scopeId);
  if (project) redirect(`/${locale}/projects/${project.id}`);

  // HMG 워크스페이스의 scope 프로젝트 다수는 로컬 projects 가 아니라 웹사이트
  // 트랙(website_sites)에 연결돼 있다 — 그 경우 웹사이트 대시보드를 해당
  // 브랜드·국가 필터로 연다 (2026-08-14 Genesis/AE 404 실증).
  const site = await getSiteByScopeProjectId(scopeId);
  if (site) {
    const qs = new URLSearchParams({
      geography: site.countryCode,
      brand: site.brand,
    });
    redirect(`/${locale}/website?${qs.toString()}`);
  }

  notFound();
}
