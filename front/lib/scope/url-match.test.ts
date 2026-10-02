import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { targetMatchSql } from "./url-match-sql";
import { matchesTargetUrl, matchesTargetUrlNorm, normalizeUrlForMatch } from "./url-match";

// Pure JS half of the SQL↔JS normalization parity. The SQL side (cnorm) is
// checked against a live DB by scripts/scope/verify-url-match.ts; this keeps the
// JS behavior pinned in the fast unit suite.
describe("normalizeUrlForMatch", () => {
  it("strips scheme, leading www., trailing slashes", () => {
    expect(normalizeUrlForMatch("https://www.kia.com/it/")).toBe("kia.com/it");
    expect(normalizeUrlForMatch("HTTP://Kia.com/IT///")).toBe("kia.com/it");
    expect(normalizeUrlForMatch("  https://www.hyundai.com  ")).toBe("hyundai.com");
  });

  it("drops the URL fragment, incl. #:~:text= scroll-to-text (client-only)", () => {
    const clean = "hyundai.com/worldwide/en/company/innovation/design";
    expect(
      normalizeUrlForMatch(
        "https://www.hyundai.com/worldwide/en/company/innovation/design#:~:text=Design-,philosophy,solutions%20with%20captivating%20emotional%20appeal.",
      ),
    ).toBe(clean);
    // ± fragment → same key (so citations dedup / KPI⑥ match as one URL)
    expect(normalizeUrlForMatch("https://www.hyundai.com/worldwide/en/company/innovation/design")).toBe(clean);
  });

  it("strips fragment before trailing slash (order matters)", () => {
    expect(normalizeUrlForMatch("https://kia.com/it/#:~:text=foo")).toBe("kia.com/it");
    expect(normalizeUrlForMatch("https://kia.com/it/#section")).toBe("kia.com/it");
  });

  // 자원을 식별하는 쿼리는 다른 URL로 남긴다 — 이게 원래 정책.
  it("keeps resource-identifying query strings (a distinct URL)", () => {
    expect(normalizeUrlForMatch("https://youtube.com/watch?v=abc")).toBe("youtube.com/watch?v=abc");
    expect(normalizeUrlForMatch("https://news.example.com/read?articleId=7")).toBe(
      "news.example.com/read?articleId=7".toLowerCase(),
    );
  });

  // …단, 유입 경로만 기록하는 파라미터는 같은 페이지다. AI 엔진이 붙이는
  // utm_source=chatgpt.com 을 남기면 KPI⑥ 타겟 URL 등호 비교가 통째로 어긋난다.
  it("strips tracking params, preserving the '?' for surviving params", () => {
    expect(normalizeUrlForMatch("https://kia.com/it?utm=a")).toBe("kia.com/it");
    expect(normalizeUrlForMatch("https://kia.com/sg/x.html?utm_source=chatgpt.com")).toBe(
      "kia.com/sg/x.html",
    );
    expect(normalizeUrlForMatch("https://kia.com/it/?msockid=3564f27c")).toBe("kia.com/it");
    // 선두 트래킹 파라미터를 지워도 뒤따르는 파라미터의 '?' 자리가 유지된다
    expect(normalizeUrlForMatch("https://y.com/watch?utm_source=x&utm_medium=y&v=abc")).toBe(
      "y.com/watch?v=abc",
    );
    expect(normalizeUrlForMatch("https://y.com/watch?v=abc&utm_source=x")).toBe("y.com/watch?v=abc");
  });

  // 경로 안의 '&' 는 구분자가 아니므로 어느 패스에도 걸리면 안 된다
  it("never rewrites '&' inside a path", () => {
    expect(normalizeUrlForMatch("https://a.com/tom&jerry")).toBe("a.com/tom&jerry");
  });

  it("empty/nullish → empty string", () => {
    expect(normalizeUrlForMatch("")).toBe("");
    expect(normalizeUrlForMatch(null)).toBe("");
    expect(normalizeUrlForMatch(undefined)).toBe("");
  });
});

