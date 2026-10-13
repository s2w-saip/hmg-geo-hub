"""Build a standalone HTML audit from the inspected local source and reproductions."""
from __future__ import annotations

import hashlib
import html
import json
import subprocess
from pathlib import Path
from urllib.parse import quote
from software_audit_extension import FINDINGS as EXTRA_FINDINGS, SOURCES as EXTRA_SOURCES

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT / "hmg-geo-hub-share"
REPORTS = ROOT / "reports"
VERIFICATION = json.loads((REPORTS / "부록/GEO 소프트웨어 점검 재현.json").read_text(encoding="utf-8"))
WORKER_VERIFICATION = json.loads((REPORTS / "부록/GEO 백그라운드 작업 점검 재현.json").read_text(encoding="utf-8"))
ALL_CHECKS = VERIFICATION['checks'] + WORKER_VERIFICATION['checks']
HEAD = subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "--short=8", "HEAD"], text=True).strip()
e = html.escape

SOURCES = {
    "S01": ("front/lib/hgh/adapters/catalog.ts", [(83, 85), (120, 132)]),
    "S02": ("back/app/features/catalog/prompts/catalog/service.py", [(65, 68), (194, 206)]),
    "S03": ("front/app/[locale]/(dash)/standard/prompts/_components/prompt-list-readonly.tsx", [(67, 68), (447, 460)]),
    "S04": ("front/lib/db/repositories/standards.ts", [(160, 195), (317, 347)]),
    "S05": ("front/app/[locale]/(dash)/standard/prompts/page.tsx", [(43, 80), (103, 113)]),
    "S06": ("front/lib/hgh/adapters/admin.ts", [(193, 198), (219, 221), (421, 422), (458, 470)]),
    "S07": ("front/app/[locale]/(dash)/admin/standards/prompts/page.tsx", [(45, 58), (66, 71)]),
    "S08": ("front/app/[locale]/(dash)/admin/standards/prompts/_components/prompt-list.tsx", [(173, 187), (411, 424)]),
    "S09": ("front/lib/hgh/adapters/projects.ts", [(187, 197), (674, 718), (1521, 1546)]),
    "S10": ("front/app/[locale]/(dash)/projects/[id]/prompt/_components/prompt-list.tsx", [(281, 299), (620, 644)]),
    "S11": ("front/lib/db/repositories/prompts.ts", [(58, 64), (230, 236)]),
    "S12": ("front/app/[locale]/(dash)/projects/[id]/prompt/page.tsx", [(38, 41), (79, 88), (103, 108)]),
    "S13": ("front/lib/hgh/paginate.ts", [(61, 77), (80, 102)]),
    "S14": ("front/app/[locale]/raw-data-qa/answers/[jobId]/_components/detail-shell.tsx", [(46, 50), (58, 86), (115, 137), (156, 177)]),
    "S15": ("front/app/[locale]/raw-data-qa/answers/[jobId]/_components/verdict-bar.tsx", [(44, 54), (68, 74)]),
    "S16": ("front/app/api/qa/review/route.ts", [(9, 38)]),
    "S17": ("front/app/[locale]/(dash)/projects/[id]/prompt/_actions.ts", [(876, 898)]),
    "S18": ("back/app/features/projects/prompts/fields/service.py", [(67, 87)]),
    "S19": ("back/app/core/write.py", [(67, 74), (210, 238), (268, 280)]),
    "S20": ("back/app/core/db.py", [(130, 144)]),
    "S21": ("front/lib/ga4/conversion.ts", [(8, 12), (250, 265), (288, 325), (469, 480), (507, 524)]),
    "S22": ("front/lib/ga4/conversion.ts", [(539, 584), (612, 645)]),
    "S23": ("front/app/[locale]/(dash)/standard/ai-funnel/conversion/page.tsx", [(52, 59), (73, 98)]),
    "S24": ("front/lib/ga4/tracked-events-service.ts", [(50, 59)]),
    "S25": ("front/app/[locale]/(dash)/admin/standards/citation-sources/page.tsx", [(39, 55)]),
    "S26": ("front/app/[locale]/(dash)/admin/standards/citation-sources/_components/domain-list.tsx", [(264, 274)]),
    "S27": ("front/app/[locale]/(dash)/admin/standards/entities/page.tsx", [(102, 109)]),
    "S28": ("front/lib/hgh/client.ts", [(242, 249), (275, 300)]),
    "S29": ("front/lib/db/repositories/scope-context-map.ts", [(50, 51), (114, 121), (220, 239)]),
    "S30": ("front/app/[locale]/(dash)/projects/page.tsx", [(102, 118)]),
    "S31": ("front/app/[locale]/(dash)/projects/[id]/prompt/_components/candidate-list.tsx", [(170, 186)]),
}

