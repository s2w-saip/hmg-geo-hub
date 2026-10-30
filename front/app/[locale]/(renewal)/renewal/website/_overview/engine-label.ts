import { ENGINE_LABEL } from "@/components/dash/engine-label";

// An engine's display name for the Website Overview. Not a "use client" module: the page (a server component) names
// the 핵심 요약 engine rows with it (website-findings.ts), and website-format.tsx re-exports it for the sections.
export const engineLabel = (code: string) => ENGINE_LABEL[code] ?? code;
