"use client";

import { type ComponentType, type ReactNode, useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  LayoutGrid,
  Globe,
  FolderKanban,
  ShieldCheck,
  LogOut,
} from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { carryFilterParams } from "@/components/dash/filter-carry";
import { logout } from "@/lib/auth/actions";
import { ROUTES, type RouteGroup } from "@/lib/auth/route-policy";
import type { Role } from "@/lib/auth/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 1depth navigation rendered as a NARROW LEFT RAIL (per the v19 dashboard
// sketch). Three group entries — 표준 / Project / Admin — stack vertically
// as icon + abbreviated label tiles. User identity tile lives at the rail
// bottom. The rail sits BELOW the common top header (h-14) + beta-notice
// banner (h-10), so its sticky origin is lg:top-24 and height fills the
// remaining viewport (100vh - 6rem) — same offset as the KPI filter panel
// (see beta-notice.tsx). Getting this wrong makes the rail taller than the
// viewport, so the page always scrolls ~40px and the rail slides under the
// banner instead of staying pinned.

const GROUP_ICON: Record<RouteGroup, ComponentType<{ className?: string }>> = {
  standard: LayoutGrid,
  website: Globe,
  project: FolderKanban,
  admin: ShieldCheck,
};

export type RailTab = { group: RouteGroup; href: string };
export type RailUser = { email: string; role: Role };

export function GnbRail({
  tabs,
  user,
  locale,
  footerSlot,
}: {
  tabs: readonly RailTab[];
  user: RailUser;
  locale: string;
  footerSlot?: ReactNode;
}) {
  // Compute active group client-side from the current path. The previous
  // server-prop approach relied on layout re-rendering with a fresh
  // x-pathname header on every client navigation — which the App Router's
  // router cache does NOT guarantee for layouts shared across segments.
  // usePathname always returns the live pathname, so the active tile flips
  // the moment soft navigation lands.
  const pathname = usePathname();
  const active: RouteGroup = useMemo(() => {
    const match = ROUTES.find(
      (r) => pathname === r.path || pathname.startsWith(r.path + "/"),
    );
    return match?.group ?? tabs[0]?.group ?? "standard";
  }, [pathname, tabs]);

  return (
    <aside
      className="hidden shrink-0 flex-col bg-brand-700 text-white lg:sticky lg:top-24 lg:flex lg:h-[calc(100vh-6rem)] lg:w-20"
      aria-label="Primary"
    >
      <nav className="flex flex-1 flex-col items-stretch gap-1 px-2 py-4">
        {tabs.map((tab) => (
          <RailTabLink
            key={tab.group}
            tab={tab}
            active={tab.group === active}
          />
        ))}
      </nav>

      <div className="flex flex-col items-stretch gap-2 border-t border-white/15 px-2 py-3">
        {footerSlot}
        <UserTile user={user} locale={locale} />
      </div>
    </aside>
  );
}

function RailTabLink({ tab, active }: { tab: RailTab; active: boolean }) {
  const t = useTranslations("nav.groups");
  const Icon = GROUP_ICON[tab.group];
  // 표준 그룹 안에서 Global 탭(→/dashboard)으로 되돌아갈 때도 필터 쿼리를
  // 이월한다 — SNB 트리(sidebar.tsx renderTree)와 동일 규칙(filter-carry.ts).
  // 다른 그룹 탭·다른 그룹 출발은 매니페스트 미등재라 경로 그대로 반환된다.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (
    <Link
    // prefetch 끄기(2026-08-27): next/link 기본 auto 프리페치가 뷰포트에 들어온
    // 링크마다 라우트를 미리 렌더시킨다. 프로덕션 로그 실측에서 사이드바가
    // 보이는 순간 (dash) leaf 라우트 **7개가 같은 초에** 요청됐고, 그 렌더들이
    // Suspense 안에서 미러 집계 트랜잭션을 열어 둔 채 셸만 응답했다. 그 뒤
    // Vercel 이 인스턴스를 정지시키면 트랜잭션이 문장 사이에서 얼어 scope_*
    // 테이블에 AccessShareLock 을 수 분간 쥔다(0046 ALTER 가 55P03 으로 거부된
    // 원인). 잃는 것은 loading.tsx 셸의 선행 렌더뿐이고 — 실데이터는 어차피
    // 프리페치 대상이 아니다 — 클릭 시 셸은 즉시 나온다.
    prefetch={false}
      href={carryFilterParams(pathname, tab.href, searchParams)}
      aria-current={active ? "page" : undefined}
      className={cn(
        // Explicit hex on hover/active so contrast is unmistakable against the
        // dark brand-700 ground — earlier translucent whites washed out at
        // certain viewport sizes.
        "group relative flex w-full flex-col items-center gap-1 rounded-md px-2 py-3 text-[11px] font-medium tracking-tight transition-colors",
        active
          ? "bg-white/20 text-white"
          : "text-white/85 hover:bg-white/10 hover:text-white",
      )}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-sm bg-white"
        />
      ) : null}
      <Icon className="h-5 w-5" aria-hidden />
      <span className="text-center leading-tight">{t(tab.group)}</span>
    </Link>
  );
}

function UserTile({ user, locale }: { user: RailUser; locale: string }) {
  const tNav = useTranslations("nav");
  const tRoles = useTranslations("roles");
  const handle = user.email.split("@")[0] || "user";
  const monogram = handle.charAt(0).toUpperCase();
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-sm font-semibold text-brand-700">
        {monogram}
      </div>
      <span
        className="max-w-[3.75rem] truncate text-center text-[10px] text-white"
        title={user.email}
      >
        {handle}
      </span>
      <span
        className="max-w-[3.75rem] truncate text-center text-[9px] text-white/70"
        title={tRoles(user.role)}
      >
        {tRoles(user.role)}
      </span>
      <form action={logout}>
        <input type="hidden" name="locale" value={locale} />
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          aria-label={tNav("logout")}
          title={tNav("logout")}
          className="mt-0.5 text-white/85 hover:bg-white/10 hover:text-white"
        >
          <LogOut className="h-4 w-4" aria-hidden />
        </Button>
      </form>
    </div>
  );
}
