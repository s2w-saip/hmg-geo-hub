import fsMod from "node:fs";
import pathMod from "node:path";
import { describe, expect, it } from "vitest";
import { buildSlug, parseReportFilename, parseReportTitle } from "./publication-meta";

describe("parseReportFilename", () => {
  it("실제 9/11 발행물 파일명을 읽는다", () => {
    expect(parseReportFilename("HMG-GEO-geo_report_vol.2_v3.0_Global_20260915.html")).toEqual({
      volume: "vol.2",
      version: "v3.0",
      brandScope: "Global",
      publishedOn: "2026-09-15",
    });
  });

  it("브랜드 판과 구버전 파일명도 읽는다", () => {
    expect(parseReportFilename("HMG-GEO-geo_report_vol.1_v2.8_Hyundai_20260910.html")).toMatchObject({
      volume: "vol.1",
      version: "v2.8",
      brandScope: "Hyundai",
      publishedOn: "2026-09-10",
    });
    expect(parseReportFilename("HMG-GEO-web_geo_status_report_vol.2_v2.5.1_Kia_20260906.html")).toMatchObject({
      version: "v2.5.1",
      brandScope: "Kia",
    });
  });

  it("못 읽으면 **추측하지 않고** 전부 null 이다", () => {
    // version 은 발행물 유일성 키의 일부다 — 틀리면 정정 발행이 엉뚱한 행을 덮는다.
    for (const n of ["report.html", "vol.2_Global.html", "v3.0_Global_20260915.html", ""]) {
      expect(parseReportFilename(n), n).toEqual({
        volume: null,
        version: null,
        brandScope: null,
        publishedOn: null,
      });
    }
  });
});

describe("parseReportTitle", () => {
  it("title 을 읽고 공백을 접는다", () => {
    expect(parseReportTitle("<html><head><title>HMG GEO Report — Vol. 2 · Global</title>")).toBe(
      "HMG GEO Report — Vol. 2 · Global",
    );
    expect(parseReportTitle("<title>\n  두 줄\n  제목\n</title>")).toBe("두 줄 제목");
  });

  it("없거나 비었으면 null", () => {
    expect(parseReportTitle("<html><body>x</body></html>")).toBeNull();
    expect(parseReportTitle("<title>   </title>")).toBeNull();
  });
});

describe("buildSlug", () => {
  it("9/11 발행물의 slug", () => {
    expect(
      buildSlug({ volume: "vol.2", version: "v3.0", brandScope: "Global", publishedOn: "2026-09-15" }),
    ).toBe("vol2-v3.0-global-20260915");
  });

  it("빠진 조각은 건너뛴다 (빈 마디가 생기지 않는다)", () => {
    expect(buildSlug({ volume: null, version: "v3.0", brandScope: "Kia", publishedOn: null })).toBe(
      "v3.0-kia",
    );
  });
});

// ── 적재 CLI 인자 가드 (2026-09-20 검증 주의 5) ─────────────────────────────
//
// `--no-verify` 를 **값 없이** 주면 사유 없는 우회가 되고 `verify_note` 가 빈 문자열로
// 남는다. docs/development-guide.md 업로드 게이트의 "사유 없으면 거부" 자세와 어긋나므로 거부한다.
// CLI 모듈은 import 시 `main()` 이 돌기 때문에, 규약을 **소스로** 고정한다.
describe("ingest CLI — --no-verify 는 사유를 요구한다", () => {
  const src = fsMod.readFileSync(
    pathMod.resolve(__dirname, "..", "..", "scripts", "reports", "ingest-publication.ts"),
    "utf8",
  );

  it("빈 값이면 던진다", () => {
    expect(src).toContain('if (flags.has("no-verify") && !(flags.get("no-verify") ?? "").trim())');
    expect(src).toContain("--no-verify 에는 사유를 값으로 넣어야 한다");
  });

  it("빈 문자열로 뭉개던 종전 형태가 남아 있지 않다", () => {
    expect(src).not.toContain('flags.get("no-verify") || ""');
  });
});