FINDINGS = [
    dict(id="SW01", priority="P2", group="대량 목록", mode="공통", title="50개씩 보이지만, 표준 프롬프트는 먼저 전량 조회한다",
         route="/standard/prompts", proof="실제 어댑터 함수에 모의 10,001행을 넣어 전량 반환 확인 · UI 슬라이스는 정적 확인 (R01)",
         behavior="legacy 쿼리는 스코프에 속한 전체 행을 LIMIT 없이 읽는다. API 경로는 all=true로 페이지당 25,000행을 요청하고 최대 4페이지를 합친다. 화면에는 전체 rows가 전달되고, 브라우저에서 필터·정렬 후 기본 50행을 slice한다.",
         trigger="계정이 조회 가능한 프롬프트 수가 늘어나면 발생한다. API의 정상 커서 진행 기준 상한은 25,000 × 4 = 100,000행이다. 실제 운영 행 수가 10,000건을 넘는지는 확인하지 않았다.",
         impact="첫 화면에 50행만 보여도 전체 데이터의 DB 조회·전송·직렬화 및 클라이언트 배열 처리가 필요하다. 데이터 증가에 따라 초기 진입과 검색·정렬 비용이 커진다.",
         caveat="클라이언트 페이지네이션은 있다. 따라서 ‘한 화면에 표준 프롬프트 10,000행을 모두 그린다’는 설명은 부정확하다. 확인한 문제는 전량 로딩이다. 응답 크기·초 단위 지연·메모리 사용량은 실측하지 않았다.",
         fix="목록 화면에서 all=true와 fetchAllPages를 제거하고 검색·정렬·필터·커서를 서버에 전달한다. 전체 엑셀 내보내기는 별도 다운로드 경로로 둔다.",
         acceptance="10,001행 데이터에서도 초기 목록 응답은 선택한 pageSize 이하이며, 다음 페이지 이동 때만 추가 조회된다. 검색·정렬 결과와 전체 건수는 서버 기준으로 일치해야 한다.", refs=["S01", "S02", "S03", "S04", "S05"]),
    dict(id="SW02", priority="P2", group="대량 목록", mode="공통", title="관리자·프로젝트 프롬프트는 전체 행을 한꺼번에 렌더링한다",
         route="/admin/standards/prompts · /projects/[id]/prompt", proof="조회 함수 → 페이지 props → tbody의 sorted.map 호출 연결 확인 (정적)",
         behavior="관리자 목록과 프로젝트 프롬프트 목록은 sorted.map으로 필터에 남은 모든 행을 만든다. 후보 목록도 같은 구조다. 페이지 단위 slice나 가상 스크롤이 없다. API도 페이지들을 모두 모아 전달하고 legacy는 LIMIT 없는 쿼리로 읽는다.",
         trigger="필터에 많은 행이 남는 경우다. 예를 들어 관리자 API는 상한 이내의 10,000행이 모두 활성 행이면 10,000개 tr을 만든다. 프로젝트 프롬프트는 10,001행도 조회 상한 20,000행 이내라 같은 전체 렌더링 경로를 탄다.",
         impact="행마다 셀·배지·체크박스·편집 UI가 늘어나 초기 렌더링, 정렬, 선택 변경 때 브라우저가 처리할 작업이 커진다. 프로젝트의 사용자 정의 열 수가 늘면 셀 수도 함께 늘어난다.",
         caveat="성능 병목을 만드는 구조를 확인한 것으로, 특정 브라우저에서 멈춤이나 OOM이 발생했다는 실측 결과는 아니다. 필터나 삭제됨 탭에 따라 실제 렌더링 행 수는 줄어든다.",
         fix="서버 페이지네이션을 먼저 적용한다. 한 페이지도 큰 경우에는 행 가상화를 추가한다. 전체 선택은 ‘현재 페이지’와 ‘검색 결과 전체’를 구분해 서버 작업으로 처리한다.",
         acceptance="10,000행 이상의 모의 데이터에서도 DOM 행 수가 pageSize 또는 가상화 창 크기로 제한되고, 전체 선택·필터·내보내기의 대상 범위가 명확해야 한다.", refs=["S06", "S07", "S08", "S09", "S10", "S11", "S12", "S31"]),
    dict(id="SW03", priority="P1", group="대량 목록", mode="API", title="관리자 10,001건·프로젝트 20,001건에서 목록 화면이 실패한다",
         route="관리자 카탈로그: G7=api · 프로젝트 프롬프트: G6=api", proof="실제 fetchAllPages와 호출자 상수로 경계값 재현 (R02·R03)",
         behavior="관리자 카탈로그는 500행 × 최대 20페이지, 프로젝트 프롬프트·후보 목록은 각각 500행 × 최대 40페이지를 전부 수집한다. 마지막 허용 페이지에도 nextCursor가 남으면 fetchAllPages가 로컬 HghApiError(500)를 던진다. 페이지 호출자는 이를 오류 화면으로 전달한다.",
         trigger="관리자 카탈로그 10,000건은 20회 조회 후 성공하지만 10,001건은 20회 조회 후 실패한다. 프로젝트 프롬프트는 20,001건에서 40회 후 실패한다. 관리자 조회에는 soft-delete된 행도 포함되므로 활성 행 수만 보면 임계값을 놓칠 수 있다.",
         impact="정상적인 데이터 증가만으로 목록 페이지를 열 수 없게 된다. 부분 데이터를 탐색하거나 다음 페이지로 이동하는 대체 경로도 제공되지 않는다.",
         caveat="API 전환 경로에 한정된다. 이는 조용히 일부 데이터를 누락하는 버그가 아니라 명시적인 실패다. 커서 반복·무한 조회를 차단하는 helper의 보호 자체는 필요하며 상한만 늘리는 방식은 해결책이 아니다.",
         fix="화면에서는 fetchPageOrRestart 등 한 페이지 조회 방식을 사용하고 nextCursor를 UI에 전달한다. 전체 수집이 필요한 작업은 진행률·중단·결과 다운로드를 갖춘 별도 작업으로 옮긴다.",
         acceptance="10,000/10,001행과 20,000/20,001행 양쪽에서 첫 페이지가 정상 표시된다. 마지막 페이지까지 중복·누락 없이 이동하고, 데이터 세대 변경 시 커서 재시작이 안내된다.", refs=["S06", "S07", "S09", "S13"]),
    dict(id="SW04", priority="P1", group="저장·정합성", mode="공통", title="QA 판정 저장이 실패해도 이전 ‘저장됨’ 표시가 남는다",
         route="/raw-data-qa/answers/[jobId]", proof="실제 save·setFlag 함수로 성공 → 수정 → HTTP 401·422·500 시나리오 재현 (R04)",
         behavior="save는 409 충돌과 res.ok만 처리한다. 그 외 HTTP 오류에서는 에러 메시지를 만들지 않고 saving만 false로 바뀐다. 성공 시 설정한 savedAt은 이후 판정을 수정해도 지워지지 않으며, 하단 바는 savedAt이 있으면 계속 ‘저장됨’을 표시한다.",
         trigger="한 번 저장한 뒤 판정을 변경하고, 다음 PUT /api/qa/review가 세션 만료·검증 오류·서버 오류로 실패하는 경우다. 첫 저장부터 실패해도 사용자에게 저장 실패 안내가 없다.",
         impact="사용자가 최신 변경까지 저장됐다고 오인한 채 다음 항목으로 이동할 수 있다. 서버에 반영되지 않은 판정 변경이 사라진다. 네트워크 reject는 로컬에서 잡지 않으며 단축키는 void save()를 호출한다.",
         caveat="409 충돌은 잠금 상실·읽기 전용 상태로 처리한다. 문제는 나머지 실패와 수정 상태 관리다. 데이터 손실 사례를 운영에서 확인한 것은 아니며, 모의 HTTP 응답으로 저장 핸들러 동작을 재현했다.",
         fix="저장 상태를 idle/dirty/saving/saved/error로 관리하고 변경 즉시 dirty로 전환한다. 모든 non-2xx와 네트워크 예외를 사용자에게 표시한다. 실패 시 입력을 유지하고 재시도를 제공하며 미저장 상태의 이동을 보호한다.",
         acceptance="저장 성공 후 수정하면 즉시 미저장 표시로 바뀐다. 401·403·422·500·네트워크 오류 모두 명확한 실패 안내가 나타나고 ‘저장됨’이 남지 않아야 한다. 409 잠금 상실 처리도 유지한다.", refs=["S14", "S15", "S16"]),
    dict(id="SW05", priority="P1", group="저장·정합성", mode="API", title="일괄 태깅은 일부만 저장돼도 전체 실패처럼 반환한다",
         route="/projects/[id]/prompt · G6=api", proof="실제 chunk·일괄 저장 함수에 1,001개 ID와 두 번째 요청 실패 주입 (R06)",
         behavior="선택 ID를 1,000개씩 나눠 순차 POST한다. 각 백엔드 요청은 별도 DB 트랜잭션이다. 뒤 청크가 실패하면 즉시 실패 결과만 반환하고 앞 청크의 성공 건수·ID를 버린다. 서버 액션은 r.ok일 때만 revalidatePath를 실행하고 UI도 성공할 때만 값을 갱신한다.",
         trigger="1,001건을 선택해 첫 1,000건 요청은 성공하고 나머지 1건 요청이 거절되거나 실패하는 경우다. 모의 저장소에서 1,000건 변경 후 {ok:false,error:…}만 반환되는 것을 확인했다.",
         impact="실제 서버에는 일부 값이 바뀌었지만 화면에는 실패 알림과 이전 값이 남을 수 있다. 사용자는 어느 행이 적용됐는지 판단할 수 없고, 재시도 범위도 알 수 없다.",
         caveat="한 청크 안의 검증과 쓰기는 트랜잭션으로 묶여 있다. 문제는 여러 HTTP 요청을 합친 사용자 작업의 부분 성공 표현이다. 같은 태그값 UPSERT 재시도가 곧바로 중복 행을 만든다고 단정하지 않는다.",
         fix="원자적인 서버 일괄 작업으로 만들거나, 작업 ID와 청크별 상태를 저장하고 적용/실패/미시도 ID 및 건수를 반환한다. 부분 성공에서도 화면을 갱신하고 남은 항목만 재시도할 수 있게 한다.",
         acceptance="두 번째 청크 실패 주입 시 전부 롤백되거나, 적용 1,000건·실패/미처리 1건이 정확히 표시된다. 새로고침 전후 UI와 DB가 일치하고 재시도 결과도 추적 가능해야 한다.", refs=["S09", "S10", "S17", "S18", "S19", "S20"]),
    dict(id="SW06", priority="P1", group="저장·정합성", mode="legacy", title="GA4 설정 조회 장애가 전환 지표의 집계 기준을 바꾼다",
         route="/standard/ai-funnel/conversion의 legacy 경로 · 동일 GA4 helper 호출부", proof="실제 설정 해석·집계 함수에 설정 DB 오류 주입 (R07)",
         behavior="resolveConvSpec은 선택 이벤트 설정 조회가 실패해도 null을 반환한다. null은 ‘설정 없음 → GA4 keyEvents 사용’과 같은 값이다. 정상이라면 선택 이벤트의 eventCount로 덮어쓰지만, 설정 조회 장애 때는 기본 keyEvents를 사용한다. 다국가 설정 조회도 실패를 빈 Map으로 바꾼다.",
         trigger="예를 들어 test_drive만 선택된 속성에서 GA4 API는 정상이나 설정 DB가 실패하는 경우다. 모의 응답에서 사용자는 20명으로 동일한데 분자가 선택 이벤트 2건에서 keyEvents 12건으로 바뀌었다.",
         impact="장애가 ‘측정 불가’로 드러나는 대신 의미가 다른 숫자로 표시된다. 동일한 KPI 이름으로 비교할 수 없는 값이 제공되며, 이 정상 반환 값은 캐시 저장 대상도 된다.",
         caveat="예시 2건·12건은 재현용 값이다. 실제 지표 오류량을 측정한 것이 아니다. 설정이 원래 없는 속성의 keyEvents 기본값 사용은 정상 동작이며, 이 결함은 설정 조회 실패를 정상 미설정과 구별하지 않는 데 있다. 새 G4 API 경로에 같은 결함이 있다고 일반화하지 않는다.",
         fix="설정 없음과 조회 실패를 구분하는 결과 타입을 사용한다. 실패 시 지표를 오류/미확인으로 표시하거나 마지막 정상 설정과 시각을 함께 사용한다. 집계 기준을 바꾼 fallback을 정상 KPI로 캐시하지 않는다.",
         acceptance="선택 이벤트 설정이 존재하는 상태에서 DB 오류를 주입해도 기본 keyEvents로 바뀌지 않는다. 데이터 옆에 사용한 이벤트 설정 버전과 데이터 상태를 확인할 수 있어야 한다.", refs=["S21", "S22", "S23"]),
    dict(id="SW07", priority="P1", group="저장·정합성", mode="legacy", title="일시적인 GA4 조회 실패가 24시간 재검증 캐시의 정상 결과가 된다",
         route="지역·HQ 전환 집계 · getAiTrafficConversionRollup", proof="실제 집계 함수를 실행해 부분/전체 실패의 정상 반환 및 cache 옵션 확인 (R08)",
         behavior="국가별 fetchCohorts 예외를 로그와 null로 바꾼 뒤 성공한 국가만 합산한다. 전부 실패해도 measuredMarkets=0, totalAiUsers=0인 객체를 반환한다. 이 함수는 revalidate=86,400초인 unstable_cache 내부에서 실행된다.",
         trigger="캐시를 채우거나 갱신하는 시점에 하나 이상의 GA4 속성이 timeout 등으로 실패하는 경우다. 모의 2개 국가 중 1개 실패 시 1/2 커버리지 결과, 전부 실패 시 0/2와 0 합계를 정상 반환했다.",
         impact="불완전한 집계가 성공한 캐시 값으로 취급되어, 외부 API가 복구되어도 후속 조회에서 바로 재시도되지 않을 수 있다. 국가 구성과 합계가 바뀐 결과를 사용자가 정상 집계와 혼동할 여지가 있다.",
         caveat="완전히 숨겨진 실패는 아니다. 서버 warning과 measured/total 커버리지가 존재한다. 다만 실패 국가·이유가 반환되지 않는다. 24시간은 코드의 재검증 설정이며 실제 캐시 보존 시간을 실측한 값이 아니다. 태그 무효화·배포 등은 더 빨리 갱신시킬 수 있다. 국가 단일 조회는 예외를 캐시 밖에서 잡는 보호가 이미 있다.",
         fix="국가별 성공·실패와 마지막 성공 시각을 반환한다. 정상 집계 캐시와 장애 결과를 분리하고, 실패 국가를 짧은 간격으로 재시도하거나 마지막 정상 집계를 stale 표시와 함께 제공한다.",
         acceptance="첫 요청에서 1개 국가 실패 후 복구시킨 테스트에서 24시간을 기다리지 않고 정상 커버리지로 회복한다. 전체 실패를 정상 0으로 캐시하지 않고, 부분 집계임을 화면에서 구분할 수 있어야 한다.", refs=["S21", "S22", "S23", "S24"]),
    dict(id="SW08", priority="P2", group="오류 가시성", mode="공통", title="관리자 조회 장애가 ‘데이터 없음’ 화면으로 바뀐다",
         route="/admin/standards/citation-sources · /admin/standards/entities(legacy)", proof="degradeRead의 500→빈 배열 동작, 페이지 전달 및 empty 렌더링 확인 (R09 + 정적)",
         behavior="인용 출처 페이지는 legacy DB 실패를 catch(()=>[])로 바꾸고 API의 일반 서버 오류도 degradeRead(e,[])로 바꾼다. DomainList는 전달받은 배열이 비면 빈 목록 문구를 보여준다. legacy 엔터티 목록도 동일한 빈 배열 fallback을 사용한다.",
         trigger="DB 접속 오류, backend 500 등으로 목록 읽기가 실패했을 때다. 실제 데이터가 존재하더라도 페이지에 전달되는 값은 []가 된다.",
         impact="사용자는 ‘아직 등록된 데이터가 없음’과 ‘조회할 수 없음’을 구별하지 못한다. 데이터 누락으로 오인하거나 장애를 인지하지 못해 재시도·조치가 늦어진다.",
         caveat="API 경로는 console.warn을 남기므로 로그까지 완전히 없는 silent failure는 아니다. 인증/권한 오류 401·403, 404 및 로컬 오류는 다시 throw한다. 엔터티 API 경로 전체에 이 결함이 있다고 보지는 않는다.",
         fix="rows와 함께 status/error/lastSuccessfulAt을 전달한다. 빈 결과, 로딩 실패, 마지막 정상 데이터 표시를 분리하고 조회 실패 시 재시도 버튼과 요청 식별자를 제공한다.",
         acceptance="성공+빈 배열과 HTTP 500이 서로 다른 화면을 보여야 한다. 오류 상태에서는 ‘0건’이 확정 결과로 표시되지 않으며, API 경로의 인증 오류 처리도 유지된다.", refs=["S06", "S25", "S26", "S27"]),
    dict(id="SW09", priority="P2", group="오류 가시성", mode="공통", title="QA 잠금 획득·갱신 실패를 알아도 편집 상태가 명확히 바뀌지 않는다",
         route="/raw-data-qa/answers/[jobId]", proof="실제 잠금 획득 요청 처리에 HTTP 500 주입 (R05)",
         behavior="readOnly의 초기값은 false다. 잠금 획득은 409+heldBy만 읽기 전용으로 바꾸고 500·네트워크 실패는 무시한다. heartbeat도 HTTP 상태를 검사하지 않으며 catch가 비어 있다. held=false를 받으면 lockLost만 켜고 readOnly는 바꾸지 않는다.",
         trigger="페이지 진입 시 잠금 API가 실패하거나, 편집 중 세션/네트워크 문제로 heartbeat가 실패하는 경우다.",
         impact="잠금 보유 여부를 확인하지 못한 상태에서 사용자가 계속 편집할 수 있다. 저장 단계에 이르러서야 충돌이나 실패를 알게 되며 SW04의 저장 오류 미표시와 겹치면 원인을 더 파악하기 어렵다.",
         caveat="서버는 저장 직전에 락을 재확인한다. 이 결과만으로 동시 수정에 따른 DB 덮어쓰기나 권한 우회를 주장하지 않는다. 초기 fetch와 heartbeat의 화면 상태 관리 문제다.",
         fix="잠금 상태를 acquiring/held/lost/error로 관리한다. held 확인 전과 상실 후의 편집 정책을 명시하고, 실패 시 편집 내용을 보존한 채 재획득·복사·재시도 경로를 제공한다.",
         acceptance="초기 500·네트워크 실패 및 heartbeat의 held=false를 주입했을 때 화면 상태와 저장 가능 여부가 일관되게 바뀐다. 보존한 입력을 잠금 재획득 후 안전하게 저장할 수 있어야 한다.", refs=["S14", "S15", "S16"]),
]


