"use client";

import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

// 내보내기 버튼 — **평범한 링크**다(제품 결정 2026-09-16: GET + ?locale=).
//
// 왜 링크인가: 이 화면은 서버 페이징이라 클라이언트에 50행뿐이고, 내보내기는
// 서버가 같은 필터로 다시 질의해야 한다(/api/website/prompts/export). 현재 URL 의
// 검색 파라미터를 **그대로** 실어 보내면 화면과 같은 술어가 보장된다 — 여기서
// 필터를 재조립하면 그 순간 화면과 갈릴 수 있는 자리가 생긴다.
//
// `page` 만 뺀다: 내보내기는 정의상 전량이라 페이지 번호가 의미 없고, 남겨두면
// "3페이지를 보고 있었으니 3페이지만 받나?"라는 오해를 만든다.
export function WebsitePromptExportButton({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations("website.prompts");
  const locale = useLocale();
  const sp = useSearchParams();

  const params = new URLSearchParams(sp.toString());
  params.delete("page");
  // 커서(API 원천, 결정 D5)도 뺀다: 페이지 위치일 뿐 술어가 아니다.
  params.delete("cursor");
  params.set("locale", locale);

  const href = `/api/website/prompts/export?${params.toString()}`;

  if (disabled) {
    return (
      <Button type="button" variant="outline" size="sm" className="h-8" disabled>
        <Download className="h-3.5 w-3.5" aria-hidden />
        {t("exportLabel")}
      </Button>
    );
  }

  return (
    <Button asChild variant="outline" size="sm" className="h-8">
      {/* 다운로드 응답이라 라우터 전환이 아니다 — next/link 가 아닌 <a>.
          `download` 속성은 **일부러 안 붙인다**: 그 속성이 있으면 브라우저가
          응답을 내용과 무관하게 파일로 저장해, 라우트가 401/403/500 으로 낸
          에러 JSON 까지 `.xlsx` 인 양 디스크에 떨어진다(사용자에겐 "열리지 않는
          파일"로만 보인다). 성공 응답에는 서버가 `Content-Disposition:
          attachment` 를 붙이므로 저장은 그대로 되고, 에러 응답에는 그 헤더가
          없어 브라우저가 내용을 보여준다 — 실패가 보이는 쪽으로 갈린다. */}
      <a href={href}>
        <Download className="h-3.5 w-3.5" aria-hidden />
        {t("exportLabel")}
      </a>
    </Button>
  );
}
