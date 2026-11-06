"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "./cx";

/**
 * Small popover menu anchored to a `relative` parent. Closes on outside pointer
 * down and Escape; focuses its first item when it opens.
 */
export function RnMenu({ onClose, children, className }: { onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" className={cx("absolute top-full right-1 z-20 flex min-w-[168px] flex-col rounded-[10px] border border-rn-line bg-rn-surface p-1.5 shadow-rn-3", className)}>
      {children}
    </div>
  );
}

export function RnMenuItem({ onSelect, danger = false, children }: { onSelect: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cx(
        "cursor-pointer rounded-md px-2.5 py-2 text-left text-rn-13 hover:bg-rn-page focus-visible:bg-rn-page focus-visible:outline-none",
        danger ? "text-rn-danger-ink" : "text-rn-ink-2",
      )}
    >
      {children}
    </button>
  );
}
