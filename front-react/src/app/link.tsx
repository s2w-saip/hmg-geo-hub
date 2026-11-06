import { forwardRef, type AnchorHTMLAttributes } from "react";
import { Link as RouterLink } from "react-router-dom";

type Href = string | { pathname?: string; query?: Record<string, string | number | undefined>; hash?: string };
export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: Href; prefetch?: boolean | null; scroll?: boolean; replace?: boolean; locale?: string;
}
export function hrefString(href: Href): string {
  if (typeof href === "string") return href;
  const query = new URLSearchParams(Object.entries(href.query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  return (href.pathname ?? "") + (query.size ? `?${query}` : "") + (href.hash ? `#${href.hash.replace(/^#/, "")}` : "");
}
const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, prefetch: _prefetch, scroll: _scroll, locale: _locale, replace, ...props }, ref) {
  const to = hrefString(href);
  return /^https?:|^mailto:|^tel:/.test(to)
    ? <a {...props} href={to} ref={ref} />
    : <RouterLink {...props} to={to} replace={replace} ref={ref} />;
});
export default Link;
