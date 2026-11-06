import { lazy, Suspense, type ComponentProps } from "react";
const GeoMap = lazy(() => import("./geo-map").then(m => ({ default: m.GeoMap })));
export function GeoMapLazy(props: ComponentProps<typeof GeoMap>) {
  return <Suspense fallback={<div aria-hidden className="aspect-[720/400] animate-pulse rounded bg-bg-soft" />}><GeoMap {...props} /></Suspense>;
}
