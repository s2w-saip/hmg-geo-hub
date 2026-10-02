"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ApplyStatus, EcatRole, VersionStatus } from "@/lib/hgh/adapters/admin-entities";

// Shared pieces of the entity version screens (E7): sub navigation, role / status badges and
// the number and time formatting every screen uses. Colors come from the @theme tokens only.

export const ECAT_BASE = "/admin/standards/entities";

const NAV = [
  { key: "entities", href: ECAT_BASE },
  { key: "draft", href: `${ECAT_BASE}/draft` },
  { key: "versions", href: `${ECAT_BASE}/versions` },
  { key: "review", href: `${ECAT_BASE}/review` },
  { key: "audit", href: `${ECAT_BASE}/audit` },
] as const;

/** Sub navigation of the entity management pages. `reviewCount` badges the inbox tab. */
export function EcatNav({ reviewCount }: { reviewCount?: number | null }) {
  const t = useTranslations("adminEcat.nav");
  const path = usePathname();
  const current =
    NAV.slice()
      .reverse()
      .find((n) => path === n.href || path.startsWith(n.href + "/"))?.key ??
    (path.startsWith(`${ECAT_BASE}/applies`) ? "versions" : "entities");
  return (
    <nav aria-label={t("label")} className="flex flex-wrap gap-1 border-b border-border/70">
      {NAV.map((n) => {
        const active = current === n.key;
        return (
          <Link
            key={n.key}
            href={n.href}
            data-testid={`ecat-nav-${n.key}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              active ? "border-brand-700 font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(n.key)}
            {n.key === "review" && reviewCount ? (
              <span className="rounded-full bg-sentiment-mixed/30 px-1.5 text-[10px] font-semibold tabular-nums text-ink-700">
                {reviewCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

const ROLE_CLASS: Record<EcatRole, string> = {
  own: "bg-brand-700 text-white",
  competitor: "bg-bg-subtle text-ink-700",
  hidden: "bg-ink-100 text-ink-500",
  removed: "bg-danger/10 text-danger",
};

export function RoleBadge({ role, className }: { role: EcatRole; className?: string }) {
  const t = useTranslations("adminEcat.roles");
  return <Badge className={cn("text-[10px]", ROLE_CLASS[role], className)}>{t(role)}</Badge>;
}

/** Own brand an entity's mentions count toward (prefix correction, roll-up), shown next to the register role. */
export function OwnLineageBadge({ brand, className }: { brand: string | null; className?: string }) {
  const t = useTranslations("adminEcat.list");
  return (
    <Badge
      className={cn("text-[10px]", brand ? "bg-brand-700/10 text-brand-700" : "bg-bg-subtle text-muted-foreground", className)}
      data-testid="ecat-own-lineage"
    >
      {brand ? t("ownLineage", { brand }) : t("ownLineageNone")}
    </Badge>
  );
}

const APPLY_CLASS: Record<ApplyStatus, string> = {
  draft: "bg-bg-subtle text-ink-700",
  previewed: "bg-accent-info/15 text-ink-700",
  approved: "bg-accent-soft/40 text-ink-700",
  running: "bg-sentiment-mixed/30 text-ink-700",
  applied: "bg-positive/15 text-positive",
  rejected: "bg-ink-100 text-ink-500",
  failed: "bg-danger/10 text-danger",
  rolled_back: "bg-ink-100 text-ink-700",
};

export function ApplyStatusBadge({ status }: { status: ApplyStatus }) {
  const t = useTranslations("adminEcat.status.apply");
  return (
    <Badge className={cn("text-[10px]", APPLY_CLASS[status])} data-testid="ecat-apply-status" data-status={status}>
      {t(status)}
    </Badge>
  );
}

const VERSION_CLASS: Record<VersionStatus, string> = {
  draft: "bg-sentiment-mixed/30 text-ink-700",
  active: "bg-positive/15 text-positive",
  retired: "bg-bg-subtle text-ink-500",
  discarded: "bg-ink-100 text-ink-500",
};

export function VersionStatusBadge({ status }: { status: VersionStatus }) {
  const t = useTranslations("adminEcat.status.version");
  return <Badge className={cn("text-[10px]", VERSION_CLASS[status])}>{t(status)}</Badge>;
}

/** Inline notice box. tone: info (neutral), warn (L2 / approval), danger (L1 / failure). */
export function Notice({ tone = "info", children, testId }: { tone?: "info" | "warn" | "danger"; children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "rounded-md border px-3 py-2 text-xs",
        tone === "info" && "border-border bg-bg-soft text-ink-700",
        tone === "warn" && "border-sentiment-mixed/60 bg-sentiment-mixed/10 text-ink-700",
        tone === "danger" && "border-danger/40 bg-danger/5 text-danger",
      )}
    >
      {children}
    </div>
  );
}

// ── formatting ──────────────────────────────────────────────────────────────

const KST_MS = 9 * 3600 * 1000;

/** ISO timestamp -> "YYYY-MM-DD HH:mm" in Asia/Seoul (deterministic: same on server and client). */
export function fmtTime(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const k = new Date(d.getTime() + KST_MS).toISOString();
  return `${k.slice(0, 10)} ${k.slice(11, 16)}`;
}

export const fmtInt = (n: number | null | undefined): string => (n == null ? "" : n.toLocaleString("en-US"));

export const fmtPct = (v: number | null): string => (v == null ? "" : `${v.toFixed(1)}%`);

export const fmtPos = (v: number | null): string => (v == null ? "" : v.toFixed(2));

/** Signed change with one decimal ("+1.2", "-0.4", "0.0"); empty when either side is missing. */
export function fmtDelta(before: number | null, after: number | null, digits = 1): string {
  if (before == null || after == null) return "";
  const d = after - before;
  const s = d.toFixed(digits);
  return d > 0 ? `+${s}` : s === (-0).toFixed(digits) ? (0).toFixed(digits) : s;
}

export const fmtSignedInt = (d: number): string => (d > 0 ? `+${d.toLocaleString("en-US")}` : d.toLocaleString("en-US"));

/** First 8 characters of a UUID (actor ids are shown this short; no account names or e-mails). */
export const shortId = (id: string | null | undefined): string => (id ? id.slice(0, 8) : "");

/** Context with the highlighted range wrapped in <mark>. */
export function Highlighted({ text, range }: { text: string | null; range: [number, number] | null }) {
  if (!text) return null;
  if (!range || range[0] < 0 || range[1] > text.length || range[0] >= range[1]) return <>{text}</>;
  return (
    <>
      {text.slice(0, range[0])}
      <mark className="rounded-sm bg-sentiment-mixed/40 px-0.5 text-foreground">{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  );
}
