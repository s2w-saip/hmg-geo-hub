import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        // 2026-06-04 contrast pass — `bg-background` matches the page bg on
        // light theme, so outline lost its surface. Default to bg-card with
        // explicit border-border so the button is visible against any
        // toolbar/filter row.
        outline:
          "border border-border bg-card shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        // ghost stays intentionally minimal (used for icon-only triggers in
        // tables, close X, etc. where context conveys clickability). Hover
        // tint is the only resting affordance.
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  pending = false,
  icon,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /**
     * Waiting on an async action. Disables the button, marks it `aria-busy`,
     * and swaps `icon` for a spinner — so a click always produces immediate
     * visible feedback instead of a dead-looking button. Prefer this over
     * hand-rolling `{pending ? <Loader2/> : <X/>}` at each call site.
     */
    pending?: boolean
    /**
     * Leading icon slot. Rendered as a direct child (keeping the `has-[>svg]`
     * padding rules intact) and replaced by the spinner while `pending`.
     * Icon-only buttons pass `icon` with no children.
     */
    icon?: React.ReactNode
  }) {
  const Comp = asChild ? Slot.Root : "button"

  // asChild delegates rendering to the caller's child element; injecting a
  // spinner would break Slot's single-child contract, so under asChild
  // `pending` only contributes state (disabled/aria-busy), not content.
  const content = asChild ? (
    children
  ) : (
    <>
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : icon}
      {children}
    </>
  )

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-pending={pending ? "" : undefined}
      aria-busy={pending || undefined}
      // `|| undefined` so an unset disabled stays absent rather than becoming
      // `disabled={false}` — under asChild that would forward a non-boolean
      // attribute onto e.g. a Link and trip a React warning.
      disabled={disabled || pending || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {content}
    </Comp>
  )
}

export { Button, buttonVariants }
