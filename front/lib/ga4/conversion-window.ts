// Neutral module (NO "server-only") — the conversion measurement-window
// constants are shared by the server fetch layer (lib/ga4/conversion.ts) and the
// client period selector (ConversionPeriodSelect). They can't live in
// conversion.ts because that module is server-only (importing it into a client
// component breaks the build).
export const CONVERSION_PERIODS = [7, 28, 90] as const;
export const DEFAULT_CONVERSION_DAYS = 90;
