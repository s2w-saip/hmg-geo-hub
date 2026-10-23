"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, LogOut, Menu, X } from "lucide-react";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { carryFilterParams } from "@/components/dash/filter-carry";
import { ADMIN_SUB_ITEMS, STANDARD_SUB_ITEMS, WEBSITE_SUB_ITEMS, type StandardSubItem } from "@/components/dash/sidebar";
import { logout } from "@/lib/auth/actions";
import type { RouteDef } from "@/lib/auth/route-policy";
import type { Role } from "@/lib/auth/types";
import { cx } from "@/components/renewal-ui";
import { useRnNavPending } from "./nav-pending";

// Sidebar of the renewal shell (S급 테마, docs/design/ui/*-mockup.html `.sx-side`, 2026-10-23):
// brand · Global | Website sections (each folds) · Project · Admin · account. One sidebar, no
// top bar. The items, order, labels and permissions are the original menu's
// (components/dash/sidebar.tsx trees filtered by visibleRoutes); in Global an item with a
// renewal page links to it, the rest (and Website · Project · Admin) open the original screens.
// Every link keeps prefetch={false} (the original sidebar's 2026-08-27 production rule).

/** Original page → its renewal page. */
const RENEWAL_OF: Record<string, string> = {
  "/dashboard": "/renewal/dashboard",
  "/standard/prompts": "/renewal/standard/prompts",
  "/standard/answer-analysis/mention": "/renewal/standard/answer-analysis/mention",
  "/standard/answer-analysis/citation": "/renewal/standard/answer-analysis/citation",
  "/standard/ai-funnel/acr": "/renewal/standard/ai-funnel/acr",
};

type SectionId = "standard" | "website" | "project" | "admin";
interface NavLeaf {
  /** path the link opens (and the active match) */
  path: string;
  label: string;
  beta?: boolean;
}
interface NavItem extends NavLeaf {
  children: NavLeaf[];
}

export interface RnShellUser {
  email: string;
  role: Role;
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
    { id: "standard", items: standardItems(allowed, label) },
    { id: "website", items: treeItems(WEBSITE_SUB_ITEMS, allowed, label) },
  ];
  const more: Array<{ id: SectionId; items: NavItem[] }> = [
    { id: "project", items: routes.filter((r) => r.group === "project").map((r) => ({ path: r.path, label: tNav(r.key), children: [] })) },
    { id: "admin", items: treeItems(ADMIN_SUB_ITEMS, allowed, label) },
  ];

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
          {sections.map((s) => (s.items.length ? <Section key={s.id} id={s.id} title={tNav(`groups.${s.id}`)} items={s.items} pathname={here} /> : null))}
        </nav>
        <div className="mt-auto flex flex-col gap-2">
          {more.some((s) => s.items.length) ? (
            <nav aria-label={t("moreLabel")} className="flex flex-col gap-0.5 border-t border-rn-line pt-2">
              {more.map((s) => (s.items.length ? <Section key={s.id} id={s.id} title={tNav(`groups.${s.id}`)} items={s.items} pathname={here} /> : null))}
            </nav>
          ) : null}
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

/** Global: the original tree without its "(Renewal)" rows; items with a renewal page link to it. */
function standardItems(allowed: Set<string>, label: (key: string) => string): NavItem[] {
  const leaf = (x: StandardSubItem | NonNullable<StandardSubItem["children"]>[number]): NavLeaf | null => {
    if (x.path.startsWith("/renewal/")) return null;
    const path = RENEWAL_OF[x.path] ?? x.path;
    return allowed.has(path) ? { path, label: label(x.i18nKey), beta: x.beta } : null;
  };
  const out: NavItem[] = [];
  for (const item of STANDARD_SUB_ITEMS) {
    if (item.path.startsWith("/renewal/") || !allowed.has(item.path)) continue;
    const children = (item.children ?? []).map(leaf).filter((c): c is NavLeaf => c != null);
    if (item.children?.length) {
      // the parent opens its first child: the renewal tree has no parent pages (/renewal/standard/… → no-access)
      if (!children.length) continue;
      out.push({ path: children[0].path, label: label(item.i18nKey), beta: item.beta, children });
    } else {
      const self = leaf(item);
      if (self) out.push({ ...self, children: [] });
    }
  }
  return out;
}

