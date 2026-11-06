export type PageKind = "overview" | "mention" | "citation" | "citation-prompts" | "citation-tone" | "acr" | "prompts" | "website-prompts" | "projects" | "project-prompts" | "project-setting" | "member" | "accounts" | "hub-prompts" | "sources" | "interest" | "entities" | "ga4" | "waiting" | "reserved";
export type Surface = "global" | "website" | "project";
export interface PageDefinition {
  path: string; title: [string, string]; group: "Global" | "Website" | "Project" | "Admin";
  kind: PageKind; panels: [string, string][];
}
const overviewPanels: [string, string][] = [["주요 지표", "Key metrics"], ["브랜드 비교", "Brand comparison"], ["시장별 현황", "Markets"]];
const mentionPanels: [string, string][] = [["지표 추이", "Metric trends"], ["엔진별 현황", "AI engines"], ["브랜드 비교", "Brand comparison"]];
const citationPanels: [string, string][] = [["인용 지표", "Citation metrics"], ["출처별 현황", "Citation sources"], ["도메인별 추이", "Domain trends"]];
export const PAGES: PageDefinition[] = [
  { path: "dashboard", title: ["Overview", "Overview"], group: "Global", kind: "overview", panels: overviewPanels },
  { path: "standard/prompts", title: ["프롬프트", "Prompts"], group: "Global", kind: "prompts", panels: [["프롬프트 목록", "Prompt catalog"], ["변경 이력", "History"]] },
  { path: "standard/answer-analysis/mention", title: ["언급 분석", "Mention analysis"], group: "Global", kind: "mention", panels: mentionPanels },
  { path: "standard/answer-analysis/citation", title: ["인용 분석", "Citation analysis"], group: "Global", kind: "citation", panels: citationPanels },
  { path: "standard/answer-analysis/citation/prompts", title: ["인용 프롬프트", "Citation prompts"], group: "Global", kind: "citation-prompts", panels: [["프롬프트 목록", "Prompt list"]] },
  { path: "standard/answer-analysis/citation/tone-urls", title: ["감정별 인용 URL", "Citation URLs by tone"], group: "Global", kind: "citation-tone", panels: [["인용 URL 목록", "Citation URLs"]] },
  { path: "standard/ai-funnel/acr", title: ["AI 추천 전환율", "AI recommendation conversion"], group: "Global", kind: "acr", panels: [["추천 결과", "Recommendations"], ["엔진별 비교", "AI engine comparison"], ["맞대결 결과", "Head-to-head results"]] },
  { path: "standard/ai-funnel/conversion", title: ["AI 전환", "AI conversion"], group: "Global", kind: "waiting", panels: [["GA4 결과", "GA4 results"]] },
  { path: "standard/ai-funnel/visibility", title: ["AI 가시성", "AI visibility"], group: "Global", kind: "waiting", panels: [["가시성 현황", "Visibility"]] },
  { path: "website", title: ["Overview", "Overview"], group: "Website", kind: "overview", panels: overviewPanels },
  { path: "website/prompts", title: ["프롬프트", "Prompts"], group: "Website", kind: "website-prompts", panels: [["프롬프트 목록", "Prompt list"], ["측정 현황", "Measurements"]] },
  { path: "website/answer-analysis/mention", title: ["언급 분석", "Mention analysis"], group: "Website", kind: "mention", panels: mentionPanels },
  { path: "website/answer-analysis/citation", title: ["인용 분석", "Citation analysis"], group: "Website", kind: "citation", panels: citationPanels },
  { path: "website/answer-analysis/citation/prompts", title: ["인용 프롬프트", "Citation prompts"], group: "Website", kind: "citation-prompts", panels: [["프롬프트 목록", "Prompt list"]] },
  { path: "website/answer-analysis/citation/tone-urls", title: ["감정별 인용 URL", "Citation URLs by tone"], group: "Website", kind: "citation-tone", panels: [["인용 URL 목록", "Citation URLs"]] },
  { path: "website/ai-funnel/conversion", title: ["AI 전환", "AI conversion"], group: "Website", kind: "waiting", panels: [["GA4 결과", "GA4 results"]] },
  { path: "projects", title: ["프로젝트", "Projects"], group: "Project", kind: "projects", panels: [["프로젝트 목록", "Project list"]] },
  { path: "projects/:id", title: ["Dashboard", "Dashboard"], group: "Project", kind: "overview", panels: overviewPanels },
  { path: "projects/:id/analysis/mention", title: ["언급 분석", "Mention analysis"], group: "Project", kind: "mention", panels: mentionPanels },
  { path: "projects/:id/analysis/citation", title: ["인용 분석", "Citation analysis"], group: "Project", kind: "citation", panels: citationPanels },
  { path: "projects/:id/analysis/citation/prompts", title: ["인용 프롬프트", "Citation prompts"], group: "Project", kind: "citation-prompts", panels: [["프롬프트 목록", "Prompt list"]] },
  { path: "projects/:id/analysis/citation/tone-urls", title: ["감정별 인용 URL", "Citation URLs by tone"], group: "Project", kind: "citation-tone", panels: [["인용 URL 목록", "Citation URLs"]] },
  { path: "projects/:id/prompt", title: ["프롬프트", "Prompts"], group: "Project", kind: "project-prompts", panels: [["프롬프트 목록", "Prompt list"], ["커스텀 태그", "Custom tags"]] },
  { path: "projects/:id/setting", title: ["프로젝트 설정", "Project settings"], group: "Project", kind: "project-setting", panels: [["측정 설정", "Measurement settings"], ["프로젝트 정보", "Project information"]] },
  { path: "projects/:id/member", title: ["멤버", "Members"], group: "Project", kind: "member", panels: [["멤버 목록", "Members"]] },
  { path: "projects/:id/intent/google-keyword", title: ["키워드", "Keywords"], group: "Project", kind: "waiting", panels: [["검색 키워드", "Search keywords"]] },
  { path: "projects/:id/intent/social-scraping", title: ["소셜 분석", "Social analysis"], group: "Project", kind: "waiting", panels: [["소셜 맥락", "Social context"]] },
  { path: "projects/:id/ai-funnel/conversion", title: ["AI 전환", "AI conversion"], group: "Project", kind: "waiting", panels: [["GA4 결과", "GA4 results"]] },
  { path: "admin", title: ["사용자 관리", "User accounts"], group: "Admin", kind: "accounts", panels: [["계정 목록", "Accounts"]] },
  { path: "admin/standards/prompts", title: ["Global 프롬프트 관리", "Global prompt management"], group: "Admin", kind: "hub-prompts", panels: [["프롬프트 목록", "Prompt list"]] },
  { path: "admin/standards/citation-sources", title: ["인용 출처 분류", "Citation source classification"], group: "Admin", kind: "sources", panels: [["교정 · 시드 · 공식 소셜 · 코드표", "Overrides · seeds · social · codes"]] },
  { path: "admin/standards/customer-interest", title: ["고객 관심 데이터", "Customer interest data"], group: "Admin", kind: "interest", panels: [["시드 키워드 · 커뮤니티 소스", "Seed keywords · community sources"]] },
  { path: "admin/standards/entities", title: ["엔티티 카탈로그", "Entity catalog"], group: "Admin", kind: "entities", panels: [["엔티티 역할", "Entity roles"]] },
  { path: "admin/ga4", title: ["GA4 속성 등록", "GA4 property registry"], group: "Admin", kind: "ga4", panels: [["등록 속성", "Registered properties"]] },
  { path: "admin/keyword-tools", title: ["키워드 도구", "Keyword tools"], group: "Admin", kind: "waiting", panels: [["외부 도구 연결", "External tools"]] },
];
export function surfaceOf(page: PageDefinition): Surface { return page.group === "Website" ? "website" : page.path.startsWith("projects/:id") ? "project" : "global"; }
