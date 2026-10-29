import { PageSkeleton } from "@/components/dash/section-skeleton";

// Instant fallback while this route's session + curation query resolve.
export default function Loading() {
  return <PageSkeleton variant="table" />;
}