FINDINGS.extend(EXTRA_FINDINGS)
SOURCES.update(EXTRA_SOURCES)
P1_COUNT = sum(f['priority'] == 'P1' for f in FINDINGS)
P2_COUNT = sum(f['priority'] == 'P2' for f in FINDINGS)


def refs(ids):
    return '<span class="refs">' + ' '.join(f'<a href="#{key}">{key}</a>' for key in ids) + '</span>'


def finding_card(item):
    fields = [("확인한 동작", "behavior"), ("발생 조건", "trigger"), ("사용자 영향", "impact"),
              ("판정의 범위", "caveat"), ("수정 방향", "fix"), ("완료 확인 기준", "acceptance")]
    body = ''.join(f'<dt>{title}</dt><dd>{e(item[key])}</dd>' for title, key in fields)
    return f'''<article id="{item['id']}" class="finding" data-priority="{item['priority']}" data-mode="{item['mode']}">
      <div class="finding-top"><span class="badge {item['priority'].lower()}">{item['priority']}</span><span>{item['id']} · {e(item['group'])} · {item['mode']}</span></div>
      <h3>{e(item['title'])}</h3><p class="route">{e(item['route'])}</p>
      <p class="proof">{e(item['proof'])}</p><dl>{body}</dl><p class="source-links">코드 근거 {refs(item['refs'])}</p></article>'''


