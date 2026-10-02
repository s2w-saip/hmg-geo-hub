import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { defaultLandingFor } from "@/lib/auth/route-policy";

// /<locale> entry — send authed users to their default landing per role.
// Middleware already redirected unauthenticated users to /login, so when this
// page executes, the session should exist; we still guard defensively.
export default async function Home({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();
  const landing = session
    ? defaultLandingFor(session.user.role, session.user.menuGroups)
    : "/dashboard";
  redirect(`/${locale}${landing}`);
}
