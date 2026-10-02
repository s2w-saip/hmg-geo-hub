/**
 * 발행물의 **파일 수준** 메타 — sb-data 안에 없는 것들(제목·권/판·발행일·slug).
 * 순수 함수이고 적재 CLI 가 쓴다. 여기 두는 이유는 CLI 를 import 하면 `main()` 이
 * 같이 도는 형태를 피하기 위해서다.
 */

export interface FilenameMeta {
  volume: string | null;
  version: string | null;
  brandScope: string | null;
  publishedOn: string | null;
}

/**
 * 파일명에서 권·판·브랜드 범위·발행일을 읽는다.
 * 예) `HMG-GEO-geo_report_vol.2_v3.0_Global_20260915.html`
 *     → vol.2 · v3.0 · Global · 2026-09-15
 *
 * 못 읽으면 전부 null 이다 — 호출자가 플래그로 채우거나 멈춘다. **추측하지 않는다**:
 * version 은 발행물 유일성 키의 일부라 틀리면 정정 발행이 엉뚱한 행을 덮는다.
 */
export function parseReportFilename(name: string): FilenameMeta {
  const m = /vol\.(\d+(?:\.\d+)?)_v(\d+(?:\.\d+)*)_([A-Za-z]+)_(\d{4})(\d{2})(\d{2})/.exec(name);
  if (!m) return { volume: null, version: null, brandScope: null, publishedOn: null };
  return {
    volume: `vol.${m[1]}`,
    version: `v${m[2]}`,
    brandScope: m[3],
    publishedOn: `${m[4]}-${m[5]}-${m[6]}`,
  };
}

/** 발행 HTML 의 `<title>`. 리포트 제목은 sb-data 에 없다. */
export function parseReportTitle(html: string): string | null {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  return m[1].trim().replace(/\s+/g, " ") || null;
}

/** 사람이 읽는 발행물 식별자. 예) `vol2-v3.0-global-20260915`. */
export function buildSlug(parts: {
  volume: string | null;
  version: string;
  brandScope: string;
  publishedOn: string | null;
}): string {
  return [
    parts.volume?.replace(/\./g, ""),
    parts.version,
    parts.brandScope.toLowerCase(),
    (parts.publishedOn ?? "").replace(/-/g, ""),
  ]
    .filter(Boolean)
    .join("-");
}
