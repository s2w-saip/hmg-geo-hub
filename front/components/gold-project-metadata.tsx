import { PageHeader } from "@/components/page-header";
import { SourceMetrics, SourceNotice, SourceTable, type SourceRow } from "@/components/source-data-ui";
import { screenGet } from "@/lib/screen";

export async function GoldProjectMetadata({ id, kind }: {id:string;kind:"member"|"setting"|"prompt"}) {
  const data = await screenGet<{project:SourceRow;prompts:SourceRow[]}>("projects/detail", { "ctx.project_id": id });
  if (kind === "prompt") return <div className="flex min-w-0 flex-col gap-6">
    <PageHeader title="프로젝트 프롬프트" description="Gold에 등록된 프로젝트 프롬프트와 실제 측정 현황"/>
    <SourceTable title="프롬프트 목록" rows={data.prompts} columns={[{key:"text",label:"프롬프트"},{key:"kind",label:"유형"},{key:"lang",label:"언어"},{key:"regions",label:"국가"},{key:"funnel",label:"퍼널"},{key:"targets",label:"타겟 URL"},{key:"answers",label:"답변 수"},{key:"last_measured",label:"최근 측정"}]}/>
    <SourceNotice>프롬프트 후보·생성 이력: 데이터 없음</SourceNotice>
  </div>;
  return <div className="flex min-w-0 flex-col gap-6">
    <PageHeader title={kind==="member"?"프로젝트 멤버":"프로젝트 정보"} description={id}/>
    <SourceNotice>현재 데이터 원천은 이 프로젝트의 {kind==="member"?"멤버·권한·초대 이력":"이름·설명·생성일"}을 제공하지 않습니다.</SourceNotice>
    <SourceMetrics items={(kind==="member"?["멤버","권한","초대 이력"]:["프로젝트명","설명","생성일"]).map(label=>({label,value:null}))}/>
    {kind==="setting" && <SourceTable title="제공된 식별 정보" rows={[data.project]} columns={[{key:"project_id",label:"프로젝트 ID"},{key:"scope_project_id",label:"원천 프로젝트 ID"},{key:"regions",label:"국가"}]}/>}
  </div>;
}
