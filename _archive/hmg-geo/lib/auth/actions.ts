"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/utils/supabase/server";
import { profileRepository } from "@/lib/db/repositories/profiles";
import { defaultLandingFor } from "./route-policy";
import { routing, type Locale } from "@/i18n/routing";

function formLocale(formData: FormData): Locale {
  const value = formData.get("locale");
  return routing.locales.includes(value as Locale)
    ? (value as Locale)
    : routing.defaultLocale;
}

export interface LoginState {
  error?: boolean;
}

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const locale = formLocale(formData);

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
  //
  // 로그인→랜딩 지연 절감 (2026-07-22): 여기서 getSession()을 부르면 방금
  // signInWithPassword가 검증·발급한 세션을 getClaims()로 다시 검증하고 나서
  // profile을 읽는다 — 랜딩 결정에 필요한 건 role뿐이므로, sign-in 응답이 준
  // user.id로 profile만 직접 조회한다. (redirect 이후 대시보드 요청은 요청이
  // 달라 어차피 getSession()을 새로 수행한다 — 여기서 만든 세션 캐시는 재사용
  // 되지 않는다.)
  const profile = data.user
    ? await profileRepository.getByUserId(data.user.id)
    : null;
  const landing = profile ? defaultLandingFor(profile.role) : "/dashboard";
  redirect(`/${locale}${landing}`);
}

export async function logout(formData: FormData): Promise<void> {
  const locale = formLocale(formData);
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect(`/${locale}/login`);
}
