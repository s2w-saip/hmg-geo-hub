"use client";

import DashError from "@/app/[locale]/(dash)/error";

// Error boundary of the renewal pages: the (dash) boundary as is (same copy, same retry that
// keeps the filter URL), with the page gutter the renewal shell's <main> does not have.
export default function RenewalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="px-6 py-6 xl:px-8">
      <DashError {...props} />
    </div>
  );
}
