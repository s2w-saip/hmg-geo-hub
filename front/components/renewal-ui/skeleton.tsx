import { cx } from "./cx";

/** Placeholder block that keeps the final size while data streams in. */
export function RnSkeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("block animate-pulse rounded-md bg-rn-inset", className)} />;
}
