// Brand wordmark shown on the login cards (and any future entry point).
// Asset comes from HMG corporate brand kit. Replacing the SVG file at
// public/brand/hmg-logo.svg swaps the mark everywhere — no component change.
export function Wordmark({
  variant = "hmg",
  className = "h-6 w-auto",
}: {
  variant?: "hmg" | "hyundai";
  className?: string;
}) {
  const isHmg = variant === "hmg";
  const src = isHmg ? "/brand/hmg-logo.svg" : "/brand/hyundai-logo.svg";
  const alt = isHmg ? "Hyundai Motor Group" : "Hyundai";
  // Intrinsic dimensions match each SVG's viewBox, so the browser reserves the right aspect ratio. The CSS class controls actual size.
  const { width, height } = isHmg ? { width: 228, height: 72 } : { width: 335, height: 203 };
  return <img src={src} alt={alt} width={width} height={height} className={className} />;
}