// ── 타겟 일치 — 정규화 후 **정확 일치** (2026-09-20 제품 결정) ───────────────
// 리포트(scripts/reports/extract-citation-data.mts:97)의 `c3.tn = NORM_T(target_url)`
// 과 같은 비교다. 2026-09-17(GGMD-61)의 완화(인용 쿼리 제거 + `.html`/`.htm` 동치)는
// 리포트보다 분자를 부풀려 철회됐다 — 아래 두 케이스가 그 완화의 지문이고, 지금은
// 전부 **불일치**여야 한다.
// SQL 쌍둥이(url-match-sql::targetMatchSql)와 같은 사례를 scripts/scope/
// verify-url-match.ts §C 가 실 DB 로 돌려 두 구현의 일치를 강제한다.
describe("matchesTargetUrl — 정규화 후 정확 일치", () => {
  const kiaBuild = "https://www.kia.com/us/en/telluride/build";

  it("정규화가 흡수하는 차이(scheme·www·끝 슬래시·프래그먼트)는 일치", () => {
    expect(matchesTargetUrl(kiaBuild, kiaBuild)).toBe(true);
    expect(matchesTargetUrl("http://kia.com/us/en/telluride/build/", kiaBuild)).toBe(true);
    expect(matchesTargetUrl(`${kiaBuild}#gallery`, kiaBuild)).toBe(true);
  });

  // GGMD-61 완화의 지문 ① — 인용에 붙은 비(非)트래킹 쿼리. 제네시스 사이트의
  // 리포트 대비 과다 집계가 여기서 나왔다.
  it("인용에 남은 쿼리는 다른 URL 이다 (쿼리를 떼어 맞추지 않는다)", () => {
    expect(matchesTargetUrl(`${kiaBuild}?step=trim-selection`, kiaBuild)).toBe(false);
    expect(matchesTargetUrl(`${kiaBuild}/?moveto=top`, kiaBuild)).toBe(false);
  });

  // GGMD-61 완화의 지문 ② — `.html`/`.htm` 유무 차이.
  it("끝의 .html/.htm 유무 차이는 다른 URL 이다", () => {
    const t = "https://www.hyundai.com/worldwide/en/news/neolun-concept";
    expect(matchesTargetUrl(`${t}.html`, t)).toBe(false);
    expect(matchesTargetUrl(`${t}.htm`, t)).toBe(false);
    expect(matchesTargetUrl(t, `${t}.html`)).toBe(false);
    expect(matchesTargetUrl(`${t}.html?lang=fr`, t)).toBe(false);
    // 같은 확장자끼리는 그대로 일치한다.
    expect(matchesTargetUrl(`${t}.html`, `${t}.html`)).toBe(true);
  });

  it("자원을 가르는 쿼리는 값이 같을 때만 일치", () => {
    const base = "https://news.example.com/read";
    expect(matchesTargetUrl(`${base}?id=A`, `${base}?id=A`)).toBe(true);
    expect(matchesTargetUrl(`${base}?id=B`, `${base}?id=A`)).toBe(false);
    expect(matchesTargetUrl(base, `${base}?id=A`)).toBe(false);
  });

  it("하위 경로는 도달이 아니다", () => {
    const t = "https://www.kia.com/us/en/vehicles";
    expect(matchesTargetUrl(`${t}/fleet`, t)).toBe(false);
    expect(matchesTargetUrl("https://www.kia.com/us/en/vehiclesxyz", t)).toBe(false);
  });

  it("빈 타겟·빈 인용은 항상 불일치", () => {
    expect(matchesTargetUrl("", kiaBuild)).toBe(false);
    expect(matchesTargetUrl(kiaBuild, "")).toBe(false);
    expect(matchesTargetUrlNorm("", "")).toBe(false);
  });

  it("트래킹 파라미터는 정규화 단계에서 이미 사라진다", () => {
    expect(matchesTargetUrl(`${kiaBuild}?utm_source=chatgpt.com`, kiaBuild)).toBe(true);
  });
});

// ── SQL 쌍둥이의 **본문**을 고정한다 (검증자 F-2) ───────────────────────────
// 형태 가드(citation-norm-once)는 `CASE WHEN position('?' in …)` 머리만 세므로
// 분기 본문이 바뀌어도 초록이었다. 여기서는 컴파일된 식 전문을 못 박는다 —
// 이 텍스트가 바뀌면 verify:url-match 의 실 DB 사례도 함께 갱신해야 한다.
describe("targetMatchSql — 컴파일된 SQL 본문", () => {
  const compiled = new PgDialect().sqlToQuery(targetMatchSql(sql.raw("c"), sql.raw("t")));

  it("바인드 파라미터를 내지 않는다 (verify 스크립트가 그대로 splice 한다)", () => {
    expect(compiled.params).toEqual([]);
  });

  it("빈 값 가드 → 등치 하나 (완화 분기가 되살아나면 실패한다)", () => {
    const normalized = compiled.sql.replace(/\s+/g, " ").trim();
    expect(normalized).toBe(
      "CASE WHEN coalesce(t, '') = '' OR coalesce(c, '') = '' THEN false " +
        "ELSE c = t END",
    );
    // GGMD-61 완화의 지문 — 되살아나면 리포트와 다시 갈라진다.
    expect(normalized).not.toContain("position('?'");
    expect(normalized).not.toContain("\\.html?$");
  });

  it("인자 식을 그대로 심는다 (컬럼 참조를 넘기면 컬럼 참조가 박힌다)", () => {
    const q = new PgDialect().sqlToQuery(
      targetMatchSql(sql.raw("cit.cnorm"), sql.raw("wp.turl")),
    );
    expect(q.sql).toContain("coalesce(wp.turl, '')");
    expect(q.sql).toContain("ELSE cit.cnorm = wp.turl END");
  });
});
