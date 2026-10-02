"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 검수 콘솔의 얇은 상단 바. (dash) 의 GNB/SNB 를 쓰지 않는 이유는 이 표면에
// 메뉴 권한 개념 자체가 없기 때문이다 — 탭은 목록/노트 둘뿐이다.
export function QaHeader({ locale, reviewerName }: { locale: string; reviewerName: string }) {
  const t = useTranslations("qaReview");
  const router = useRouter();
  const pathname = usePathname();

  const base = `/${locale}/raw-data-qa`;
  const tabs = [
    { href: `${base}/answers`, label: t("common.list") },
    { href: `${base}/notes`, label: t("common.notes") },
  ];

  async function signOut() {
    await fetch("/api/qa/session", { method: "DELETE" }).catch(() => {});
    router.replace(base);
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1600px] items-center gap-6 px-4 py-2.5">
        <span className="font-head text-sm font-semibold tracking-tight text-foreground">
          {t("title")}
        </span>
        <nav className="flex items-center gap-1">
          {tabs.map((tab) => {
            const active = pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "rounded-md px-2.5 py-1 text-sm transition-colors",
                  active
                    ? "bg-secondary text-secondary-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {t("common.signedInAs")}{" "}
            <strong className="font-medium text-foreground">{reviewerName}</strong>
          </span>
          {/* 교대 근무용 — 같은 PC 를 다음 검수자가 쓸 때 명시적으로 세션을 끊는다. */}
          <Button variant="outline" size="sm" onClick={signOut}>
            {t("common.signOut")}
          </Button>
        </div>
      </div>
    </header>
  );
}
