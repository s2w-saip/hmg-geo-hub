// 측정 기준(시계열 버킷 폭) 공용 상수/파서 — server·client 양쪽에서 import.
// measurement-basis-control.tsx 는 "use client" 라, 거기서 export 한 함수를 서버
// 컴포넌트(page.tsx)가 호출하면 "client function from the server" 런타임 에러가
// 난다. 순수 파싱 로직은 이 비-client 모듈에 두어 양쪽이 안전하게 쓴다.
//
// 2026-06-22: 일별 옵션 폐기. 측정주기가 주 단위 cadence라 일별 버킷은 빈
// 점이 너무 많아 노이즈가 됨 — 주별 단일로 고정. URL ?bucket=day 가 들어와도
// 무시하고 주별로 fallback (북마크/공유 링크 호환).
export const BUCKET_UNITS = ["week"] as const;
export type BucketUnitParam = (typeof BUCKET_UNITS)[number];
export const DEFAULT_BUCKET: BucketUnitParam = "week";

// ?bucket URL 파라미터 → 버킷 폭. 항상 주별 (다른 값은 무시).
export function readBucketParam(
  _value: string | string[] | undefined,
): BucketUnitParam {
  return DEFAULT_BUCKET;
}
