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
import { countryName } from "@/lib/geo-catalog/country-name";
import { languageName } from "@/lib/geo-catalog/language-name";
import type {
  WebsitePromptViewRow,
  WebsitePromptSortKey,
} from "@/lib/db/repositories/website-sites";
import { WebsitePromptExportButton } from "./export-button";

// 정렬·검색·페이징을 URL 파라미터로 둔다(로컬 state 아님). 이 화면의 필터 패널
// (DimensionFilterPanel)이 이미 URL 을 상태로 쓰고, 서버 컴포넌트가 searchParams
// 로 질의하므로 — 같은 곳에 두지 않으면 필터를 바꿀 때 정렬/페이지가 조용히
// 사라지거나(로컬 state 리셋) 반대로 남아있으면 안 되는데 남는다.
// 공유·새로고침에도 화면이 그대로 재현된다.

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Keyset paging of the backend API source (decision D5, unit U8). The API has no offsets:
 * "next" writes ?cursor=<nextCursor> (and ?page=N+1, kept for the "page X / N" and range
 * labels), "previous" goes back in history (page 2 -> the first page directly, so a shared
 * link still has a way back). Jumping to an arbitrary page is not possible (known_diff U8-N13).
 */
export interface CursorPaging {
  nextCursor: string | null;
}

export function WebsitePromptTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  dir,
  cursorPaging,
}: {
  rows: WebsitePromptViewRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: WebsitePromptSortKey;
  dir: "asc" | "desc";
  cursorPaging?: CursorPaging;
}) {
  const t = useTranslations("website.prompts");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  // ISO/BCP-47 코드 → 지역화된 이름. URL·DB 값은 코드 그대로 두고 표시만 번역한다
  // (DimensionFilterPanel 의 geography/language 축과 같은 규약).
  //
  // 2026-09-16: 이 화면은 종전에 Intl.DisplayNames 를 **인라인으로 다시 구현**했고
  // (의사코드 폴백·대문자 정규화까지 손으로 복제), 엑셀 내보내기는 lib/geo-catalog
  // 를 썼다. 현실 값 공간(국가 21종·언어 13종 × ko/en)에서 결과 차이는 0 이었지만
  // 화면과 엑셀이 **우연히** 같은 상태였다 — 정본 한 벌로 합쳐 구조적으로 같게 한다.
  // (모르는 코드 폴백 "worldwide"·"middleeast" 는 정본도 동일하게 원문을 돌려준다.)
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
        p.delete("cursor");
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
      p.delete("cursor");
    });
  };

  const goPage = (n: number) => push((p) => p.set("page", String(n)));
  const goNext = () => {
    if (!cursorPaging) return goPage(page + 1);
    const next = cursorPaging.nextCursor;
    if (!next) return;
    push((p) => {
      p.set("cursor", next);
      p.set("page", String(page + 1));
    });
  };
  const goPrev = () => {
    if (!cursorPaging) return goPage(page - 1);
    if (page <= 2) {
      push((p) => {
        p.delete("cursor");
        p.delete("page");
      });
      return;
    }
    router.back();
  };

  const headerProps = (key: WebsitePromptSortKey) => ({
    active: sort === key,
    asc: sort === key && dir === "asc",
    onClick: () => toggleSort(key),
  });

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const nextDisabled = cursorPaging ? !cursorPaging.nextCursor : page >= pages;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

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
        {/* 내보내기 — 화면에 걸린 필터 그대로, 현재 페이지가 아니라 전량.
            링크라서 URL 이 곧 술어다(export-button.tsx 머리 주석). */}
        <WebsitePromptExportButton disabled={total === 0} />
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
                    {countryName(r.countryCode, locale)}
                  </td>
                  <td className="px-3 py-3 text-xs whitespace-nowrap text-muted-foreground">
                    {languageName(r.langCode, locale)}
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
            onClick={goPrev}
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
            disabled={nextDisabled}
            onClick={goNext}
          >
            {t("next")}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
