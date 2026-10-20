import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rn-navy";

const VARIANT = {
  primary: "border-rn-navy bg-rn-navy text-white hover:bg-rn-navy-900",
  secondary: "border-rn-line-2 bg-rn-surface text-rn-ink hover:border-rn-faint",
  ghost: "border-transparent bg-transparent text-rn-muted hover:bg-rn-inset hover:text-rn-ink",
} as const;

const SIZE = {
  md: "h-9 px-3 text-rn-13",
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
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-rn-control border font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
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
        "relative inline-grid size-[30px] shrink-0 cursor-pointer place-items-center rounded-md text-rn-muted transition-colors hover:bg-rn-inset hover:text-rn-ink disabled:cursor-default disabled:opacity-35",
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
