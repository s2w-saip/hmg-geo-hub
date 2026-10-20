import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cx } from "./cx";

/** Native select styled for the renewal pages (keyboard and screen readers for free). */
export function RnSelect({
  label,
  options,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: ReadonlyArray<{ value: string; label: string }> }) {
  return (
    <span className={cx("relative inline-flex items-center", className)}>
      <select
        aria-label={label}
        className="h-[30px] cursor-pointer appearance-none rounded-md border border-rn-line-2 bg-rn-surface pr-7 pl-2.5 text-rn-12 font-semibold text-rn-ink outline-none focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12"
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2 size-3.5 text-rn-muted" />
    </span>
  );
}
