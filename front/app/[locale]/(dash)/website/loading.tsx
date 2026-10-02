import { PageSkeleton } from "@/components/dash/section-skeleton";

// Instant fallback while this route's session + data resolve (force-dynamic).
export default function Loading() {
  return <PageSkeleton variant="dashboard" />;
}
