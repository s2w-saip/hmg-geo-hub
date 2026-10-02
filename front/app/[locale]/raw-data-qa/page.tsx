import { redirect, unstable_rethrow } from "next/navigation";
import { cookies } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card } from "@/components/ui/card";
import { QA_COOKIE, qaApiSource, verifyReviewerCookie } from "@/lib/qa/auth";
import { getCurrentReviewer } from "@/lib/hgh/adapters/qa";
import { describeHghError, isHghApiError } from "@/lib/hgh/errors";
import { GateForm } from "./_components/gate-form";

// 검수 게이트. 이름(평문) + 공유 비밀번호만 받는다 — 검수자는 GGMD 계정이 없다.

export default async function RawDataQaGatePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  // 이미 유효한 세션이면 목록으로. 새로고침마다 이름을 다시 치게 하지 않는다.
  // API 원천은 쿠키를 디코드만 해서 판정하지 않는다(만료·폐기 쿠키에서 게이트 ↔ 목록 루프):
  // 백엔드 확인이 200 이면 목록, 401 이면 폼. 확인 자체가 실패해도 폼은 보인다(입장 시도가
  // 자기 오류를 낸다).
  if (qaApiSource()) {
    const reviewer = await getCurrentReviewer().catch((e: unknown) => {
      unstable_rethrow(e); // cookies() in a static prerender: the gate must stay dynamic
      console.warn(isHghApiError(e) ? describeHghError(e) : "[qa] gate session check failed");
      return null;
    });
    if (reviewer) redirect(`/${locale}/raw-data-qa/answers`);
  } else {
    const jar = await cookies();
    if (verifyReviewerCookie(jar.get(QA_COOKIE)?.value)) {
      redirect(`/${locale}/raw-data-qa/answers`);
    }
  }

  const t = await getTranslations("qaReview.gate");

  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <Card className="px-8 py-10">
          <h1 className="font-head text-lg font-semibold tracking-tight text-foreground">
            {t("heading")}
          </h1>
          <p className="mt-1 text-sm text-ink-500">{t("lead")}</p>
          <GateForm locale={locale} />
          <p className="mt-6 text-xs leading-relaxed text-ink-500">{t("notice")}</p>
        </Card>
      </div>
    </main>
  );
}
