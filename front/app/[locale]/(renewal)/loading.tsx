import { RnCard, RnSkeleton } from "@/components/renewal-ui";
import { RnFilterSplit } from "./renewal/_components/filter-split";

// First entry into the renewal shell (the layout's session work): the page frame's shape —
// header, filter panel | content — so the swap to the page does not jump.
export default function RenewalLoading() {
  return (
    <RnFilterSplit
      header={
        <div className="flex flex-col gap-2">
          <RnSkeleton className="h-8 w-64" />
          <RnSkeleton className="h-4 w-[420px] max-w-full" />
        </div>
      }
      panel={<RnCard className="h-[480px]" />}
      rail={<RnCard className="h-24" />}
    >
      <RnCard className="h-[220px]" />
      <RnCard className="h-[320px]" />
    </RnFilterSplit>
  );
}
