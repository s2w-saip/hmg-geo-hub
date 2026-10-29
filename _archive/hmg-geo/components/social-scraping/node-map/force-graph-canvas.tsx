/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

// Thin client-only wrapper around react-force-graph-2d.
//
// Two reasons it exists:
//  1. The library touches `window` at import time, so it must be loaded with
//     `next/dynamic({ ssr: false })`.
//  2. `next/dynamic` does not forward the special `ref` prop to the loaded
//     component, so the imperative graph API (zoomToFit, d3Force, …) is passed
//     in as a normal `fgRef` prop instead — the standard react-force-graph +
//     Next.js pattern.

import ForceGraph2D from "react-force-graph-2d";
import type { ForwardedRef } from "react";

export default function ForceGraphCanvas({
  fgRef,
  ...props
}: { fgRef?: ForwardedRef<any> } & Record<string, any>) {
  return <ForceGraph2D ref={fgRef as any} {...props} />;
}
