import { forwardRef } from "react";
import { useLocale } from "use-intl";
import Link, { hrefString, type LinkProps } from "./link";
export default forwardRef<HTMLAnchorElement, LinkProps>(function LocaleLink({ href, ...props }, ref) {
  const locale = useLocale();
  const value = hrefString(href);
  const localized = value.startsWith("/") && !/^\/(?:ko|en)(?:\/|$)/.test(value) && !value.startsWith("//") ? `/${locale}${value}` : value;
  return <Link {...props} href={localized} ref={ref} />;
});
