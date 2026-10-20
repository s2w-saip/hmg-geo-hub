"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { RnIconButton } from "./button";

/**
 * Right-side sheet (modal dialog). Escape and the backdrop close it; focus moves into
 * it on open and back to the opener on close.
 */
export function RnDrawer({
  open,
  onClose,
  title,
  subtitle,
  closeLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  closeLabel: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[110]">
      <div aria-hidden className="absolute inset-0 bg-rn-ink/35" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-[min(560px,100vw)] flex-col bg-rn-surface shadow-rn-3 outline-none"
      >
        <div className="flex items-start gap-3 border-b border-rn-line px-6 pt-5 pb-4">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-rn-20 font-bold text-rn-ink">{title}</h2>
            {subtitle ? <p className="m-0 mt-1 text-rn-13 break-words text-rn-ink-2">{subtitle}</p> : null}
          </div>
          <RnIconButton label={closeLabel} onClick={onClose}>
            <X className="size-4" aria-hidden />
          </RnIconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
