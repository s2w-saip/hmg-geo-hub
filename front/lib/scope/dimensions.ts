// Dashboard filter axes. The three slicing dimensions of the standard
// dashboard (brand · region · country).
//
// The *values* for these axes are no longer hand-stubbed here — they come from
// the canonical sources: brands + ISO countries from `lib/geo-catalog`, and the
// RHQ 권역 partition (brand × 권역 → country) from `lib/rhq`. This file now only
// declares the axis type shared by the filter UI + scope-policy.

export type FilterDimension = "brand" | "region" | "country";
