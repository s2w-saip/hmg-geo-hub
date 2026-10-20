"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type ToastOptions = { undo?: () => void; undoLabel?: string };
type Toast = { id: number; message: string } & ToastOptions;
type Show = (message: string, options?: ToastOptions) => void;

const ToastContext = createContext<Show>(() => {});

/** Bottom-centre status toast with an optional undo action (auto-hides after 5 s). */
export function RnToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const show = useCallback<Show>((message, options) => {
    if (timer.current) clearTimeout(timer.current);
    seq.current += 1;
    setToast({ id: seq.current, message, ...options });
    timer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-[120] flex justify-center px-4">
        {toast ? (
          <div key={toast.id} role="status" className="pointer-events-auto flex items-center gap-3.5 rounded-[10px] bg-rn-ink py-2.5 pr-2.5 pl-4 text-rn-13 text-white shadow-rn-3">
            <span>{toast.message}</span>
            {toast.undo ? (
              <button
                type="button"
                data-rn-undo=""
                onClick={() => {
                  const undo = toast.undo;
                  setToast(null);
                  undo?.();
                }}
                className="cursor-pointer rounded-md px-2 py-1 font-bold text-rn-sky hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-rn-sky"
              >
                {toast.undoLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useRnToast(): Show {
  return useContext(ToastContext);
}
