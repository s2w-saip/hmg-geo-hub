import type { ComponentType } from "react";
import {
  LayoutDashboard,
  MessageSquareText,
  ListChecks,
  FlaskConical,
  Eye,
  Trophy,
  TrendingUp,
  Heart,
  Globe,
  MessagesSquare,
  FolderPlus,
  Briefcase,
  Search,
  BarChart3,
  Users,
  Shield,
  FileText,
  Database,
  Building2,
  Settings,
  LayoutPanelLeft,
  MessageCircle,
  Link2,
  FolderOpen,
  Sparkles,
  Plug,
  Cpu,
  FileChartColumn,
  Coins,
  Menu,
  X,
  ArrowLeft,
} from "lucide-react";

// Original menu definitions, copied for the standalone renewal shell.
type StandardSubLeaf = {
  path: string;
  i18nKey: string; // under `nav.*`
  icon: ComponentType<{ className?: string }>;
  // beta: 라벨 뒤에 파란 (beta) 접미사를 붙인다. 실데이터가 아직 부분/실험
  // 단계인 화면(ACR·AI Conversion·Social Scraping)에 표시 — 2026-09-04 제품 결정.
  beta?: boolean;
};
export type StandardSubItem = StandardSubLeaf & { children?: StandardSubLeaf[] };

// Exported (read-only) for the renewal shell's sidebar (app/[locale]/(renewal)/_shell/rn-sidebar.tsx),
// which lists the same items in its own layout.
// Global menu (2026-10-28) = the production web's (hmg-geo.vercel.app). AI Visibility keeps its row, last under
// AI Agent Funnel, but its route is hidden for every role since 2026-10-29 (route-policy).
// The renewal pages are not rows here — the renewal sidebar opens /renewal<path> for every item (rn-sidebar.tsx);
// the customer-interest tree stays for its routes, its items are hidden for every role (route-policy).
export const STANDARD_SUB_ITEMS: StandardSubItem[] = [
  {
    path: "/dashboard",
    i18nKey: "dashboard",
    icon: LayoutDashboard,
  },
  {
    path: "/standard/prompts",
    i18nKey: "standardPrompts",
    icon: ListChecks,
  },
  {
    path: "/standard/answer-analysis",
    i18nKey: "answerAnalysis",
    icon: MessageSquareText,
    children: [
      {
        path: "/standard/answer-analysis/mention",
        i18nKey: "answerAnalysisMention",
        icon: MessageCircle,
      },
      {
        path: "/standard/answer-analysis/citation",
        i18nKey: "answerAnalysisCitation",
        icon: Link2,
      },
    ],
  },
  {
    path: "/standard/ai-funnel",
    i18nKey: "aiFunnel",
    icon: FlaskConical,
    children: [
      {
        path: "/standard/ai-funnel/acr",
        i18nKey: "aiFunnelAcr",
        icon: Trophy,
        beta: true,
      },
      {
        path: "/standard/ai-funnel/conversion",
        i18nKey: "aiFunnelConversion",
        icon: TrendingUp,
        beta: true,
      },
      {
        path: "/standard/ai-funnel/visibility",
        i18nKey: "aiFunnelVisibility",
        icon: Eye,
        beta: true,
      },
    ],
  },
  {
    path: "/customer-interest",
    i18nKey: "customerInterest",
    icon: Heart,
    children: [
      {
        path: "/customer-interest/google-keywords",
        i18nKey: "customerInterestGoogleKeywords",
        icon: Globe,
      },
      {
        path: "/customer-interest/social-scraping",
        i18nKey: "customerInterestSocialScraping",
        icon: MessagesSquare,
        beta: true,
      },
    ],
  },
];

// Admin group sub-nav tree (same shape as STANDARD_SUB_ITEMS).
export const ADMIN_SUB_ITEMS: StandardSubItem[] = [
  {
    path: "/admin",
    i18nKey: "admin",
    icon: Shield,
  },
  {
    path: "/admin/standards",
    i18nKey: "adminStandards",
    icon: FileText,
    children: [
      {
        path: "/admin/standards/prompts",
        i18nKey: "adminStandardPrompts",
        icon: FileText,
      },
      {
        path: "/admin/standards/customer-interest",
        i18nKey: "adminStandardCustomerInterest",
        icon: Database,
      },
      {
        path: "/admin/standards/entities",
        i18nKey: "adminStandardEntities",
        icon: Building2,
      },
      {
        path: "/admin/standards/citation-sources",
        i18nKey: "adminCitationSources",
        icon: Link2,
      },
    ],
  },
  {
    path: "/admin/keyword-tools",
    i18nKey: "keywordTools",
    icon: Sparkles,
  },
  {
    path: "/admin/ga4",
    i18nKey: "adminGa4",
    icon: Plug,
  },
  // production-web items without a page here yet (route-policy, 2026-10-28): "not implemented"
  {
    path: "/admin/analysis",
    i18nKey: "adminAnalysis",
    icon: Cpu,
  },
  {
    path: "/admin/reports",
    i18nKey: "adminReports",
    icon: FileChartColumn,
  },
  {
    path: "/admin/credits",
    i18nKey: "adminCredits",
    icon: Coins,
    children: [
      {
        path: "/admin/credits",
        i18nKey: "adminCreditAccounts",
        icon: Users,
      },
    ],
  },
];

