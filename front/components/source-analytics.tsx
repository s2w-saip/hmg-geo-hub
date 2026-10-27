import { PageHeader } from "@/components/page-header";
import { screenGet } from "@/lib/screen";
import { SourceLink, SourceMetrics, SourceNotice, SourceTable, type SearchValues, type SourceRow } from "@/components/source-data-ui";

/** The screen envelope's meta (sources/analytics). */
type SourceMeta = { page?: { total?: number; next_cursor?: string | null }; source?: string | object; available?: boolean; reason?: string | null };

type Analytics = {
  metrics: Record<string, number | null>;
  period: { from: string | null; to: string | null; days: number | null };
  properties: SourceRow[]; pages: SourceRow[]; trend: SourceRow[]; engines: SourceRow[]; countries: SourceRow[];
  events: SourceRow[]; windows: SourceRow[]; devices: SourceRow[]; bots: SourceRow[]; priorities: SourceRow[];
};

export async function SourceAnalytics({ kind, sp = {}, projectId }: { kind: "conversion" | "visibility"; sp?: SearchValues; projectId?: string }) {
  const { data, meta } = await screenGet<{ data: Analytics; meta: SourceMeta }>("sources/analytics", { ...sp, "ctx.kind": kind, "ctx.project_id": projectId });
  const conversion = kind === "conversion";
  const labels: [string, string, boolean?][] = conversion ? [
    ["ai_sessions", "AI 유입 세션"], ["ai_users", "AI 유입 사용자"], ["ai_conversions", "AI 전환 수"], ["ai_conversion_rate", "AI 전환율", true],
    ["human_sessions", "일반 유입 세션"], ["human_users", "일반 유입 사용자"], ["human_conversions", "일반 전환 수"], ["human_conversion_rate", "일반 전환율", true],
    ["session_share", "AI 세션 비중", true], ["page_views", "페이지 조회 수"],
  ] : [["seo_impressions", "SEO 노출 수"], ["ai_crawls", "AI 크롤링 수"], ["pages", "측정 페이지"], ["both", "SEO·크롤링 모두 높음"],
    ["seo_only", "SEO 노출 높음"], ["crawl_only", "AI 크롤링 높음"], ["neither", "SEO·크롤링 모두 낮음"]];
  return <div className="flex min-w-0 flex-col gap-6">
    <PageHeader title={conversion ? "AI 유입 · 전환" : "SEO · AI 크롤링"} description={conversion ? "GA4에서 측정한 유입과 전환 현황" : "페이지별 검색 노출과 AI 크롤링 현황"} />
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
      {Object.entries(sp).filter(([k])=>!["from","to","days","period"].includes(k)).map(([k,v])=>(Array.isArray(v)?v:[v]).filter(v=>v!==undefined).map((v,i)=><input key={`${k}-${i}`} type="hidden" name={k} value={v}/>))}
      <label className="text-sm">시작일<input className="mt-1 block rounded-md border bg-background px-3 py-2" type="date" name="from" defaultValue={String(sp.from ?? "")} /></label>
      <label className="text-sm">종료일<input className="mt-1 block rounded-md border bg-background px-3 py-2" type="date" name="to" defaultValue={String(sp.to ?? "")} /></label>
      <label className="text-sm">기간<select name="days" defaultValue={String(sp.days ?? "28")} className="mt-1 block rounded-md border bg-background px-3 py-2">{[7,28,90].map(d => <option key={d} value={d}>{d}일</option>)}</select></label>
      <button className="rounded-md bg-brand-700 px-4 py-2 text-sm text-white" type="submit">조회</button>
    </form>
    {data.period.from && data.period.to && <p className="text-sm text-muted-foreground">조회 기간: {data.period.from} ~ {data.period.to}</p>}
    {meta.reason && <SourceNotice>{meta.reason === "source_unavailable" ? "DB 연결 상태를 확인할 수 없습니다. 지표를 불러오지 못했습니다." : "데이터 없음 · 아직 이 범위의 측정 데이터가 없습니다."}</SourceNotice>}
    <SourceMetrics items={labels.map(([key, label, percent]) => ({ label, value: data.metrics[key], percent }))} />
    {conversion ? <>
      <p className="text-xs text-muted-foreground">사용자 수는 선택 기간의 중복 제거 측정값입니다. 여러 속성을 선택하면 속성별 사용자 수를 합산합니다. 해당 기간·필터의 측정값이 없으면 데이터 없음으로 표시합니다.</p>
      <SourceTable title="일별 추이" rows={data.trend} columns={[{key:"date",label:"일자"},{key:"ai_sessions",label:"AI 세션"},{key:"ai_users",label:"AI 사용자"},{key:"ai_conversions",label:"AI 전환"}]} />
      <SourceTable title="AI 엔진별 현황" rows={data.engines} columns={[{key:"engine",label:"엔진"},{key:"sessions",label:"세션"},{key:"conversions",label:"전환"}]} />
      <SourceTable title="페이지별 유입" rows={data.pages} columns={[{key:"url",label:"페이지",render:r=><SourceLink value={r.url}/>},{key:"sessions",label:"AI 세션"},{key:"page_views",label:"페이지 조회"}]} />
      <SourceTable title="국가·속성별 현황" rows={data.countries} columns={[{key:"country",label:"국가"},{key:"brand",label:"브랜드"},{key:"property_id",label:"GA4 속성"},{key:"ai_sessions",label:"AI 세션"},{key:"ai_users",label:"AI 사용자"}]} />
      <SourceTable title="이벤트" rows={data.events} columns={[{key:"event",label:"이벤트"},{key:"count",label:"발생 수"},{key:"tracked",label:"전환 이벤트"}]} />
      <details className="rounded-xl border bg-card p-4"><summary className="cursor-pointer font-medium">기간 사용자 측정값</summary><div className="mt-4"><SourceTable title="중복 제거 사용자" rows={data.windows} columns={[{key:"window_end",label:"종료일"},{key:"window_days",label:"기간(일)"},{key:"prop_key",label:"속성 식별자"},{key:"cohort",label:"유입 그룹"},{key:"page",label:"페이지"},{key:"users",label:"사용자"},{key:"filter",label:"필터",render:r=>r.filter_all?"전체":"필터 정의 데이터 없음"}]} /></div></details>
      <SourceTable title="GA4 연결 속성" rows={data.properties} columns={[{key:"property_id",label:"GA4 속성"},{key:"country",label:"국가"},{key:"status",label:"상태"},{key:"conv_basis",label:"전환 집계 기준",render:r=>r.conv_basis===1?"주요 이벤트":r.conv_basis===2?"지정 전환 이벤트":"데이터 없음"}]} />
    </> : <>
      <p className="text-xs text-muted-foreground">게시된 측정 결과를 사용합니다. 높음·낮음은 선택한 페이지의 기간 합계 중앙값을 기준으로 구분합니다.</p>
      <SourceTable title="일별 추이" rows={data.trend} columns={[{key:"date",label:"일자"},{key:"seo_impressions",label:"SEO 노출"},{key:"ai_crawls",label:"AI 크롤링"}]} />
      <SourceTable title="페이지별 현황" rows={data.pages} columns={[{key:"url",label:"페이지",render:r=><SourceLink value={r.url}>{r.title ? String(r.title) : undefined}</SourceLink>},{key:"country",label:"국가"},{key:"seo_impressions",label:"SEO 노출"},{key:"ai_crawls",label:"AI 크롤링"},{key:"quadrant",label:"분류",render:r=>({both:"모두 높음",seo_only:"SEO 높음",crawl_only:"크롤링 높음",neither:"모두 낮음"}[String(r.quadrant)]??"데이터 없음")}]} />
      <SourceTable title="기기별 SEO 노출" rows={data.devices} columns={[{key:"date",label:"일자"},{key:"url",label:"페이지",render:r=><SourceLink value={r.url}/>},{key:"device",label:"기기"},{key:"seo_impressions",label:"SEO 노출"}]} />
      <SourceTable title="크롤러별 현황" rows={data.bots} columns={[{key:"date",label:"일자"},{key:"url",label:"페이지",render:r=><SourceLink value={r.url}/>},{key:"engine",label:"엔진"},{key:"bot",label:"크롤러"},{key:"hits",label:"크롤링 수"}]} />
      <SourceTable title="페이지 우선순위" rows={data.priorities} columns={[{key:"url",label:"페이지",render:r=><SourceLink value={r.url}/>},{key:"priority",label:"우선순위"},{key:"rule_ver",label:"분류 기준 버전"}]} />
    </>}
  </div>;
}
