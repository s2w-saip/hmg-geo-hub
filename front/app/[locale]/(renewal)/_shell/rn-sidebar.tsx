"use client";

import { useEffect, useId, useState, type ComponentType, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Briefcase, ChevronDown, Construction, Loader2, LogOut, Menu, X } from "lucide-react";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { carryFilterParams } from "@/components/dash/filter-carry";
import { ADMIN_SUB_ITEMS, STANDARD_SUB_ITEMS, WEBSITE_SUB_ITEMS, type StandardSubItem } from "@/components/dash/sidebar";
import { useHubLogout } from "@/components/hub-session";
import { logout } from "@/lib/auth/actions";
import type { RouteDef } from "@/lib/auth/route-policy";
import type { Role } from "@/lib/auth/types";
import { cx } from "@/components/renewal-ui";
import { useRnNavPending } from "./nav-pending";
import { RENEWAL_PAGES } from "./renewal-pages";

// Sidebar of the renewal shell (S급 테마, 2026-10-23; rules: docs/design/ui/design-rules.html '틀'):
// brand · Global | Website sections (each folds) · Project · Admin · account. One sidebar, no
// top bar. The items, order, labels and permissions are the original menu's
// (components/dash/sidebar.tsx trees filtered by visibleRoutes). Every item opens /renewal<path>
// (2026-10-28): its renewal page where there is one, else the "not implemented" page
// (renewal/[...slug]) — the shell never sends a viewer to the original screens. Every section is open at
// first, so the whole menu shows down to its sub-items.
// Look (2026-10-28, user: the best UX, whatever the change size): quiet section titles, the one holding
// this page in ink (no parent menu name sits above page titles, so the sidebar alone says Global or
// Website); first-level items and menu parents carry the original menu's icon; a menu parent is a heading
// over its sub-items, not a link, and the sub-items sit inside a tree line whose stretch lights up beside
// the current one.
// 2026-10-29 (user): an item without a renewal page carries a "not implemented" icon; the β badge is gone.
// Every link keeps prefetch={false} (the original sidebar's 2026-08-27 production rule).

const RENEWAL = "/renewal";

type SectionId = "standard" | "website" | "project" | "admin";
type NavIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
interface NavLeaf {
  /** path the link opens (and the active match) */
  path: string;
  label: string;
  /** no renewal page yet: the item opens the "not implemented" page */
  unimplemented: boolean;
}
interface NavItem extends NavLeaf {
  /** first level only (the original menu's icon); sub-items have none */
  icon?: NavIcon;
  children: NavLeaf[];
}

export interface RnShellUser {
  email: string;
  role: Role;
  /** local mode: sign-in / sign-out are the HUB login (the top-level administrator), not Supabase */
  local?: boolean;
}