source_details = []
for key, (name, spans) in SOURCES.items():
    path = REPO / name
    raw_content = path.read_bytes()
    content = raw_content.decode("utf-8")
    rows = content.splitlines()
    snippets = []
    for first, last in spans:
        assert 1 <= first <= last <= len(rows), (key, first, last)
        snippets.append('\n'.join(f'{i:4d} | {rows[i - 1]}' for i in range(first, last + 1)))
    excerpt = '\n\n    …\n\n'.join(snippets)
    label = ', '.join(f'L{a}–{b}' for a, b in spans)
    href = '../hmg-geo-hub-share/' + quote(name, safe='/')
    source_details.append(f'<details id="{key}"><summary>{key} <span>{e(name)} · {label}</span></summary><p><a href="{href}">원본 파일 열기</a> · SHA-256 <code>{hashlib.sha256(raw_content).hexdigest()}</code></p><pre>{e(excerpt)}</pre></details>')

overview = ''.join(f'<tr><td><a href="#{f["id"]}">{f["id"]}</a></td><td><span class="badge {f["priority"].lower()}">{f["priority"]}</span></td><td>{e(f["title"])}</td><td>{f["mode"]}</td></tr>' for f in FINDINGS)
repro_rows = ''.join(f'<tr><td>{c["id"]}</td><td>{e(c["title"])}</td><td>문제 동작 재현</td></tr>' for c in ALL_CHECKS)
cards = ''.join(finding_card(f) for f in FINDINGS)
sources_html = ''.join(source_details)

