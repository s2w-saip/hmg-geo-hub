import { PageHeader } from "@/components/page-header";
import { Link } from "@/i18n/navigation";
import { screenGet } from "@/lib/screen";
import { SourceLink, SourceMetrics, SourceNotice, SourcePager, SourceTable, sourceHref, type SearchValues, type SourceColumn, type SourceRow } from "@/components/source-data-ui";

type Pager = { total: number | null; next: string | null; prev: string | null };

export async function GoldKeywords({ sp = {}, projectId }: { sp?: SearchValues; projectId?: string }) {
  const base = projectId ? `/projects/${projectId}/intent/google-keyword` : "/customer-interest/google-keywords";
  const data = await screenGet<{ tab: string; items: SourceRow[]; history: SourceRow[]; serp: SourceRow[]; suggestions: SourceRow[]; location_options: string[]; language_options: string[]; pager: Pager }>("intent/keywords", sp);
  const market = [{key:"location_code",label:"검색 지역 코드"},{key:"language_code",label:"언어"}];
  const keywordColumn: SourceColumn = {key:"term",label:"키워드",render:r=><Link className="text-brand-700 underline" href={sourceHref(base, sp, {keyword:String(r.keyword_ref),location:String(r.location_code),language:String(r.language_code)})}>{String(r.term)}</Link>};
  const tabs = [["volume","월별 검색량"],["serp","검색 결과"],["suggestions","관련 키워드"]];
  return <div className="flex min-w-0 flex-col gap-6">
    <PageHeader title="Google 키워드" description="수집된 검색량, 검색 결과와 관련 키워드" />
    {projectId && <SourceNotice>전체 수집 데이터입니다. 프로젝트별 키워드 연결 정보는 데이터 없음으로 표시합니다.</SourceNotice>}
    <form method="get" className="flex flex-wrap gap-3 rounded-xl border bg-card p-4">
      <input type="hidden" name="tab" value={data.tab}/>
      <input aria-label="키워드 검색" name="q" defaultValue={String(sp.q ?? "")} placeholder="키워드 검색" className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm" />
      <select aria-label="검색 지역" name="location" defaultValue={String(sp.location ?? "")} className="rounded-md border bg-background px-3 py-2 text-sm"><option value="">전체 검색 지역</option>{data.location_options.map(code=><option key={code}>{code}</option>)}</select>
      <select aria-label="검색 언어" name="language" defaultValue={String(sp.language ?? "")} className="rounded-md border bg-background px-3 py-2 text-sm"><option value="">전체 언어</option>{data.language_options.map(lang=><option key={lang}>{lang}</option>)}</select>
      <button type="submit" className="rounded-md bg-brand-700 px-4 py-2 text-sm text-white">조회</button>
    </form>
    <nav aria-label="키워드 데이터 유형" className="flex flex-wrap gap-2">{tabs.map(([key,label])=><Link key={key} aria-current={data.tab===key?"page":undefined} className={`rounded-md border px-4 py-2 text-sm ${data.tab===key?"bg-brand-700 text-white":"bg-card"}`} href={sourceHref(base,sp,{tab:key,cursor:undefined,keyword:undefined})}>{label}</Link>)}</nav>
    <SourceTable title={`최근 ${tabs.find(t=>t[0]===data.tab)?.[1]}`} rows={data.items} columns={data.tab === "serp" ? [keywordColumn,...market,{key:"rank",label:"순위"},{key:"title",label:"검색 결과",render:r=><SourceLink value={r.url}>{String(r.title ?? r.url)}</SourceLink>},{key:"snippet",label:"요약"},{key:"observed_at",label:"수집 시각"}] : data.tab === "suggestions" ? [keywordColumn,...market,{key:"pos",label:"순서"},{key:"search_volume",label:"검색량"},{key:"intent",label:"검색 의도"},{key:"is_seed",label:"기준 키워드"},{key:"observed_at",label:"수집 시각"}] : [
      keywordColumn,
      ...market,{key:"month",label:"측정 월"},{key:"search_volume",label:"검색량"},{key:"competition",label:"경쟁도"},{key:"competition_index",label:"경쟁 지수"},{key:"cpc",label:"CPC"},{key:"observed_at",label:"수집 시각"},
    ]} />
    <SourcePager base={base} sp={sp} total={data.pager.total ?? undefined} next={data.pager.next} prev={data.pager.prev} />
    {sp.keyword && <>
      <SourceTable title="검색량 이력" rows={data.history} columns={[{key:"term",label:"키워드"},...market,{key:"month",label:"측정 월"},{key:"search_volume",label:"검색량"},{key:"competition",label:"경쟁도"},{key:"competition_index",label:"경쟁 지수"},{key:"cpc",label:"CPC"}]} />
      <SourceTable title="최근 검색 결과" rows={data.serp} columns={[{key:"rank",label:"순위"},{key:"title",label:"검색 결과",render:r=><SourceLink value={r.url}>{String(r.title ?? r.url ?? "데이터 없음")}</SourceLink>},{key:"domain",label:"도메인"},{key:"snippet",label:"요약"},...market,{key:"observed_at",label:"수집 시각"}]} />
      <SourceTable title="최근 관련 키워드" rows={data.suggestions} columns={[{key:"pos",label:"순서"},{key:"term",label:"키워드"},{key:"search_volume",label:"검색량"},{key:"intent",label:"검색 의도"},{key:"is_seed",label:"기준 키워드"},...market,{key:"observed_at",label:"수집 시각"}]} />
    </>}
    <SourceMetrics items={[{label:"등록·추적 키워드",value:null},{label:"프로젝트별 키워드 연결",value:null}]} />
  </div>;
}

