import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PageSkeleton, type PageSkeletonVariant } from "./section-skeleton";

// Every (dash) leaf route's loading.tsx renders this, so a throw here would take
// down the fallback for the whole authenticated area — and a broken fallback is
// invisible in a normal build (it only renders while data is in flight).

const VARIANTS: PageSkeletonVariant[] = ["dashboard", "analysis", "funnel", "table"];

describe("PageSkeleton", () => {
  it.each(VARIANTS)("renders the %s variant", (variant) => {
    const html = renderToStaticMarkup(<PageSkeleton variant={variant} />);
    // Decorative + announced as busy — a screen reader must not read the
    // placeholder blocks as content.
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
  });

  it.each(VARIANTS)("shows a moving loading bar on the %s variant", (variant) => {
    // The bar is the only thing that says "loading" rather than "empty" — the
    // whole point of the fix. Every variant must carry it.
    expect(renderToStaticMarkup(<PageSkeleton variant={variant} />)).toContain(
      "animate-loading-bar",
    );
  });

  it.each(VARIANTS)("fills %s placeholders with a tone, not bg-card", (variant) => {
    const html = renderToStaticMarkup(<PageSkeleton variant={variant} />);
    // Regression guard: bg-card is white and the page surface is near-white, so
    // bg-card placeholders rendered as empty bordered boxes ("빈칸") instead of
    // reading as a loading page.
    expect(html).not.toContain("bg-card");
    expect(html).toContain("bg-ink-100");
    expect(html).toContain("animate-shimmer");
  });

  it("defaults to the table variant when no variant is given", () => {
    expect(renderToStaticMarkup(<PageSkeleton />)).toBe(
      renderToStaticMarkup(<PageSkeleton variant="table" />),
    );
  });

  it("gives each variant a distinct shape", () => {
    const shapes = VARIANTS.map((v) => renderToStaticMarkup(<PageSkeleton variant={v} />));
    expect(new Set(shapes).size).toBe(VARIANTS.length);
  });

  it("carries no hardcoded hex — tokens only (visual-identity boundary)", () => {
    const html = VARIANTS.map((v) => renderToStaticMarkup(<PageSkeleton variant={v} />)).join("");
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}/);
  });
});
