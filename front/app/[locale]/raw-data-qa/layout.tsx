import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { qaApiSource, qaEnabled, requireReviewer, QaUnauthorizedError } from "@/lib/qa/auth";
import { getCurrentReviewer } from "@/lib/hgh/adapters/qa";
import { QaHeader } from "./_components/qa-header";

// Raw Data QA Console 의 셸. `(dash)` 그룹 **밖**이라 GNB/SNB 도, route-policy 가드도
// 없다 — 이 콘솔은 role 이 없는 표면이기 때문이다(설계 §3~§4).
//
// 인증 판정을 여기 한 곳에 모은다: 하위 페이지들이 매번 requireReviewer 를 부르고
// 리다이렉트를 반복하면, 한 곳만 빠뜨려도 조용히 열려버린다.
//
// HGH_SOURCE_G7=api 면 로컬 HMAC 검증 대신 백엔드 GET /v1/qa/sessions/current(부작용 없음)로
// 판정한다: 401(만료·로그아웃·폐기) → 게이트. 킬 스위치 RAW_DATA_QA_ENABLED 는 두 원천 공통.

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function RawDataQaLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  // 킬 스위치. 401 이 아니라 404 여야 "여기 뭔가 있다"를 알려주지 않는다.
  if (!qaEnabled()) notFound();

  const { locale } = await params;
  setRequestLocale(locale);

  // 게이트 자신은 인증 없이 열려야 한다. 미들웨어가 심어 둔 x-pathname 으로 판정한다.
  const pathname = (await headers()).get("x-pathname") ?? "";
  const isGate = /\/raw-data-qa\/?$/.test(pathname);

  let reviewerName: string | null = null;
  if (!isGate && qaApiSource()) {
    const reviewer = await getCurrentReviewer();
    if (!reviewer) redirect(`/${locale}/raw-data-qa`);
    reviewerName = reviewer.name;
  } else if (!isGate) {
    try {
      reviewerName = (await requireReviewer()).name;
    } catch (err) {
      if (err instanceof QaUnauthorizedError) redirect(`/${locale}/raw-data-qa`);
      throw err;
    }
  }

  return (
    <div className="min-h-dvh bg-bg-soft">
      {reviewerName ? <QaHeader locale={locale} reviewerName={reviewerName} /> : null}
      {children}
    </div>
  );
}