export function RnSidebar({ routes, user, locale }: { routes: readonly RouteDef[]; user: RnShellUser; locale: string }) {
  const tNav = useTranslations("nav");
  const t = useTranslations("renewal.shell");
  const pathname = usePathname();
  const { target } = useRnNavPending();
  const [drawer, setDrawer] = useState(false);
  // a pending click (nav-pending.tsx) already counts as "here": the item turns active at once
  const here = target ?? pathname;

  // the off-canvas menu (below lg) closes on a menu click, on navigation and on Escape
  useEffect(() => setDrawer(false), [pathname, target]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  // deny by default: only the routes this account may open (role + menuGroups, not hidden)
  const allowed = new Set(routes.map((r) => r.path));
  const label = (key: string) => tNav(key);
  const sections: Array<{ id: SectionId; items: NavItem[] }> = [
    { id: "standard", items: menuItems(STANDARD_SUB_ITEMS, allowed, label) },
    { id: "website", items: menuItems(WEBSITE_SUB_ITEMS, allowed, label) },
  ];
  const more: Array<{ id: SectionId; items: NavItem[] }> = [
    {
      id: "project",
      items: routes
        .filter((r) => r.group === "project")
        .map((r) => ({ path: RENEWAL + r.path, label: tNav(r.key), unimplemented: !RENEWAL_PAGES.has(r.path), icon: Briefcase, children: [] })),
    },
    { id: "admin", items: menuItems(ADMIN_SUB_ITEMS, allowed, label) },
  ];
  // the current item: the longest menu path that holds this page (/renewal/website holds every Website page)
  const current = [...sections, ...more]
    .flatMap((s) => s.items.flatMap((i) => (i.children.length ? i.children : [i])))
    .reduce<string | null>((best, l) => (isAt(here, l.path) && l.path.length > (best?.length ?? 0) ? l.path : best), null);

  return (
    <>
      {/* below lg: a slim bar with the menu button (the sidebar becomes an off-canvas sheet) */}
      <div className="flex h-12 items-center gap-2.5 border-b border-rn-line bg-rn-surface px-3 lg:hidden">
        <button
          type="button"
          aria-label={tNav("openSidebar")}
          aria-expanded={drawer}
          onClick={() => setDrawer(true)}
          className="grid size-9 cursor-pointer place-items-center rounded-lg text-rn-ink-2 hover:bg-rn-page focus-visible:outline-2 focus-visible:outline-rn-navy"
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <Brand />
      </div>
      {drawer ? <div aria-hidden className="fixed inset-0 z-40 bg-rn-ink/35 lg:hidden" onClick={() => setDrawer(false)} /> : null}
      <aside
        aria-label={t("sideLabel")}
        data-rn-shell-side=""
        className={cx(
          "flex min-h-0 flex-col gap-3.5 overflow-y-auto border-r border-rn-line bg-rn-surface px-3 pt-[18px] pb-3.5",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:w-[280px] max-lg:shadow-rn-3 max-lg:transition-transform",
          drawer ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between">
          <Brand />
          <button
            type="button"
            aria-label={t("closeMenu")}
            onClick={() => setDrawer(false)}
            className="grid size-8 cursor-pointer place-items-center rounded-lg text-rn-muted hover:bg-rn-page lg:hidden"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <nav aria-label={t("menuLabel")} className="flex flex-col gap-px">
          {sections.map((s) => (s.items.length ? <Section key={s.id} id={s.id} title={tNav(`groups.${s.id}`)} items={s.items} current={current} /> : null))}
        </nav>
        {/* Project · Admin follow right after (2026-10-28: not pushed to the bottom); only the account is */}
        {more.some((s) => s.items.length) ? (
          <nav aria-label={t("moreLabel")} className="flex flex-col gap-px border-t border-rn-line pt-3">
            {more.map((s) => (s.items.length ? <Section key={s.id} id={s.id} title={tNav(`groups.${s.id}`)} items={s.items} current={current} /> : null))}
          </nav>
        ) : null}
        <div className="mt-auto">
          <Account user={user} locale={locale} />
        </div>
      </aside>
    </>
  );
}

function Brand() {
  const t = useTranslations("renewal.shell");
  return (
    <span className="flex items-center gap-2.5 px-2 pt-0.5 pb-1">
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-rn-navy text-rn-12 font-extrabold tracking-[-0.02em] text-white">
        G
      </span>
      <span className="flex flex-col leading-[1.15]">
        <b className="text-[14px] font-extrabold tracking-[-0.01em] text-rn-navy">{t("brand")}</b>
        <small className="text-rn-11 text-rn-muted">{t("brandSub")}</small>
      </span>
    </span>
  );
}

/** One original tree, permission-filtered on the original rows; every item opens /renewal<path>. */
function menuItems(tree: StandardSubItem[], allowed: Set<string>, label: (key: string) => string): NavItem[] {
  const leaf = (x: StandardSubItem | NonNullable<StandardSubItem["children"]>[number]): NavLeaf => ({
    path: RENEWAL + x.path,
    label: label(x.i18nKey),
    unimplemented: !RENEWAL_PAGES.has(x.path),
  });
  const out: NavItem[] = [];
  for (const item of tree) {
    if (!allowed.has(item.path)) continue;
    if (item.children?.length) {
      // a parent is a heading over its children (NavGroup), not a link; its path (the first child's) keys it
      const children = item.children.filter((c) => allowed.has(c.path)).map(leaf);
      if (children.length) out.push({ ...leaf(item), path: children[0].path, icon: item.icon, children });
    } else {
      out.push({ ...leaf(item), icon: item.icon, children: [] });
    }
  }
  return out;
}

const isAt = (pathname: string, path: string) => pathname === path || pathname.startsWith(path + "/");

function Section({ id, title, items, current }: { id: SectionId; title: string; items: NavItem[]; current: string | null }) {
  // every section opens at first (the whole menu shows); then the viewer's choice
  const [open, setOpen] = useState(true);
  const here = items.some((i) => (i.children.length ? i.children : [i]).some((l) => l.path === current));
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-rn-sec={id} className="group/sec flex flex-col gap-px [&+&]:mt-3.5">
      <summary
        data-rn-sec-here={here ? "" : undefined}
        className={cx(
          "flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 py-1.5 text-rn-11 font-bold tracking-[0.08em] uppercase hover:bg-rn-page hover:text-rn-ink-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy [&::-webkit-details-marker]:hidden",
          here ? "text-rn-ink" : "text-rn-muted",
        )}
      >
        {title}
        <ChevronDown aria-hidden className="ml-auto size-3 -rotate-90 transition-transform group-open/sec:rotate-0" />
      </summary>
      {items.map((item) =>
        item.children.length ? (
          <NavGroup key={item.path + item.label} item={item} current={current} />
        ) : (
          <NavLink key={item.path + item.label} leaf={item} active={item.path === current} icon={item.icon} />
        ),
      )}
    </details>
  );
}

// A menu parent (Answer analysis, AI Agent Funnel, Global config, 측정 크레딧) only holds its sub-items
// (2026-10-28, user): a heading over them, not a link — bold, muted, no hover or pointer — and they hang
// from it inside a tree line under its icon. The group is named by it for assistive tech.
function NavGroup({ item, current }: { item: NavItem; current: string | null }) {
  const id = useId();
  const Icon = item.icon;
  return (
    <div role="group" aria-labelledby={id} className="mt-0.5 flex flex-col gap-px">
      <div id={id} data-rn-nav-group="" className="flex min-h-8 items-center gap-2.5 px-2.5 text-rn-12 font-bold text-rn-muted">
        {Icon ? <Icon aria-hidden className="size-4 shrink-0 text-rn-faint" /> : null}
        <span>{item.label}</span>
      </div>
      {/* the line runs under the heading's icon (px-2.5 + half of size-4) */}
      <div data-rn-nav-tree="" className="mb-0.5 ml-[17px] flex flex-col gap-px border-l border-rn-line pl-1.5">
        {item.children.map((c) => (
          <NavLink key={c.path} leaf={c} active={c.path === current} kid />
        ))}
      </div>
    </div>
  );
}

function NavLink({ leaf, active, icon: Icon, kid = false }: { leaf: NavLeaf; active: boolean; icon?: NavIcon; kid?: boolean }) {
  const tUnimplemented = useTranslations("unimplemented");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { target, start } = useRnNavPending();
  // the spinner sits on the leaf being opened
  const pending = target != null && isAt(target, leaf.path);
  return (
    <Link
      prefetch={false}
      href={carryFilterParams(pathname, leaf.path, searchParams)}
      onClick={(e) => {
        // a plain left click opens the page here — modified clicks (new tab / window) do not wait
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
        start(leaf.path);
      }}
      aria-current={active ? "page" : undefined}
      data-rn-nav={leaf.path}
      data-rn-nav-pending={pending ? "" : undefined}
      className={cx(
        "group/link relative flex items-center gap-2.5 rounded-lg px-2.5 text-rn-13 no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy",
        kid ? "min-h-[30px]" : "min-h-8",
        active ? "bg-rn-navy/8 font-semibold text-rn-navy" : "font-medium text-rn-ink-2 hover:bg-rn-navy/6 hover:text-rn-navy",
        // the current sub-item lights its stretch of the tree line (the line sits pl-1.5 + 1px to the left)
        kid && active && "before:absolute before:inset-y-1.5 before:-left-[7px] before:w-0.5 before:rounded-full before:bg-rn-navy",
      )}
    >
      {Icon ? <Icon aria-hidden className={cx("size-4 shrink-0", active ? "text-rn-navy" : "text-rn-faint group-hover/link:text-rn-navy")} /> : null}
      <span className="min-w-0 truncate">{leaf.label}</span>
      {pending ? <Loader2 aria-hidden className="ml-auto size-3.5 shrink-0 animate-spin" /> : null}
      {leaf.unimplemented ? (
        <span data-rn-nav-unimplemented="" title={tUnimplemented("label")} className={cx("flex shrink-0", !pending && "ml-auto")}>
          <Construction aria-hidden className="size-3.5 text-rn-faint" />
          <span className="sr-only">{tUnimplemented("label")}</span>
        </span>
      ) : null}
    </Link>
  );
}

function Account({ user, locale }: { user: RnShellUser; locale: string }) {
  const tNav = useTranslations("nav");
  const tRoles = useTranslations("roles");
  const tLocale = useTranslations("locale");
  const current = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hubLogout = useHubLogout(locale);
  const handle = user.email.split("@")[0] || user.email;
  const next = routing.locales.find((l) => l !== current) ?? current;
  // the query stays: renewal filters live in the URL (the header switcher drops it)
  const switchLocale = () => {
    const qs = searchParams.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { locale: next });
  };
  return (
    <div className="flex items-center gap-2.5 border-t border-rn-line px-2 pt-2 pb-0.5">
      <span aria-hidden className="grid size-[30px] shrink-0 place-items-center rounded-full bg-rn-navy-50 text-rn-12 font-extrabold text-rn-navy">
        {handle.charAt(0).toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-col leading-[1.3]" title={user.email}>
        <b className="truncate text-rn-12 text-rn-ink">{handle}</b>
        <small className="truncate text-rn-11 text-rn-muted">{tRoles(user.role)}</small>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <ShellIconButton label={`${tLocale("label")}: ${tLocale(next)}`} onClick={switchLocale}>
          <span className="text-rn-11 font-bold uppercase">{current}</span>
        </ShellIconButton>
        {/* the local mode's session is always the HUB login (2026-10-28) */}
        {user.local ? (
          <ShellIconButton label={tNav("logout")} onClick={() => void hubLogout()}>
            <LogOut className="size-3.5" aria-hidden />
          </ShellIconButton>
        ) : user.role !== "local_reader" && <form action={logout}>
          <input type="hidden" name="locale" value={locale} />
          <ShellIconButton label={tNav("logout")} type="submit">
            <LogOut className="size-3.5" aria-hidden />
          </ShellIconButton>
        </form>}
      </span>
    </div>
  );
}

function ShellIconButton({ label, onClick, type = "button", children }: { label: string; onClick?: () => void; type?: "button" | "submit"; children: ReactNode }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 min-w-7 cursor-pointer place-items-center rounded-md px-1 text-rn-muted hover:bg-rn-page hover:text-rn-ink focus-visible:outline-2 focus-visible:outline-rn-navy"
    >
      {children}
    </button>
  );
}