CSS = '''
:root{--ink:#192a35;--muted:#5a6b75;--bg:#f1f4f5;--paper:#fff;--line:#d9e2e6;--accent:#086c78;--p1:#a52f38;--p2:#825207}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.75 "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;word-break:keep-all}main{max-width:1240px;margin:auto;padding:32px 24px 70px}header{background:#173641;color:white;border-radius:14px;padding:32px}header p{max-width:980px}h1{font-size:34px;line-height:1.3;margin:8px 0 18px;letter-spacing:-.04em}h2{font-size:23px;margin:0 0 15px;line-height:1.45}h3{font-size:20px;margin:9px 0 7px;line-height:1.5}p{margin:10px 0}a{color:var(--accent);text-underline-offset:3px}header a{color:#b6e8e5}.eyebrow{font-size:12px;letter-spacing:.1em;color:#b6e8e5}.lead{font-size:20px}.meta{font-size:12px;color:#c9d9de}.muted,small{color:var(--muted);font-size:13px}nav{display:flex;flex-wrap:wrap;gap:10px 22px;padding:20px 0}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.stat{padding:18px;background:white;border:1px solid var(--line);border-radius:9px}.stat b{display:block;font-size:30px;line-height:1.4}.stat span{color:var(--muted);font-size:13px}section{background:white;border:1px solid var(--line);border-radius:12px;padding:26px;margin-top:20px}.notice{background:#e9f4f4;border-left:4px solid var(--accent);padding:16px 20px;margin:16px 0}.badge{display:inline-block;padding:2px 9px;font-size:12px;font-weight:700;border-radius:5px;white-space:nowrap}.p1{color:var(--p1);background:#fcebed}.p2{color:var(--p2);background:#fff2da}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px;min-width:640px}th,td{border-bottom:1px solid var(--line);text-align:left;vertical-align:top;padding:12px 10px}th{background:#f4f7f8;white-space:nowrap}.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.flow div{border:1px solid var(--line);border-top:4px solid var(--accent);padding:16px;border-radius:6px}.flow b{display:block}.flow span{font-size:13px;color:var(--muted)}.finding{border-top:1px solid var(--line);padding:27px 0;scroll-margin-top:24px}.finding:last-child{padding-bottom:0}.finding-top{display:flex;gap:12px;align-items:center;font-size:12px;color:var(--muted)}.route{font:12px/1.8 Consolas,monospace;color:var(--muted);overflow-wrap:anywhere}.proof{padding:10px 14px;background:#f0f6f7;font-size:13px}dl{display:grid;grid-template-columns:112px 1fr;gap:12px 20px;margin:18px 0}dt{font-size:13px;font-weight:bold}dd{margin:0;font-size:14px}.refs{display:inline-flex;gap:7px;flex-wrap:wrap}.refs a{background:#eaf2f3;padding:2px 7px;border-radius:4px;font:12px/1.8 Consolas,monospace}.source-links{font-size:12px;color:var(--muted)}.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:18px 0}.filters label{font-size:12px;color:var(--muted)}input,select{display:block;margin-top:4px;padding:10px 12px;border:1px solid #b9cbd1;border-radius:6px;color:var(--ink);background:white;font:14px "Malgun Gothic",sans-serif}input{width:340px;max-width:100%}#visible-count{font-size:13px;padding-bottom:8px}details{border-top:1px solid var(--line);padding:14px 0}summary{cursor:pointer;font-weight:bold}summary span{display:block;font:12px/1.8 Consolas,monospace;overflow-wrap:anywhere;color:var(--muted)}details p{font-size:12px;overflow-wrap:anywhere}pre{font:12px/1.7 Consolas,"Malgun Gothic",monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;padding:16px;background:#f2f5f6}code{font:12px/1.7 Consolas,monospace;overflow-wrap:anywhere}li{margin:8px 0}footer{font-size:12px;color:var(--muted);margin-top:24px}[hidden]{display:none!important}a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:4px}
@media(max-width:760px){main{padding:16px 12px 40px}header,section{padding:20px}h1{font-size:28px}h3{font-size:18px}.lead{font-size:17px}.stats,.flow{grid-template-columns:repeat(2,1fr)}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:12px}.filters label:first-child{width:100%}input{width:100%}}
@media print{body{background:white;font-size:11px}main{padding:0;max-width:none}header{background:white;color:var(--ink);padding:0 0 16px;border-radius:0}.meta,.eyebrow{color:var(--muted)}nav,.filters{display:none}section{padding:15px;border-radius:0}.finding{break-inside:auto}.finding h3,h2{break-after:avoid}tr{break-inside:avoid}table{min-width:0;font-size:10px}pre{font-size:9px}.stats{grid-template-columns:repeat(4,1fr)}.table-wrap{overflow:visible}.finding[hidden]{display:block!important}}
'''

