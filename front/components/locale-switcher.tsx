"use client";

import { useLocale, useTranslations } from "next-intl";
import { Check, Languages } from "lucide-react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Header locale switcher. Replaces the native <select> with a shadcn
// DropdownMenu so it matches the rest of the header chrome (consistent
// hover/active/keyboard behaviour, supports right-side alignment).
export function LocaleSwitcher() {
  const current = useLocale();
  const t = useTranslations("locale");
  const pathname = usePathname();
  const router = useRouter();

  function select(locale: (typeof routing.locales)[number]) {
    router.replace(pathname, { locale });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("label")}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <Languages className="h-4 w-4" aria-hidden />
          <span>{t(current)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {routing.locales.map((l) => (
          <DropdownMenuItem
            key={l}
            onSelect={() => select(l)}
            className="gap-2"
          >
            <Check
              className={
                l === current
                  ? "h-3.5 w-3.5 opacity-100"
                  : "h-3.5 w-3.5 opacity-0"
              }
              aria-hidden
            />
            <span>{t(l)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
