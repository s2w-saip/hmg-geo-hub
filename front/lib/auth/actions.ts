"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/utils/supabase/server";
import { profileRepository } from "@/lib/db/repositories/profiles";
import { hghSource } from "@/lib/hgh/client";
import { fetchSessionData, normalizeMenuGroups } from "@/lib/hgh/adapters/session";
import { defaultLandingFor } from "./route-policy";
import { effectiveMenuGroups } from "./menu-groups";

export interface LoginState {
  error?: boolean;
}

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const locale = String(formData.get("locale") ?? "ko");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) {
    return { error: true };
  }

  // Send the user to the first menu their role can reach. country (zero menus)
  // lands on /no-access. Direct URL entry to a non-permitted route is gated
  // separately in DashLayout (route-policy). Spec: "디폴트 도착 라우트에 도달".
  const landing =
    hghSource("SESSION") === "api"
      ? await apiLanding(data.session?.access_token ?? null)
      : await legacyLanding(data.user?.id ?? null);
  redirect(`/${locale}${landing}`);
}

// api source (HGH_SOURCE_SESSION=api, design 1.3): one GET /v1/auth/me with the token the
// sign-in just issued (the request cookies do not carry it yet, so it is passed explicitly),
// then the same rule as the locale root page (app/[locale]/page.tsx):
// defaultLandingFor(role, menuGroups). With the menu groups an account whose groups exclude
// its role's first menu lands on its first allowed menu directly (not on a page the (dash)
// guard then bounces to /no-access). The derived groups (hmg-geo #329: WW·CPO drop standard)
// come from the backend menu_groups (sync S1 BE-7); legacy derives them below.
// Backend 401 (no_account: no app account for this Supabase user) lands on /dashboard like
// the legacy "no profile" branch (the (dash) layout then finds no session). Other failures
// are thrown, as a failed profiles read was.
async function apiLanding(accessToken: string | null): Promise<string> {
  if (!accessToken) return "/dashboard";
  const me = await fetchSessionData({ bearer: accessToken });
  if (!me) return "/dashboard";
  return defaultLandingFor(me.role, normalizeMenuGroups(me.menu_groups));
}

// legacy source (hmg-geo main as of 2670a16).
// 로그인→랜딩 지연 절감 (2026-07-22): 여기서 getSession()을 부르면 방금
// signInWithPassword가 검증·발급한 세션을 getClaims()로 다시 검증하고 나서
// profile을 읽는다. 랜딩 결정에 필요한 건 role·메뉴 그룹뿐이므로, sign-in 응답이 준
// user.id로 profile만 직접 조회한다. (redirect 이후 대시보드 요청은 요청이
// 달라 어차피 getSession()을 새로 수행한다. 여기서 만든 세션 캐시는 재사용
// 되지 않는다.)
// 메뉴 그룹까지 본다: 역할만 보면 메뉴가 좁혀진 계정(글로벌 숨김 등)이 없는 화면으로
// 갔다가 /no-access 로 튕긴다. 세션과 같은 파생 함수(menu-groups.ts).
async function legacyLanding(userId: string | null): Promise<string> {
  const profile = userId ? await profileRepository.getByUserId(userId) : null;
  return profile
    ? defaultLandingFor(
        profile.role,
        effectiveMenuGroups(profile.menuGroups, {
          all: profile.scopeAll,
          countries: profile.countries ?? undefined,
        }),
      )
    : "/dashboard";
}

export async function logout(formData: FormData): Promise<void> {
  const locale = String(formData.get("locale") ?? "ko");
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect(`/${locale}/login`);
}
