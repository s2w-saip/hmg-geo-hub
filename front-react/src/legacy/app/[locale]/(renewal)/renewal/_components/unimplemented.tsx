import { RnPageHeader, RnTag } from "@/components/renewal-ui";
import { RnPageFrame } from "./filter-split";

/** The "not implemented" page of a renewal menu item without its page yet (2026-10-28): the title, and a body that says
 * so (the `unimplemented` messages) — the renewal shell never sends a viewer to the original screens. */
export function RnUnimplementedPage({ title, label, body }: { title: string; label: string; body: string }) {
  return (
    <RnPageFrame header={<RnPageHeader title={title} />}>
      <div
        data-rn-unimplemented=""
        className="grid min-h-[min(60dvh,520px)] place-items-center rounded-2xl border border-dashed border-rn-line-2 bg-rn-surface p-8 text-center"
      >
        <div className="flex flex-col items-center gap-2.5">
          <RnTag className="px-2 py-0.5 text-rn-12">{label}</RnTag>
          <p className="m-0 text-rn-15 font-semibold text-rn-ink-2">{body}</p>
        </div>
      </div>
    </RnPageFrame>
  );
}