SCRIPT = '''
const search = document.getElementById('search');
const priority = document.getElementById('priority');
const mode = document.getElementById('mode');
const findings = [...document.querySelectorAll('.finding')];
function filterFindings(){
  const query = search.value.trim().toLowerCase();
  let shown = 0;
  findings.forEach(el => {
    const ok = (!priority.value || el.dataset.priority === priority.value)
      && (!mode.value || el.dataset.mode === mode.value || (mode.value !== 'ingest' && el.dataset.mode === '공통'))
      && (!query || el.textContent.toLowerCase().includes(query));
    el.hidden = !ok;
    if(ok) shown++;
  });
  document.getElementById('visible-count').textContent = shown + ' / ' + findings.length + '개 항목';
  document.getElementById('no-results').hidden = shown !== 0;
}
[search,priority,mode].forEach(el => el.addEventListener('input',filterFindings));
function revealAnchor(){
  const id = decodeURIComponent(location.hash.slice(1));
  const target = document.getElementById(id);
  if(!target) return;
  if(target.classList.contains('finding') && target.hidden){search.value='';priority.value='';mode.value='';filterFindings();}
  if(target.tagName === 'DETAILS') target.open = true;
  target.scrollIntoView({block:'start'});
}
window.addEventListener('hashchange',revealAnchor);
window.addEventListener('beforeprint',()=>document.querySelectorAll('details').forEach(el=>el.open=true));
filterFindings();
if(location.hash) revealAnchor();
'''

document = f'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GEO 소프트웨어 품질 점검</title><style>{CSS}</style></head><body><main>
<header><div class="eyebrow">SOFTWARE REVIEW · 2026-10-08</div><h1>GEO 소프트웨어 품질 점검</h1>
<p class="lead"><strong>대량 목록의 전량 로딩, 저장 실패의 미표시, 부분 성공·실패를 정상 결과와 구별하지 못하는 경로가 있다.</strong></p>
<p>데이터 조회 → 화면 렌더링, 저장 → 부분 성공 → UI 갱신, 외부 오류 → fallback → 캐시뿐 아니라 백그라운드 작업의 중단·복구와 완료 판정까지 확인했다. {len(FINDINGS)}개 발견 사항 중 {P1_COUNT}개를 우선 수정 대상으로 분류했다.</p>
<p class="meta">대상: hmg-geo-hub-share · 로컬 HEAD {HEAD} · 정적 코드 점검 + 의존성을 모의한 소스 함수 실행<br>운영 DB·배포 환경 변수·실제 트래픽·브라우저 성능은 미측정. 제품 코드 변경 없음.</p></header>
<nav aria-label="보고서 목차"><a href="#overview">발견 사항</a><a href="#volume">대량 목록 비교</a><a href="#details">상세 근거·수정 기준</a><a href="#verification">재현 결과</a><a href="#boundaries">판정 범위</a><a href="#sources">코드 발췌</a></nav>
<div class="stats"><div class="stat"><b>{len(FINDINGS)}</b><span>소프트웨어 문제·위험 항목</span></div><div class="stat"><b>{P1_COUNT} / {P2_COUNT}</b><span>P1 우선 수정 / P2 개선</span></div><div class="stat"><b>{len(ALL_CHECKS)} / {len(ALL_CHECKS)}</b><span>모의 시나리오에서 문제 동작 재현</span></div><div class="stat"><b>{len(SOURCES)}</b><span>코드 근거 묶음 · 원문 발췌 포함</span></div></div>

