import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rn-navy";

const VARIANT = {
  primary: "border-rn-navy bg-rn-navy text-rn-on-dark hover:bg-rn-navy-900",
  secondary: "border-rn-line bg-rn-surface text-rn-ink-2 shadow-[0_1px_2px_rgba(16,16,18,0.05)] hover:bg-rn-page",
  ghost: "border-transparent bg-transparent text-rn-muted hover:bg-rn-track hover:text-rn-ink",
} as const;

const SIZE = {
  md: "h-[38px] px-3.5 text-rn-13",
  sm: "h-[30px] px-2.5 text-rn-12",
} as const;

export type RnButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
};

export function RnButton({ variant = "secondary", size = "md", className, type = "button", ...rest }: RnButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-[10px] border font-[550] whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        FOCUS,
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    />
  );
}

/** Icon-only button. `label` is required: it is the accessible name and the hover title. */
export function RnIconButton({
  label,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "relative inline-grid size-8 shrink-0 cursor-pointer place-items-center rounded-[9px] text-rn-muted transition-colors hover:bg-rn-track hover:text-rn-ink disabled:cursor-default disabled:opacity-35",
        FOCUS,
        className,
      )}
      {...rest}
    />
  );
}

/** Link-styled action (navy, underline on hover). */
export function RnTextButton({ className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cx(
        "cursor-pointer text-rn-12 font-semibold text-rn-navy underline-offset-3 hover:underline aria-disabled:cursor-default aria-disabled:text-rn-muted aria-disabled:no-underline",
        FOCUS,
        className,
      )}
      {...rest}
    />
  );
}
