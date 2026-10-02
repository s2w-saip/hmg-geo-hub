import { PageSkeleton } from "@/components/dash/section-skeleton";

// Fallback for the FIRST entry into the authenticated area (the layout's own
// session + SNB work). Every (dash) route is force-dynamic, so that wait is
// unavoidable server-side; this skeleton makes it legible.
//
// It does NOT cover sibling navigation: React keeps already-revealed content
// during a transition and this segment is not re-keyed, so the boundary stays
// silent when only a leaf swaps. Each leaf route carries its own loading.tsx
// for that case.
//
// Generic "dashboard" shape on purpose — it fronts the dashboard, AI-funnel,
// answer-analysis, projects and admin trees alike. Rendered inside the layout's
// mx-auto max-w-6xl wrapper.
export default function DashLoading() {
  return <PageSkeleton variant="dashboard" />;
}
