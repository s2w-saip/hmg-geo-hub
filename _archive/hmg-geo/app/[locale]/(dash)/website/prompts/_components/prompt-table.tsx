"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter, usePathname } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SortableHeader } from "@/components/ui/sortable-header";
import { pseudoCountryLabel } from "@/lib/geo-catalog/pseudo-country";
import type {
  WebsitePromptViewRow,
  WebsitePromptSortKey,
} from "@/lib/db/repositories/website-sites";

// 정렬·검색·페이징을 URL 파라미터로 둔다(로컬 state 아님). 이 화면의 필터 패널
// (DimensionFilterPanel)이 이미 URL 을 상태로 쓰고, 서버 컴포넌트가 searchParams
// 로 질의하므로 — 같은 곳에 두지 않으면 필터를 바꿀 때 정렬/페이지가 조용히
// 사라지거나(로컬 state 리셋) 반대로 남아있으면 안 되는데 남는다.
// 공유·새로고침에도 화면이 그대로 재현된다.

const SEARCH_DEBOUNCE_MS = 300;

export function WebsitePromptTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  dir,
}: {
  rows: WebsitePromptViewRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: WebsitePromptSortKey;
  dir: "asc" | "desc";
}) {
  const t = useTranslations("website.prompts");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  // ISO/BCP-47 코드 → 지역화된 이름. URL·DB 값은 코드 그대로 두고 표시만 번역한다
  // (DimensionFilterPanel 의 geography/language 축과 같은 규약).
  const regionFmt = useMemo(
    () => new Intl.DisplayNames([locale], { type: "region" }),
    [locale],
  );
  const langFmt = useMemo(
    () => new Intl.DisplayNames([locale], { type: "language" }),
    [locale],
  );
  const dateFmt = useMemo(
    // timeZone 고정 — 서버(Vercel=UTC)/브라우저(KST)에서 날짜가 경계를 넘는
    // timestamp에도 동일 달력일로 렌더돼 하이드레이션 불일치(#418)를 막는다.
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Asia/Seoul" }),
    [locale],
  );

  const push = (mutate: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(sp.toString());
    mutate(next);
    startTransition(() => {
      router.push(`${pathname}?${next.toString()}`, { scroll: false });
    });
  };

  // ── 검색: 디바운스 후 URL 에 반영 ────────────────────────────────────────
  const urlQuery = sp.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  // 뒤로가기/필터 리셋으로 URL 의 q 가 바뀌면 입력창도 따라가야 한다.
  useEffect(() => setQuery(urlQuery), [urlQuery]);
  useEffect(() => {
    if (query === urlQuery) return;
    const id = setTimeout(() => {
      push((p) => {
        if (query.trim()) p.set("q", query.trim());
        else p.delete("q");
        p.delete("page"); // 검색이 바뀌면 1페이지부터 — 그대로 두면 빈 페이지가 뜬다
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, urlQuery]);

  const toggleSort = (key: WebsitePromptSortKey) => {
    push((p) => {
      const nextDir = sort === key && dir === "desc" ? "asc" : "desc";
      p.set("sort", key);
      p.set("dir", nextDir);
      p.delete("page");
    });
  };

  const goPage = (n: number) => push((p) => p.set("page", String(n)));

  const headerProps = (key: WebsitePromptSortKey) => ({
    active: sort === key,
    asc: sort === key && dir === "asc",
    onClick: () => toggleSort(key),
  });

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  // 코드가 이름으로 안 풀리면(비표준 값: "worldwide", "middleeast") 코드를 그대로
  // 보여준다 — Intl 은 모르는 코드에 입력값을 그대로 돌려주므로 별도 분기 불필요.
  const countryName = (code: string) => {
    // 의사 코드(SA-Dammam·CN-BJ)는 정본 라벨 — Intl 은 예외를 내 원문 코드가 노출된다.
    const pseudo = pseudoCountryLabel(code, locale);
    if (pseudo) return pseudo;
    try {
      return regionFmt.of(code.toUpperCase()) ?? code;
    } catch {
      return code;
    }
  };
  const languageName = (code: string) => {
    try {
      return langFmt.of(code) ?? code;
    } catch {
      return code;
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 검색 + 건수 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="h-8 w-72 pl-8 text-sm"
          />
        </div>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {t("rangeLabel", { from, to, total })}
        </span>
      </div>

      {/* 렌즈 안내 — 엔진·기간이 왜 행 수를 안 바꾸는지. 이 문장이 없으면
          "필터를 걸었는데 9,569행 그대로"가 버그로 읽힌다. */}
      <p className="rounded-md border border-border bg-bg-soft px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{t("lensTitle")}</span> — {t("lensHint")}
      </p>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("emptyHint")}</p>
        </div>
      ) : (
        // 컬럼이 많아 좁은 뷰포트에서 넘친다 — 잘리는 대신 테이블 자체 가로 스크롤
        // (페이지 body 는 스크롤 안 생김). 프롬프트 텍스트에 min-w 로 자리 확보.
        <div
          className={
            "overflow-x-auto rounded-md border border-border bg-card transition-opacity " +
            (pending ? "opacity-60" : "opacity-100")
          }
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                <th className="min-w-72 px-3 py-2">
                  <SortableHeader {...headerProps("prompt")}>{t("promptLabel")}</SortableHeader>
                </th>
                <th className="w-24 px-3 py-2">
                  <SortableHeader {...headerProps("brand")}>{t("brandLabel")}</SortableHeader>
                </th>
                <th className="w-28 px-3 py-2">
                  <SortableHeader {...headerProps("country")}>{t("countryLabel")}</SortableHeader>
                </th>
                <th className="w-24 px-3 py-2">
                  <SortableHeader {...headerProps("lang")}>{t("langLabel")}</SortableHeader>
                </th>
                <th className="min-w-48 px-3 py-2">
                  <SortableHeader {...headerProps("targetUrl")}>
                    {t("targetUrlLabel")}
                  </SortableHeader>
                </th>
                <th className="w-24 px-3 py-2">
                  <SortableHeader {...headerProps("answers")} align="right">
                    {t("answersLabel")}
                  </SortableHeader>
                </th>
                <th className="w-32 px-3 py-2">
                  <SortableHeader {...headerProps("lastMeasuredAt")}>
                    {t("lastMeasuredLabel")}
                  </SortableHeader>
                </th>
                <th className="w-32 px-3 py-2">{t("enginesLabel")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border align-top first:border-t-0">
                  <td className="px-3 py-3 text-sm text-foreground">{r.promptText}</td>
                  <td className="px-3 py-3">
                    <Badge variant="outline" className="text-[10px] whitespace-nowrap">
                      {r.brand}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-xs whitespace-nowrap text-muted-foreground">
                    {countryName(r.countryCode)}
                  </td>
                  <td className="px-3 py-3 text-xs whitespace-nowrap text-muted-foreground">
                    {languageName(r.langCode)}
                  </td>
                  <td className="px-3 py-3">
                    {/* 열람 전용 화면이지만 타겟 URL 은 실제 페이지 확인이 목적이라
                        링크로 연다. 외부 도메인이므로 noreferrer. */}
                    <a
                      href={r.targetUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs break-all text-brand-700 underline-offset-2 hover:underline"
                    >
                      {r.targetUrl}
                    </a>
                  </td>
                  <td className="px-3 py-3 text-right text-xs tabular-nums text-foreground">
                    {r.answers > 0 ? r.answers.toLocaleString(locale) : "—"}
                  </td>
                  <td className="px-3 py-3 text-xs whitespace-nowrap text-muted-foreground">
                    {r.lastMeasuredAt ? (
                      dateFmt.format(new Date(r.lastMeasuredAt))
                    ) : (
                      <span className="text-muted-foreground">{t("notMeasured")}</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {r.engines.length ? (
                        r.engines.map((e) => (
                          <Badge
                            key={e}
                            variant="outline"
                            className="text-[10px] text-muted-foreground"
                          >
                            {e}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 ? (
        <div className="flex items-center justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={page <= 1}
            onClick={() => goPage(page - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            {t("prev")}
          </Button>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {t("pageOf", { page, pages })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={page >= pages}
            onClick={() => goPage(page + 1)}
          >
            {t("next")}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
