import { useState } from "react";
import { useLocale } from "use-intl";
import { ChevronDown, Copy, Filter, PanelLeftClose, PanelLeftOpen, Plug, Search, SlidersHorizontal } from "lucide-react";
import { RnButton, RnCard, RnCardHead, RnPageHeader, RnPill } from "@/components/renewal-ui";
import type { PageDefinition } from "./pages";
import { CONNECTED } from "~/api/client";

export function StandbyPage({ page }: { page: PageDefinition }) {
  const en = useLocale() === "en";
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const filterable = ["overview", "mention", "citation", "acr", "website-prompts", "project-prompts"].includes(page.kind);
  return <section className="rn-standby-frame" data-page-kind={page.kind}>
    <div className="rn-standby-head">
      <RnPageHeader title={page.title[en ? 1 : 0]} meta={<><span>{page.group}</span><RnPill><Plug className="size-3" />{CONNECTED ? (en ? "Awaiting source data" : "데이터 연결 대기") : (en ? "Awaiting server connection" : "서버 연결 전")}</RnPill></>} actions={<RnButton onClick={async () => { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); } catch { setCopied(false); } }}><Copy className="size-3.5" />{copied ? (en ? "Copied" : "복사됨") : (en ? "Copy link" : "링크 복사")}</RnButton>} />
    </div>
    <div className="flex min-h-0 flex-1">
      {filterable && <aside className={collapsed ? "rn-standby-filters is-collapsed" : "rn-standby-filters"} aria-label={en ? "Filters" : "필터"}>
        <button className="rn-filter-heading" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={en ? "Toggle filter panel" : "필터 패널 접기·펼치기"}>{collapsed ? <PanelLeftOpen size={17} /> : <><span className="flex items-center gap-2"><SlidersHorizontal size={15} />{en ? "Filters" : "필터"}</span><PanelLeftClose size={15} /></>}</button>
        {!collapsed && <div className="space-y-6 p-5"><div><div className="mb-2 text-rn-12 font-semibold text-rn-muted">{en ? "Saved filters" : "저장한 필터"}</div><button disabled className="rn-filter-select">{en ? "Available after sign-in" : "로그인 후 사용할 수 있습니다"}<ChevronDown size={13} /></button></div>
          {(page.group === "Project" ? [["측정 국가", "Country"], ["AI 엔진", "AI engine"], ["기간", "Period"]] : [["브랜드", "Brand"], ["국가 · 권역", "Country · region"], ["언어", "Language"], ["AI 엔진", "AI engine"], ["기간", "Period"]]).map(([ko, english]) => <div key={ko}><div className="mb-2 text-rn-12 font-semibold text-rn-ink-2">{en ? english : ko}</div><button disabled className="rn-filter-select"><span>{en ? "Awaiting options" : "옵션 연결 대기"}</span><ChevronDown size={13} /></button></div>)}
          <p className="text-rn-12 leading-relaxed text-rn-muted">{en ? "Filter options will follow your account’s permitted data scope." : "연결 후 계정의 조회 범위에 맞는 필터 옵션이 표시됩니다."}</p>
        </div>}
      </aside>}
      <div className="rn-standby-content">
        <div className="rn-connection-note" role="status"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-rn-navy/8 text-rn-navy"><Plug size={17} /></span><div><strong>{en ? "This page is ready for its server connection" : "서버 연결을 기다리고 있습니다"}</strong><p>{en ? "Measurements and account records will appear after the server is connected. No sample values are displayed." : "화면 구성을 먼저 확인할 수 있습니다. 측정값과 계정 데이터는 서버 연결 후 표시됩니다."}</p></div></div>
        {page.kind === "waiting" && <p className="text-rn-13 text-rn-muted">{en ? "This feature also needs its source data or an external account. It remains pending after server connection." : "이 기능은 원천 데이터 또는 외부 계정 준비가 필요해 서버 연결 후에도 별도 확인이 필요합니다."}</p>}
        {page.kind === "overview" && <div className="grid grid-cols-5 gap-3" aria-label={en ? "Key metric positions" : "주요 지표 자리"}>{[["AI 노출률", "AI exposure"], ["AI 언급 점유율", "Share of voice"], ["AI 우호도", "Favorability"], ["우선 노출도", "Mention position"], ["AI 인용 점유율", "Citation share"]].map(([ko, english]) => <RnCard key={ko} className="p-5"><span className="text-rn-12 font-semibold text-rn-muted">{en ? english : ko}</span><div className="mt-4 text-rn-34 font-bold text-rn-faint" aria-label={en ? "No value loaded" : "조회 전"}>—</div></RnCard>)}</div>}
        <div className="grid grid-cols-2 gap-4">{page.panels.map(([ko, english], i) => <RnCard key={ko} className={i === 0 ? "col-span-2" : ""}><RnCardHead title={en ? english : ko} /><div className="rn-empty-region"><span className="text-rn-13 text-rn-muted">{en ? "Data will appear after connection" : "연결 후 데이터가 표시됩니다"}</span></div></RnCard>)}</div>
      </div>
    </div>
  </section>;
}
