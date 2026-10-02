import Image from "next/image";

// Brand wordmark shown in the dashboard header (and any future entry point).
// Asset comes from HMG corporate brand kit. Replacing the SVG file at
// public/brand/hmg-logo.svg swaps the mark everywhere — no component change.
//
// We use next/image with unoptimized=true because Next.js's image pipeline
// rasterizes SVGs by default; we want the vector preserved.
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
  // Intrinsic dimensions match each SVG's viewBox (HMG group lockup is a wide
  // two-line wordmark, the Hyundai mark is the near-square H + wordmark), so
  // Next reserves the right aspect ratio. The CSS class controls actual size.
  const { width, height } = isHmg
    ? { width: 228, height: 72 }
    : { width: 335, height: 203 };
  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      priority
      unoptimized
    />
  );
}
