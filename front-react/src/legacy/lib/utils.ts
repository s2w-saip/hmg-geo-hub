import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// `cn` is the shadcn/ui convention for class merging:
//   - clsx handles conditional/array/object class inputs and false/null filtering
//   - twMerge resolves Tailwind conflicts so callers can append overriding
//     classes (e.g. `cn("px-4", "px-6")` collapses to `px-6`)
// All components in components/ui/* assume this helper exists at @/lib/utils.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
