// sonner <Toaster style={...}>: its richColors palette in the service palette (2026-11-05). sonner reads these
// custom properties from the toaster element, so the inline values win over its injected light theme. Text keeps
// 4.5:1 on its tint: the System colours' inks (globals.css), the point blue's dark step for info.
import type { CSSProperties } from "react";

const tint = (token: string, pct: number) => `color-mix(in srgb, var(${token}) ${pct}%, #ffffff)`;

export const TOASTER_STYLE = {
  "--normal-bg": "var(--color-bg)",
  "--normal-border": "var(--color-ink-100)",
  "--normal-text": "var(--color-ink-900)",
  "--success-bg": tint("--color-sentiment-positive", 12),
  "--success-border": tint("--color-sentiment-positive", 45),
  "--success-text": "var(--color-positive)",
  "--info-bg": "var(--color-brand-25)",
  "--info-border": "var(--color-brand-50)",
  "--info-text": "var(--color-brand-500)",
  "--warning-bg": tint("--color-warn", 12),
  "--warning-border": tint("--color-warn", 60),
  "--warning-text": "var(--color-warn-ink)",
  "--error-bg": tint("--color-danger", 10),
  "--error-border": tint("--color-danger", 30),
  "--error-text": "var(--color-sentiment-negative-ink)",
} as CSSProperties;
