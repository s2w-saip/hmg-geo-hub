// 측정 개요 카드 — 필터바 오른쪽에 붙는 좁은 카드(디자인 327:116 상단 우측).
//
// 세 숫자의 출처가 다르다는 것이 이 카드의 요점이다:
//   적용 = 카탈로그(prompts) 에서 프롬프트 축 필터로 센 수 — "측정 대상"
//   측정 = 미러에 답변이 있는 프롬프트 수 — "실제로 측정된 것"
//   미측정 = 적용 − 측정
// 어느 한쪽이 null(집계 degrade·측정 없음)이면 그 칸은 "—" 로 남고 뺄셈도 하지
// 않는다 — 0 으로 위장하면 "다 측정됐다"로 읽힌다.

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { promptCoverage } from "../_data/kpi-view";

export async function MeasurementOverviewCard({
  applied,
  measured,
  appliedHref,
  unmeasuredAction,
  conditional = false,
  extraRows = [],
}: {
  applied: number | null;
  measured: number | null;
  /** 적용 프롬프트 수를 프롬프트 목록으로 연결(피그마 ↗ 아이콘). 없으면 텍스트만. */
  appliedHref?: string;
  /** 미측정 행 우측 액션(미측정 프롬프트 모달 트리거). 호출부가 클라이언트 컴포넌트를 넘긴다. */
  unmeasuredAction?: ReactNode;
  /** 인용 화면(571:380)이 덧붙이는 행 — 전체 인용 수·인용 도메인 수. 라벨은 호출부가 번역해 넘긴다. */
  extraRows?: Array<{ key: string; label: string; value: number | null }>;
  /**
   * 답변 축(지역·엔진·기간)이 걸려 있는가. 걸려 있으면 "적용 − 측정"은
   * 미측정이 아니라 "이 조건에서 안 잡힌 것"이라 뺄셈을 멈추고 문구를 바꾼다
   * (2026-09-01 verifier 지적 F2).
   */
  conditional?: boolean;
}) {
  const t = await getTranslations("answerAnalysis.mentions.kpi.overview");
  const c = promptCoverage(applied, measured, { conditional });
  type Row = { key: string; label: string; value: number | null; href?: string; action?: ReactNode };
  const rows: Row[] = [
    { key: "applied", label: t("applied"), value: c.applied, href: appliedHref },
    {
      key: "measured",
      label: c.conditional ? t("measuredConditional") : t("measured"),
      value: c.measured,
    },
  ];
  if (!c.conditional) {
    rows.push({ key: "unmeasured", label: t("unmeasured"), value: c.unmeasured, action: unmeasuredAction });
  }
  for (const r of extraRows) rows.push(r);
  return (
    <aside className="flex h-full w-full shrink-0 flex-col justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 shadow-soft lg:w-[274px]">
      <h2 className="text-xs font-normal tracking-wide text-muted-foreground uppercase">
        {t("title")}
      </h2>
      <dl className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-baseline justify-between gap-2">
            <dt className="text-xs font-normal text-muted-foreground">{r.label}</dt>
            {/* QA 2차 #4·#5 — 라벨·값을 같은 크기(text-xs)·볼드 없음으로 통일하고
                한 줄 안에서 baseline 정렬(부모 flex items-baseline). */}
            <dd className="inline-flex items-baseline gap-1 text-xs font-normal tabular-nums text-foreground">
              {r.value == null ? "—" : t("unit", { n: r.value })}
              {r.href && r.value != null ? (
                <Link
                  href={r.href}
                  aria-label={t("appliedLinkAria")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </Link>
              ) : null}
              {r.action}
            </dd>
          </div>
        ))}
      </dl>
      {c.conditional ? (
        <p className="text-[10px] leading-tight text-muted-foreground">{t("conditionalNote")}</p>
      ) : null}
    </aside>
  );
}

/**
 * Suspense 폴백 전용 — **동기** 컴포넌트여야 한다.
 *
 * 2026-09-02 프리뷰 실증(React #419): 위 async 카드를 `applied={null}` 로 폴백에
 * 그대로 썼더니, 폴백 자체가 getTranslations 로 서스펜드해 React 가 그 경계를
 * 서버에서 완결하지 못했다(HTML 에 `<template id="B:9">` 가 `$RC` 없이 남고
 * `P:` 아웃라인 폴백만 뜸) → 클라이언트가 경계를 다시 그리며 #419 를 던졌다.
 * 화면엔 값이 결국 뜨지만 매 로드마다 콘솔 오류 1건 + 재렌더 비용이 든다.
 * 로컬 dev 에선 번역 로더가 즉시 풀려 재현되지 않았다 — Vercel 에서만 보였다.
 * 폴백은 텍스트 없는 자리표시자로 두고(번역 대기 없음) 프레임 크기만 맞춘다.
 */
export function MeasurementOverviewCardSkeleton() {
  return (
    <aside
      aria-busy="true"
      className="flex h-full w-full shrink-0 flex-col justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 shadow-soft lg:w-[274px]"
    >
      <div className="h-3 w-16 animate-pulse rounded bg-muted" />
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-baseline justify-between gap-2">
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-4 w-12 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </aside>
  );
}