/** Website · Admin: the original tree as is (original screens), permission-filtered. */
function treeItems(tree: StandardSubItem[], allowed: Set<string>, label: (key: string) => string): NavItem[] {
  return tree
    .filter((item) => allowed.has(item.path))
    .map((item) => ({
      path: item.path,
      label: label(item.i18nKey),
      beta: item.beta,
      children: (item.children ?? []).filter((c) => allowed.has(c.path)).map((c) => ({ path: c.path, label: label(c.i18nKey), beta: c.beta })),
    }));
}

const isAt = (pathname: string, path: string) => pathname === path || pathname.startsWith(path + "/");

function Section({ id, title, items, pathname }: { id: SectionId; title: string; items: NavItem[]; pathname: string }) {
  const here = items.some((i) => isAt(pathname, i.path) || i.children.some((c) => isAt(pathname, c.path)));
  // Global opens by default, the others when they hold the current page; then the viewer's choice
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? (id === "standard" || here);
  return (
    <details
      open={shown}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      data-rn-sec={id}
      className="group/sec flex flex-col gap-px [&+&]:mt-2 [&+&]:border-t [&+&]:border-rn-line [&+&]:pt-2"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-2 text-rn-12 font-extrabold tracking-[0.06em] text-rn-ink uppercase hover:bg-rn-page focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronRight aria-hidden className="ml-auto size-3.5 opacity-55 transition-transform group-open/sec:rotate-90" />
      </summary>
      {items.map((item) => (
        <div key={item.path + item.label} className="flex flex-col gap-px">
          <NavLink leaf={item} active={!item.children.length && isAt(pathname, item.path)} out={id !== "standard"} parent={item.children.length > 0} />
          {item.children.map((c) => (
            <NavLink key={c.path} leaf={c} active={isAt(pathname, c.path)} out={id !== "standard"} sub />
          ))}
        </div>
      ))}
    </details>
  );
}

function NavLink({ leaf, active, out, sub = false, parent = false }: { leaf: NavLeaf; active: boolean; out: boolean; sub?: boolean; parent?: boolean }) {
  const t = useTranslations("renewal.shell");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { target, start } = useRnNavPending();
  // the spinner sits on the leaf being opened (a parent shares its first child's path)
  const pending = !parent && target != null && isAt(target, leaf.path);
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
        "relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-rn-13 no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy",
        sub && "before:size-1 before:shrink-0 before:rounded-full before:bg-current before:opacity-45",
        active
          ? "bg-rn-navy/8 font-bold text-rn-navy after:absolute after:inset-y-1.5 after:-left-3 after:w-[3px] after:rounded-r-[3px] after:bg-rn-navy"
          : cx("font-medium hover:bg-rn-navy/6", out ? "text-rn-muted hover:text-rn-ink-2" : parent ? "text-rn-ink-2" : "text-rn-ink-2 hover:text-rn-navy"),
      )}
    >
      <span className="min-w-0 truncate">{leaf.label}</span>
      {pending ? <Loader2 aria-hidden className="ml-auto size-3.5 shrink-0 animate-spin" /> : null}
      {leaf.beta ? (
        <span className="ml-auto rounded bg-rn-navy/8 px-[5px] text-rn-11 font-bold text-rn-navy">
          <span aria-hidden>β</span>
          <span className="sr-only">{t("beta")}</span>
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
        <form action={logout}>
          <input type="hidden" name="locale" value={locale} />
          <ShellIconButton label={tNav("logout")} type="submit">
            <LogOut className="size-3.5" aria-hidden />
          </ShellIconButton>
        </form>
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
