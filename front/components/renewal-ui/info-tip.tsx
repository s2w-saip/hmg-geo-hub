import type { ReactNode } from "react";
import { Info } from "lucide-react";

/**
 * ⓘ button with a dark tooltip shown on hover and on keyboard focus. Clicking the
 * button does nothing else (it must not trigger a clickable parent row). The hidden
 * tooltip takes no space (no page overflow near the right edge); `align="end"` opens
 * it leftwards for an ⓘ that sits on the right of a card.
 */
export function RnInfoTip({ label, children, align = "start" }: { label: string; children: ReactNode; align?: "start" | "end" }) {
  return (
    <span className="group/tip relative inline-flex">
      <button
        type="button"
        aria-label={label}
        data-rn-info=""
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className="inline-grid cursor-help place-items-center opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-current"
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full z-30 mt-1.5 hidden w-[360px] max-w-[min(360px,80vw)] rounded-[10px] bg-rn-ink px-3.5 py-3 text-left text-rn-12 font-normal whitespace-normal text-white shadow-rn-3 group-focus-within/tip:block group-hover/tip:block ${align === "end" ? "right-0" : "left-0"}`}
      >
        {children}
      </span>
    </span>
  );
}

/** Label + body pair inside an info tooltip. */
export function RnInfoTipItem({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <span className="block [&+&]:mt-1.5">
      <b className="block text-rn-12 font-bold text-rn-sky">{label}</b>
      {children}
    </span>
  );
}