<section id="overview"><h2>발견 사항</h2>
<div class="notice"><strong>2차 점검에서 6개 추가: SW10~15.</strong> 작업 중단 뒤 running 회수 누락, 외부 생성 ID 없이 완료 처리, 일일 작업 실패 후 재시도 누락, 긴 pull에 의한 큐 지연, 캐시 복구 누락, GA4 호출의 자체 timeout 부재를 확인했다. 기존 9개 항목은 유지했다. <a href="#SW10">추가 항목부터 보기</a></div>
<p><strong>먼저 QA 저장 상태와 일괄 작업의 부분 성공을 바로잡고, 지표 집계 실패를 정상 데이터와 분리하는 것이 좋다.</strong> 목록은 서버 페이지네이션으로 바꾸면 전량 로딩, 전체 DOM, 상한 초과 오류를 함께 해결할 수 있다. SW01~03은 같은 설계의 서로 다른 영향이므로 구현 과제로는 묶을 수 있다.</p>
<p class="muted">P1: 잘못된 저장·완료 인식, 미복구 작업, 지표 의미 변경, 정상 데이터 증가에 의한 화면 실패. P2: 대량 성능, 장애 상태 식별, 실행 지연, 캐시·유지 작업 복구. 우선순위는 코드 영향 기준이며 발생 빈도 통계는 아니다.</p>
<div class="table-wrap"><table><thead><tr><th>ID</th><th>우선순위</th><th>문제</th><th>적용 경로</th></tr></thead><tbody>{overview}</tbody></table></div>
<div class="notice"><strong>legacy·API·ingest를 구분해야 한다.</strong> 프런트의 소스 선택 기본값은 legacy다. 표준 프롬프트는 G5, 전환 지표는 G4, 프로젝트는 G6, 관리자·QA는 G7로 전환된다. ingest는 Python 적재 워커가 실행되는 경우의 별도 경로다. 실제 배포 설정·워커 가동 여부는 확인하지 않았으므로 현재 운영 장애로 단정하지 않는다. {refs(['S28','S23','S16','S32'])}</div>
</section>

<section id="volume"><h2>‘10,000개를 한 화면에 로드’하는가?</h2>
<p><strong>전량 조회는 확인했다. 전체 행 렌더링 여부는 화면마다 다르다.</strong> 아래 상한은 정상적으로 커서가 진행되고 페이지가 최대 크기로 채워지는 경우다. 커서 재시작이 있으면 HTTP 요청 횟수는 더 늘어날 수 있다.</p>
<div class="table-wrap"><table><thead><tr><th>화면</th><th>데이터 조회</th><th>화면 렌더링</th><th>API 경계값</th></tr></thead><tbody>
<tr><td>표준 프롬프트</td><td>legacy: 범위 내 전량<br>API: 25,000 × 4페이지까지 합침</td><td>클라이언트에서 기본 50행 slice<br>조회·전송은 전량</td><td>최대 100,000행 수집 후에도 커서가 남으면 오류</td></tr>
<tr><td>관리자 프롬프트</td><td>legacy: 삭제 포함 전량<br>API: 500 × 20페이지까지 합침</td><td>필터에 남은 모든 행을 map<br>페이지네이션·가상화 없음</td><td>10,000건 성공 → 10,001건 실패<br>삭제된 행도 상한에 포함</td></tr>
<tr><td>프로젝트 프롬프트·후보</td><td>legacy: 목록별 전량<br>API: 목록별 500 × 40페이지까지 합침</td><td>필터에 남은 모든 행을 map<br>사용자 정의 열까지 함께 생성</td><td>프롬프트 또는 후보가 20,000건을 넘으면 페이지 로딩 실패 가능</td></tr>
</tbody></table></div>
<div class="flow" aria-label="표준 프롬프트 데이터 흐름"><div><b>① 서버에서 전량 조회</b><span>API에도 페이지는 있지만 끝까지 수집한다.</span></div><div><b>② 전체 rows 전달</b><span>클라이언트 컴포넌트 props에 담긴다.</span></div><div><b>③ 전체 배열 처리</b><span>필터·정렬·ID 연결 등을 수행한다.</span></div><div><b>④ 마지막에 50행 표시</b><span>표시 행 수만 줄어든다.</span></div></div>
<p class="muted">10,001건은 재현용 데이터다. 현재 운영 데이터가 몇 건인지, 응답이 몇 MB인지, 렌더링에 몇 초가 걸리는지는 이번 분석에서 측정하지 않았다.</p></section>

<section id="details"><h2>상세 근거와 수정 완료 기준</h2>
<div class="filters"><label>내용 검색<input id="search" type="search" placeholder="예: 저장, GA4, 워커, 캐시"></label><label>우선순위<select id="priority"><option value="">전체</option><option>P1</option><option>P2</option></select></label><label>동작 경로<select id="mode"><option value="">전체</option><option value="legacy">legacy + 공통</option><option value="API">API + 공통</option><option value="ingest">ingest 워커</option></select></label><span id="visible-count" aria-live="polite"></span></div>
<p id="no-results" hidden>조건에 맞는 항목이 없습니다.</p>{cards}</section>

