import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Database, Workflow, Lock, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Three empty-state contexts the app produces:
//   - mock     : the backend is in mock mode (SCOPE_MODE=mock). Data is fake
//                placeholder — show a stamp-like "MOCK" badge so it's
//                unmistakable, and tile the surface with an engineering dot
//                grid suggesting "real data plots here, eventually".
//   - pending  : the data source itself is undecided (e.g. customer-interest
//                channels). No data exists yet, by design.
//   - no-access: the user has no menu entries permitted. The /no-access route
//                surfaces this with an action slot for the logout form.
//                Corner ticks + a thicker top edge frame it as a "restricted"
//                panel without resorting to red/alarm visuals.
//
// Spec (design-system): each variant uses a distinct visual treatment instead
// of a single dashed-box for every case.

export type EmptyStateVariant = "mock" | "pending" | "no-access";

type EmptyStateProps = {
  variant?: EmptyStateVariant;
  /** Optional override; otherwise pulls from emptyState.{variant}.title */
  title?: string;
  /** Optional override; otherwise pulls from emptyState.{variant}.description */
  description?: string;
  /** Action slot — used by no-access for the logout form. */
  action?: ReactNode;
  /**
   * Back-compat shim. `mock={true}` ⇒ variant="mock"; `mock={false}` ⇒
   * variant="pending". New call sites should pass `variant` directly.
   * @deprecated
   */
  mock?: boolean;
  className?: string;
};

const VARIANT_ICON: Record<EmptyStateVariant, LucideIcon> = {
  mock: Database,
  pending: Workflow,
  "no-access": Lock,
};

// Per-variant chrome for the icon plate. Same dimensions across variants
// (h-12 w-12) so panels visually align in a grid; only the tone shifts.
const VARIANT_ICON_PLATE: Record<EmptyStateVariant, string> = {
  mock: "border-brand-700/20 bg-card text-brand-700",
  pending: "border-border bg-card text-muted-foreground",
  "no-access": "border-brand-700/30 bg-brand-700/10 text-brand-700",
};

// Per-variant panel chrome. no-access gets a thicker top edge in brand tone
// as a "this surface is restricted" cue paired with the corner ticks.
const VARIANT_PANEL: Record<EmptyStateVariant, string> = {
  mock: "border-border",
  pending: "border-border",
  "no-access": "border-t-2 border-t-brand-700/40",
};

// Decorative background SVGs — each variant communicates its semantics via
// a different schematic motif. All aria-hidden; the visible copy carries
// the meaning. SVG ids are static and shared across instances because the
// definitions are identical — browsers resolve `url(#id)` against the first
// matching definition, which gives every instance the same visual.

function MockPattern() {
  // Engineering grid of small dots at very low opacity. Reads as "this is
  // a placeholder surface where real data would plot to". Pattern is
  // intentionally sparse so it doesn't compete with the headline copy.
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full text-brand-700"
      aria-hidden
      role="presentation"
    >
      <defs>
        <pattern
          id="hmg-empty-mock-dots"
          width="14"
          height="14"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r="1" fill="currentColor" opacity="0.10" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#hmg-empty-mock-dots)" />
    </svg>
  );
}

function NoAccessCorners() {
  // L-shaped tick marks at the four corners — security/blueprint frame
  // language. Four tiny absolute boxes (not one SVG) so the marks stay
  // crisp at any panel size without viewBox math.
  const base = "absolute h-3 w-3 border-brand-700/40";
  return (
    <>
      <span aria-hidden className={cn(base, "top-3 left-3 border-t-2 border-l-2")} />
      <span aria-hidden className={cn(base, "top-3 right-3 border-t-2 border-r-2")} />
      <span aria-hidden className={cn(base, "bottom-3 left-3 border-b-2 border-l-2")} />
      <span aria-hidden className={cn(base, "bottom-3 right-3 border-b-2 border-r-2")} />
    </>
  );
}

export function EmptyState({
  variant,
  title,
  description,
  action,
  mock,
  className,
}: EmptyStateProps) {
  const t = useTranslations("emptyState");
  const resolved: EmptyStateVariant =
    variant ?? (mock === true ? "mock" : "pending");
  const Icon = VARIANT_ICON[resolved];
  const resolvedTitle = title ?? t(`${resolved}.title`);
  const resolvedDescription = description ?? t(`${resolved}.description`);

  return (
    <div
      data-variant={resolved}
      className={cn(
        "relative overflow-hidden rounded-lg border bg-muted/30 animate-fade-in",
        VARIANT_PANEL[resolved],
        className,
      )}
    >
      {/* Decorative background layer — one motif per variant. */}
      {resolved === "mock" ? <MockPattern /> : null}
      {resolved === "no-access" ? <NoAccessCorners /> : null}

      {/* Mock "stamp" — top-right, slightly rotated like an inspection mark.
          Monospaced tracking-wide caps reinforce the labeled/marked reading. */}
      {resolved === "mock" ? (
        <span
          aria-hidden
          className="absolute top-4 right-4 -rotate-3 border-[1.5px] border-brand-700/45 px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.18em] text-brand-700/70 uppercase"
        >
          {t("mock.badge")}
        </span>
      ) : null}

      <div className="relative z-10 flex min-h-[200px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
        <div
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-lg border shadow-soft",
            VARIANT_ICON_PLATE[resolved],
          )}
        >
          <Icon className="h-6 w-6" aria-hidden />
        </div>
        <p className="font-head text-base font-semibold text-foreground">
          {resolvedTitle}
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          {resolvedDescription}
        </p>
        {action ? <div className="mt-1">{action}</div> : null}
      </div>
    </div>
  );
}