// Website group sub-nav tree. Mirrors the *visible* 표준 SNB (대시보드 / 답변분석
// / AI 퍼널). 라벨은 표준과 동일하므로 기존 nav.* i18n 키를 그대로 재사용한다 —
// 단 프롬프트만 예외: 표준프롬프트가 아니라 웹사이트 전용 카탈로그라 자체 라벨
// (nav.websitePrompts)을 쓴다(route-policy 의 website 블록 참고).
export const WEBSITE_SUB_ITEMS: StandardSubItem[] = [
  {
    path: "/website",
    i18nKey: "dashboard",
    icon: LayoutDashboard,
  },
  {
    path: "/website/prompts",
    i18nKey: "websitePrompts",
    icon: ListChecks,
  },
  {
    path: "/website/answer-analysis",
    i18nKey: "answerAnalysis",
    icon: MessageSquareText,
    children: [
      {
        path: "/website/answer-analysis/mention",
        i18nKey: "answerAnalysisMention",
        icon: MessageCircle,
      },
      {
        path: "/website/answer-analysis/citation",
        i18nKey: "answerAnalysisCitation",
        icon: Link2,
      },
    ],
  },
  {
    path: "/website/ai-funnel",
    i18nKey: "aiFunnel",
    icon: FlaskConical,
    children: [
      {
        path: "/website/ai-funnel/acr",
        i18nKey: "aiFunnelAcr",
        icon: Trophy,
        beta: true,
      },
      {
        path: "/website/ai-funnel/conversion",
        i18nKey: "aiFunnelConversion",
        icon: TrendingUp,
        beta: true,
      },
    ],
  },
];

// Project sub-nav tree.
//
// `path` is the relative path under /projects/{id} — empty string = the
// bare project URL (Dashboard). Using a path (rather than a single-segment
// slug) lets children point anywhere — including outside the parent's URL
// prefix, which Setting needs: its "Member" child links to /member (not
// /setting/member) so we don't have to restructure the existing /member
// route family.
type ProjectSubLeaf = {
  path: string;
  i18nKey: string;
  icon: ComponentType<{ className?: string }>;
  beta?: boolean;
};

type ProjectSubItem = ProjectSubLeaf & {
  children?: ProjectSubLeaf[];
};

export const PROJECT_SUB_ITEMS: ProjectSubItem[] = [
  { path: "", i18nKey: "dashboard", icon: LayoutPanelLeft },
  {
    path: "intent",
    i18nKey: "intent",
    icon: Search,
    children: [
      { path: "intent/google-keyword", i18nKey: "intentGoogleKeyword", icon: Globe },
      {
        path: "intent/social-scraping",
        i18nKey: "intentSocialScraping",
        icon: MessagesSquare,
        beta: true,
      },
    ],
  },
  { path: "prompt", i18nKey: "prompt", icon: MessageSquareText },
  {
    path: "analysis",
    i18nKey: "analysis",
    icon: BarChart3,
    children: [
      { path: "analysis/mention", i18nKey: "analysisMention", icon: MessageCircle },
      { path: "analysis/citation", i18nKey: "analysisCitation", icon: Link2 },
    ],
  },
  {
    path: "ai-funnel",
    i18nKey: "aiFunnel",
    icon: FlaskConical,
    children: [
      // AI 가시성(visibility)은 mock-only라 SNB에서 숨김 (2026-06-23). ACR 도
      // 프로젝트 SNB에서 숨김 (2026-07-01) — ACR 은 표준(전사 측정)에서만 노출.
      // 두 라우트 모두 접근은 유지, 부모 ai-funnel 은 conversion 으로 리다이렉트.
      {
        path: "ai-funnel/conversion",
        i18nKey: "aiFunnelConversion",
        icon: TrendingUp,
        beta: true,
      },
    ],
  },
  {
    path: "setting",
    i18nKey: "setting",
    icon: Settings,
    children: [
      // 일반 lives at /setting (the existing Settings page — name/domain/
      // brand/tracked entities/Danger Zone). 멤버 lives at /member (the
      // existing Members page). Both stay at their current URLs; the SNB
      // just visually groups them under Setting.
      { path: "setting", i18nKey: "general", icon: Settings },
      { path: "member", i18nKey: "member", icon: Users },
    ],
  },
];