<section id="verification"><h2>재현 결과</h2><p>원본 TypeScript 함수는 Node의 타입 제거 기능으로, Python 워커는 원본 모듈·AST에서 추출한 함수를 실행했다. 요청 계약은 실제 Pydantic 모델을 사용하고 fetch·저장소·DB 트랜잭션·외부 서비스·시계는 필요한 경계에서 모의했다. <strong>PASS는 문제가 해결됐다는 뜻이 아니라, 기술한 문제 동작에 대한 assertion이 성립했다는 뜻이다.</strong></p>
<div class="table-wrap"><table><thead><tr><th>ID</th><th>검증 시나리오</th><th>결과</th></tr></thead><tbody>{repro_rows}</tbody></table></div>
<p class="muted">실행 환경: {e(VERIFICATION['nodeVersion'])} · 실행 시각(UTC): {e(VERIFICATION['createdAt'])}. R02·R03은 공통 페이지 수집 helper와 호출자 상수의 조합 검증이며 전체 페이지 E2E 실행이 아니다. R08은 캐시 콜백의 정상 반환과 86,400초 설정을 확인했으며 실제 Next 캐시 수명은 측정하지 않았다. React 렌더링과 DB 트랜잭션 연결은 소스 추적으로 확인했다.</p>
<p class="muted">Python: {e(WORKER_VERIFICATION['pythonVersion'])} · 실행 시각(UTC): {e(WORKER_VERIFICATION['createdAt'])}. R12·R13은 모의 시각·대기 제어를 사용했고 실제로 하루나 15분을 기다리지 않았다. R14·R15는 DB 트랜잭션 모형을 사용했으며 실제 PostgreSQL·ECS 종료·외부 Scope와의 통합 시험은 아니다. R11의 20ms는 모의 응답의 pending 여부를 관찰하는 시험용 타이머다.</p>
<p><a href="{quote('부록/verify_software_risks.mjs')}">재현 스크립트</a> · <a href="{quote('부록/GEO 소프트웨어 점검 재현.json')}">재현 결과 JSON·소스 SHA-256</a> · <a href="{quote('부록/build_software_audit.py')}">보고서 생성 스크립트</a></p>
<p><a href="{quote('부록/verify_worker_risks.py')}">워커 재현 스크립트</a> · <a href="{quote('부록/GEO 백그라운드 작업 점검 재현.json')}">워커 재현 결과 JSON·소스 SHA-256</a> · <a href="{quote('부록/software_audit_extension.py')}">2차 점검 항목·근거</a></p>
<pre>node --disable-warning=ExperimentalWarning reports/부록/verify_software_risks.mjs
python -X utf8 reports/부록/verify_worker_risks.py
python -X utf8 reports/부록/build_software_audit.py</pre></section>

<section id="boundaries"><h2>문제로 단정하지 않은 부분</h2>
<ul>
<li><strong>컨텍스트맵 목록:</strong> 기본 50, 최대 200행의 서버 페이지네이션과 상세 분리 경로가 있다. 과거 전량 로딩을 설명하는 주석이나 내보내기용 전량 조회를 현재 화면 결함으로 세지 않았다. {refs(['S29'])}</li>
<li><strong>프로젝트 홈의 N+1 조회:</strong> 현재는 이름·권한·멤버 수·프롬프트 수를 4개 일괄 조회로 묶는다. 과거 60회 이상 조회를 언급한 주석을 현행 문제로 보지 않았다. {refs(['S30'])}</li>
<li><strong>fetchAllPages의 보호:</strong> 최대 페이지 수, 반복 커서 차단, stale 커서의 1회 재시작은 있다. 문제는 큰 화면 목록이 이 함수를 사용해 전량을 소비하는 데 있다. {refs(['S13'])}</li>
<li><strong>QA 서버의 저장 잠금:</strong> 저장 직전에 소유권을 재확인한다. 클라이언트 잠금 상태 문제가 곧바로 동시 쓰기 허용을 의미하지 않는다. {refs(['S16'])}</li>
<li><strong>HGH HTTP 클라이언트:</strong> 요청 timeout과 읽기 요청에 대한 제한된 재시도가 있다. 저장 요청을 일반 네트워크 실패 때 무조건 재전송하는 구조로 보지 않았다. GA4의 별도 클라이언트와 구분했다. {refs(['S47'])}</li>
<li><strong>접근 감사 로그 유실:</strong> AccessAuditWriter는 메모리 버퍼 초과나 DB 배치 실패 시 버리도록 명시적으로 설계됐다. 버퍼 기본 상한은 20,000건이고 배치 실패는 warning을 남긴다. 이는 ‘Q4 유실 허용’이라는 설계 선택이므로 신규 결함 수에 넣지 않았다. 감사 기록의 누락 없는 보존이 요구된다면 영속 큐·재시도·유실 지표가 별도 과제다. {refs(['S19'])}</li>
</ul>
<h3>이번 점검의 범위</h3><p>요청한 대량 로딩과 silent failure를 중심으로 <code>hmg-geo-hub-share</code>의 실제 호출 경로를 확인했다. <code>_archive</code>를 현행 구현으로 취급하지 않았다. 이 보고서는 전체 보안 감사나 운영 성능 인증이 아니다. 운영에서의 발생 여부를 확정하려면 활성 소스 플래그, 스코프별 행 수, 응답 크기·시간, DOM 수, DB 실행 계획, 오류 로그와 캐시 상태를 해당 배포에서 확인해야 한다.</p>
<p>수정 순서는 ① 저장 오류·부분 성공 및 잘못된 작업 완료/미복구 상태(SW04·05·10·11), ② GA4 실패/정상 결과 분리(SW06·07, legacy 사용 시), ③ 서버 페이지네이션과 목록 화면 전환(SW01~03), ④ 실패 복구·시간 예산·상태 가시성(SW08·09·12~15)을 제안한다. 실제 사용 경로부터 적용하며, 관리자 목록이 이미 상한에 가까우면 ③을 앞당긴다.</p>
<p><a href="{quote('GEO 실제 프로젝트 측정 유효성 분석.html')}">기존 측정 유효성 분석 보고서</a>와 별도로, 이번 보고서는 프로그램의 조회·저장·오류 처리 동작을 다룬다.</p></section>

<section id="sources"><h2>코드 근거</h2><p class="muted">각 S 번호를 누르면 해당 근거가 펼쳐진다. 원본 파일의 줄 번호를 유지한 발췌다. 재현 스크립트가 사용한 소스는 JSON에 SHA-256으로 기록했다.</p>{sources_html}</section>
<footer>GEO 소프트웨어 품질 점검 · 2026-10-08 · 정적 분석과 모의 의존성 재현 · 제품 코드 수정 없음</footer>
</main><script>{SCRIPT}</script></body></html>'''

target = REPORTS / "GEO 소프트웨어 품질 점검.html"
target.write_text(document, encoding="utf-8")
print(f"Wrote {target.name}: {len(FINDINGS)} findings, {len(SOURCES)} source groups, {len(document.encode('utf-8')):,} bytes")
