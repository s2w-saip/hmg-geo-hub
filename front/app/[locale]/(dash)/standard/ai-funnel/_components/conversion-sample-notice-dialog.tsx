"use client";

import { useTranslations } from "next-intl";
import {
  NoticeDialogFrame,
  usePageNotice,
} from "@/components/dash/notice-dialog";

// 표준 > AI Agent Funnel > Conversion 진입 안내 팝업.
// 메인 첫 접속 팝업과 같은 템플릿(notice-dialog.tsx). **조건 없이** 이 페이지에
// 들어올 때마다 뜬다(세션 1회·"오늘 다시 보지 않기" 없음, 2026-09-29 요청).
// 메인 팝업이 떠 있으면 닫힌 뒤에 이어서 뜬다. 마운트 위치는 conversion/layout.tsx.
// GA4 가 연동된 시장이 Kia Italy 하나라 이 화면은 그 데이터를 샘플로 보여준다
// (lib/ga4/property-map.ts MAP).
export function ConversionSampleNoticeDialog() {
  const t = useTranslations("aiFunnelConversion.sampleNotice");
  const { open, onOpenChange, close } = usePageNotice();

  return (
    <NoticeDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onClose={close}
      title={t("title")}
    >
      <p>
        {t("line1")}
        <br />
        {t("line2")}
      </p>
    </NoticeDialogFrame>
  );
}