export async function GoldSocial({ sp = {}, projectId }: { sp?: SearchValues; projectId?: string }) {
  const base = projectId ? `/projects/${projectId}/intent/social-scraping` : "/customer-interest/social-scraping";
  const data = await screenGet<{ snapshot: SourceRow | null; snapshots: SourceRow[]; stats: Record<string,number>; tab?: string; items: SourceRow[]; detail: Record<string,SourceRow[]|SourceRow> | null; evidence_rows?: SourceRow[]; research_runs_shown: number | null; claims_shown: number | null; pager: Pager }>("intent/social", sp);
  const tab = data.tab ?? "contexts";
  const tabs = [["contexts","소비자 맥락"],["requirements","소비자 요구"],["combinations","조건 조합"],["relations","맥락·요구 관계"],["research","리서치 이력"]];
  const entityName: SourceColumn = {key:"canonical_name",label:"이름",render:r=><Link className="text-brand-700 underline" href={sourceHref(base,sp,{entity:String(r.id),combination:undefined,run:undefined})}>{String(r.canonical_name)}</Link>};
  const entityColumns: SourceColumn[] = [entityName,{key:"dimension",label:"차원"},{key:"group_name",label:"그룹"},{key:"mention_count",label:"언급 수"},{key:"utterance_count",label:"발화 수"},{key:"unique_source_count",label:"출처 수"},
    {key:"sentiment_positive",label:"긍정"},{key:"sentiment_negative",label:"부정"},{key:"sentiment_neutral",label:"중립"},{key:"perspective_buyer",label:"구매자"},{key:"perspective_seller",label:"판매자"},{key:"perspective_neutral",label:"관점 중립"}];
  const columns: SourceColumn[] = tab === "combinations" ? [
    {key:"description",label:"조합",render:r=><Link className="text-brand-700 underline" href={sourceHref(base,sp,{combination:String(r.combo_id),entity:undefined,run:undefined})}>{String(r.label)}</Link>},
    {key:"condition_a",label:"조건 A"},{key:"condition_b",label:"조건 B"},{key:"co_count",label:"동시 언급"},{key:"total_speakers",label:"화자 수"},{key:"unique_source_count",label:"출처 수"},
  ] : tab === "relations" ? [{key:"context",label:"소비자 맥락"},{key:"requirement",label:"소비자 요구"},{key:"co_count",label:"동시 언급"},{key:"strength_score",label:"연결 강도"}]
    : tab === "research" ? [{key:"keyword",label:"키워드",render:r=><Link className="underline" href={sourceHref(base,sp,{run:String(r.run_id),entity:undefined,combination:undefined})}>{String(r.keyword ?? "데이터 없음")}</Link>},{key:"status",label:"상태"},{key:"search_count",label:"검색 수"},{key:"source_count",label:"출처 수"},{key:"worker_count",label:"작업 수"},{key:"purpose_text",label:"목적"}] : entityColumns;
  const detail = data.detail;
  const detailRows = (key:string) => Array.isArray(detail?.[key]) ? detail[key] as SourceRow[] : [];
  return <div className="flex min-w-0 flex-col gap-6">
    <PageHeader title="소셜 리서치" description="수집된 소비자 발화와 맥락·요구 분석" />
    {projectId && <SourceNotice>산업 공통 코퍼스입니다. 프로젝트별 수집 이력과 생성 프롬프트는 데이터가 있는 경우에만 표시합니다.</SourceNotice>}
    <form method="get" className="flex flex-wrap gap-3 rounded-xl border bg-card p-4">
      <input name="tab" type="hidden" value={tab}/>
      <select aria-label="분석 스냅샷" name="snapshot" defaultValue={String(data.snapshot?.snapshot_id ?? "")} className="rounded-md border bg-background px-3 py-2 text-sm">{data.snapshots.map(r=><option key={String(r.snapshot_id)} value={String(r.snapshot_id)}>{String(r.taken_at)}{r.is_active ? " · 현재" : ""}</option>)}</select>
      <input aria-label="맥락·요구 검색" name="q" defaultValue={String(sp.q ?? "")} placeholder="맥락·요구 검색" className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"/>
      <button type="submit" className="rounded-md bg-brand-700 px-4 py-2 text-sm text-white">조회</button>
    </form>
    <SourceMetrics items={[["총 발화",data.snapshot?.utterance_total],["총 출처",data.snapshot?.source_total],["소비자 맥락",data.stats.contexts],["소비자 요구",data.stats.requirements],["조건 조합",data.stats.combinations],["맥락·요구 관계",data.stats.relations],["근거 발화",data.stats.evidence],["리서치 이력",data.research_runs_shown]].map(([label,value])=>({label:String(label),value}))}/>
    <nav aria-label="소셜 분석 유형" className="flex flex-wrap gap-2">{tabs.map(([key,label])=><Link key={key} aria-current={tab===key?"page":undefined} className={`rounded-md border px-4 py-2 text-sm ${tab===key?"bg-brand-700 text-white":"bg-card"}`} href={sourceHref(base,sp,{tab:key,cursor:undefined,entity:undefined,combination:undefined,run:undefined})}>{label}</Link>)}</nav>
    <SourceTable title={tabs.find(t=>t[0]===tab)?.[1] ?? "소비자 맥락"} rows={data.items} columns={columns}/>
    <SourcePager base={base} sp={sp} total={data.pager.total ?? undefined} next={data.pager.next} prev={data.pager.prev}/>
    {detail && <>
      {detail.entity && <h3 className="text-lg font-semibold">{String((detail.entity as SourceRow).canonical_name)} · 상세</h3>}
      {("evidence" in detail || "combination_evidence" in detail) && <SourceTable title="근거 발화" rows={data.evidence_rows ?? []} columns={[{key:"quote",label:"발화"},{key:"source_title",label:"출처",render:r=><SourceLink value={r.source_url}>{String(r.source_label ?? "데이터 없음")}</SourceLink>},{key:"sentiment",label:"감성"},{key:"perspective",label:"관점"}]} />}
      {"domains" in detail && <SourceTable title="출처별 발화" rows={detailRows("domains")} columns={[{key:"host",label:"도메인"},{key:"n",label:"발화 수"}]}/>}
      {"related" in detail && <SourceTable title="관련 맥락·요구" rows={detailRows("related")} columns={[entityName,{key:"type",label:"유형"},{key:"mention_count",label:"언급 수"}]}/>}
      {"claims" in detail && <SourceTable title="주장 검증" rows={detailRows("claims")} columns={[{key:"claim",label:"주장"},{key:"supporting",label:"지지"},{key:"contradicting",label:"반대"},{key:"neutral",label:"중립"},{key:"total_scanned",label:"검토 수"},{key:"confidence",label:"신뢰도"}]}/>}
      {"claim_quotes" in detail && <SourceTable title="주장 근거" rows={detailRows("claim_quotes")} columns={[{key:"quote",label:"발화"},{key:"source",label:"출처"},{key:"stance",label:"입장"}]}/>}
      {"waves" in detail && <SourceTable title="조사 단계" rows={detailRows("waves")} columns={[{key:"wave_no",label:"단계"},{key:"strategy",label:"전략"}]}/>}
      {"workers" in detail && <SourceTable title="조사 작업" rows={detailRows("workers")} columns={[{key:"label",label:"작업"},{key:"query",label:"검색어"},{key:"status",label:"상태"},{key:"source_count",label:"출처 수"}]}/>}
      {"logs" in detail && <SourceTable title="조사 기록" rows={detailRows("logs")} columns={[{key:"title",label:"제목"},{key:"detail",label:"내용"}]}/>}
    </>}
    <SourceMetrics items={[{label:"주장 검증",value:data.claims_shown},{label:"생성 프롬프트",value:null}]} />
  </div>;
}
