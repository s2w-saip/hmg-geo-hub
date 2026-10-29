"use client";

import { useTranslations } from "next-intl";
import { LayoutGrid, Share2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SocialScrapingFlow } from "./social-scraping-flow";
import { ContextNodeMapView } from "./node-map/context-node-map-view";

// 커뮤니티 수집 화면의 두 시각화를 탭으로 묶는다:
//   • 테이블 뷰     — 기존 정렬 가능한 인벤토리(SocialScrapingFlow, read-only)
//   • 컨텍스트 맵 뷰 — aeorank social-scraping의 노드 그래프를 그대로 이식한 뷰
// 같은 "패밀리 SUV" 시나리오를 두 방식으로 본다. 데이터는 둘 다 목업 픽스처.
export function SocialScrapingTabs() {
  const t = useTranslations("customerInterestSocialScraping");

  return (
    <Tabs defaultValue="table" className="gap-4">
      <TabsList variant="line" className="self-start">
        <TabsTrigger value="table">
          <LayoutGrid aria-hidden />
          {t("tabs.table")}
        </TabsTrigger>
        <TabsTrigger value="nodeMap">
          <Share2 aria-hidden />
          {t("tabs.nodeMap")}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="table">
        {/* read-only on the 표준 surface — read & export only */}
        <SocialScrapingFlow mode="standard" readOnly />
      </TabsContent>

      <TabsContent value="nodeMap">
        <ContextNodeMapView />
      </TabsContent>
    </Tabs>
  );
}
