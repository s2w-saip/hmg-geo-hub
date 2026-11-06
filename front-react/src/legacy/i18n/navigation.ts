export { default as Link } from "~/app/locale-link";
export { redirect } from "~/app/navigation";
import { useLocale } from "use-intl";
import { useMemo } from "react";
import { usePathname as useFullPathname, useRouter as useAppRouter } from "~/app/navigation";
export function usePathname() { return useFullPathname().replace(/^\/(ko|en)(?=\/|$)/, "") || "/"; }
export function useRouter() {
  const router = useAppRouter();
  const current = useLocale();
  return useMemo(() => {
    const local = (href: string, locale = current) => href.startsWith("/") && !href.startsWith("//") ? `/${locale}${href.replace(/^\/(ko|en)(?=\/|$)/, "")}` : href;
    return { ...router,
      push: (href: string, options?: { locale?: string; scroll?: boolean }) => router.push(local(href, options?.locale), options),
      replace: (href: string, options?: { locale?: string; scroll?: boolean }) => router.replace(local(href, options?.locale), options),
    };
  }, [router, current]);
}
