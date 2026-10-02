// 섹션 도착 마커 (T18 성능 프로브 보조).
//
// 스트리밍 SSR 에서 Suspense 경계는 완성되는 순서대로 청크로 흘러나온다. 프로브는
// HTML 바이트를 읽으며 "언제 무엇이 도착했는지"를 재야 P2(첫 카드)·P3(섹션 최장)를
// 낼 수 있는데, 청크 안의 마크업만 보고는 어느 섹션인지 알 수 없다 — 그래서 각
// 경계의 내용 끝에 이 표식을 하나 둔다.
//
// 형태를 `display:none` 요소로 잡은 이유: HTML 주석은 React 트리에서 만들려면
// `dangerouslySetInnerHTML` 래퍼가 필요해 어차피 요소가 하나 생기고, 요소 쪽이
// 테스트·쿼리(`[data-hmg-section-done]`)로도 잡힌다. 프로덕션 사용자에게는
// 렌더링·레이아웃 영향이 없다(flex/grid 는 `display:none` 을 아이템으로 세지 않는다).
//
// ⚠️ 경계 **안**에, 그리고 async 자식 **뒤**에 두어야 한다. Suspense 는 자식이 전부
// 준비된 뒤에야 그 경계를 내보내므로, 같은 경계 안에 있으면 마커는 섹션 내용과
// **같은 청크**로 도착한다. 경계 밖에 두면 셸과 함께 즉시 나가 의미가 없다.
export function SectionDoneMarker({ id }: { id: string }) {
  return <div hidden data-hmg-section-done={id} />;
}
