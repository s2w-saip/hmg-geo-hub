/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

// Purchase Context Map — node/graph view (HMG-integrated redesign, 2026-06).
//
// Ported from aeorank's social-scraping "context-map" force-graph view, then
// reworked to belong in the HMG dashboard:
//   • LIGHT surface — the canvas is warm sand (#f6f3f2 = bg-soft), seamless with
//     the page; no pasted-in dark block. Nodes use the HMG navy↔gold bipartite
//     palette (build-graph.ts).
//   • One header path — the page header + tab already title this; the in-card
//     header is replaced by a slim toolbar (keyword chip + a single de-duped
//     stat strip). The old sidebar stat block (which repeated sources 3× /
//     workers 2×) is gone.
//   • Readable graph — driven_by/combination links are ghosted at rest and
//     REVEAL (curved, arrowed) only for a selected node's island; driven_by
//     exerts zero force so the navy-left / gold-right split stays legible.
//   • Korean chrome via next-intl (useTranslations). Data stays in
//     sample-matrix.ts. Canvas-draw hex literals are the one sanctioned
//     exception (the canvas API needs literals; they map to @theme tokens).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { Loader2, RotateCcw, Sliders } from "lucide-react";
import { forceCollide } from "d3";
import {
  buildContextGraph,
  BRANCH_COLORS,
  COMBINATION_COLORS,
  COND_CAT_COLOR,
  COND_NODE_COLOR,
  CTX_NODE_COLOR,
  CTX_THEME_COLOR,
  KEYWORD_COLOR,
} from "./build-graph";
import { MOCK_KEYWORD, MOCK_MATRIX } from "./sample-matrix";
import type {
  EnrichedAttribute,
  EnrichedCombination,
  EnrichedContext,
  EnrichedContextMatrix,
  EvidenceQuote,
  PerspectiveBreakdown,
} from "./types";

const ForceGraphCanvas = dynamic(() => import("./force-graph-canvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-bg-soft">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  ),
});

export function ContextNodeMapView({
  matrix = MOCK_MATRIX,
  keyword = MOCK_KEYWORD,
}: {
  matrix?: EnrichedContextMatrix;
  keyword?: string;
}) {
  const t = useTranslations("customerInterestSocialScraping.contextMap");

  const contextGraphData = useMemo(
    () => buildContextGraph(keyword, matrix),
    [keyword, matrix],
  );
  const enrichedCombinations = matrix.combinations || [];

  const statStrip = [
    { n: matrix.total_contexts_found, label: t("stat.contexts") },
    { n: matrix.total_conditions_found, label: t("stat.conditions") },
    { n: matrix.enrichment_stats.total_relationships, label: t("stat.relations") },
    { n: matrix.enrichment_stats.total_sources, label: t("stat.sources") },
    { n: matrix.enrichment_stats.total_workers, label: t("stat.workers") },
  ];

  // ─── View state ──────────────────────────────────────────────────────────
  const [highlightedAttr, setHighlightedAttr] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(new Set());
  const [expandedThemes, setExpandedThemes] = useState<Set<number>>(new Set());
  const [selectedAttr, setSelectedAttr] = useState<
    (EnrichedAttribute & { _categoryName: string }) | null
  >(null);
  const [selectedCtx, setSelectedCtx] = useState<
    (EnrichedContext & { _themeName: string }) | null
  >(null);
  const [selectedCombo, setSelectedCombo] = useState<EnrichedCombination | null>(null);
  const [perspectiveFilter, setPerspectiveFilter] = useState<
    "all" | "buyer" | "seller" | "neutral"
  >("all");
  const [hoveredNode, setHoveredNode] = useState<any | null>(null);

  // 관점 필터 + 정렬을 렌더 밖으로.
  //
  // 이전 동작: 필터가 거르지 않고 opacity-25 로 흐리게만 했다. 행은 DOM 에 남고
  // 그룹 헤더의 개수도 그대로라, "긍정"을 골라도 여전히 전체 개수가 보이고 목록을
  // 눈으로 훑어야 했다 — 필터라기보다 강조에 가까웠다. 이제 실제로 제외하고,
  // 개수도 필터를 반영하며, 남는 게 없는 그룹은 통째로 빠진다.
  //
  // 정렬도 여기로: 렌더 본문의 `[...theme.contexts].sort(...)` 는 리렌더마다 배열을
  // 새로 만들고 다시 정렬했다.
  //
  // originalIndex 를 들고 다니는 이유: 노드 id 가 `ctx-<ti>-<원본인덱스>` 라서
  // 필터 후 위치로 계산하면 그래프 하이라이트가 엉뚱한 노드를 가리킨다. 이전 코드는
  // `contexts.findIndex(c => c.name === item.name)` 로 매 행마다 O(n) 이름 조회를
  // 했는데, 이름이 겹치면 첫 번째로 잘못 붙는다.
  const inPerspective = useCallback(
    (pb: PerspectiveBreakdown | undefined) =>
      perspectiveFilter === "all" || (pb?.[perspectiveFilter] ?? 0) > 0,
    [perspectiveFilter],
  );

  const visibleThemes = useMemo(
    () =>
      matrix.context_themes
        .map((theme, ti) => ({
          theme,
          ti,
          contexts: theme.contexts
            .map((ctx, originalIndex) => ({ ctx, originalIndex }))
            .filter(({ ctx }) => inPerspective(ctx.perspective_breakdown))
            .sort((a, b) => b.ctx.mention_count - a.ctx.mention_count),
        }))
        .filter((t) => t.contexts.length > 0),
    [matrix.context_themes, inPerspective],
  );

  const visibleCategories = useMemo(
    () =>
      matrix.condition_categories
        .map((cat, ci) => ({
          cat,
          ci,
          conditions: cat.conditions
            .map((cond, originalIndex) => ({ cond, originalIndex }))
            .filter(({ cond }) => inPerspective(cond.perspective_breakdown))
            .sort((a, b) => b.cond.mention_count - a.cond.mention_count),
        }))
        .filter((c) => c.conditions.length > 0),
    [matrix.condition_categories, inPerspective],
  );

  // Physics controls (multipliers on top of auto-tuned defaults)
  const [chargeMul, setChargeMul] = useState(1);
  const [linkDistMul, setLinkDistMul] = useState(1);
  const [collideMul, setCollideMul] = useState(1);
  const [linkStrengthMul, setLinkStrengthMul] = useState(1);
  const [physicsPanelOpen, setPhysicsPanelOpen] = useState(false);

  const graphRef = useRef<any>(null);
  const ctxFitDoneRef = useRef(false);
  const graphPanelRef = useRef<HTMLDivElement>(null);

  const [fgReady, setFgReady] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 640, h: 600 });

  useEffect(() => {
    let raf = 0;
    const check = () => {
      if (graphRef.current?.d3Force) setFgReady(true);
      else raf = requestAnimationFrame(check);
    };
    check();
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const el = graphPanelRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setDims({ w: Math.max(320, r.width), h: Math.max(320, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // BFS through SEMANTIC links (driven_by + combination) → connected island,
  // then add parent theme/category. Drives the dim/reveal of nodes + edges.
  const highlightedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!highlightedAttr) return ids;
    const adj = new Map<string, Set<string>>();
    const parentOf = new Map<string, string>();
    const childrenOf = new Map<string, Set<string>>();
    for (const link of contextGraphData.links) {
      const lk = link as any;
      const srcId = typeof lk.source === "object" ? lk.source.id : lk.source;
      const tgtId = typeof lk.target === "object" ? lk.target.id : lk.target;
      if (lk._ctxType === "driven_by" || lk._ctxType === "combination") {
        if (!adj.has(srcId)) adj.set(srcId, new Set());
        if (!adj.has(tgtId)) adj.set(tgtId, new Set());
        adj.get(srcId)!.add(tgtId);
        adj.get(tgtId)!.add(srcId);
      } else {
        parentOf.set(tgtId, srcId);
        if (!childrenOf.has(srcId)) childrenOf.set(srcId, new Set());
        childrenOf.get(srcId)!.add(tgtId);
      }
    }
    const queue = [highlightedAttr];
    ids.add(highlightedAttr);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const neighbor of adj.get(cur) || []) {
        if (!ids.has(neighbor)) {
          ids.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    for (const nodeId of [...ids]) {
      const parent = parentOf.get(nodeId);
      if (parent) ids.add(parent);
    }
    // Selecting a parent (theme/category) spotlights its whole subtree, not
    // just itself — clicking a section node should light up its branch.
    for (const child of childrenOf.get(highlightedAttr) || []) ids.add(child);
    return ids;
  }, [highlightedAttr, contextGraphData]);

  // Force simulation — tuned to keep the bipartite split open (more repulsion,
  // wider links, bigger collide) and, critically, driven_by strength = 0 so
  // cross-links never collapse the two sides into a ball.
  useEffect(() => {
    if (!fgReady || !graphRef.current || contextGraphData.nodes.length === 0) return;
    const fg = graphRef.current;
    if (!fg.d3Force) return;
    ctxFitDoneRef.current = false;

    const childCount = new Map<string, number>();
    for (const link of contextGraphData.links) {
      const lk = link as any;
      if (lk._ctxType === "combination" || lk._ctxType === "driven_by") continue;
      const srcId = typeof lk.source === "object" ? lk.source.id : lk.source;
      childCount.set(srcId, (childCount.get(srcId) || 0) + 1);
    }

    const nodeCount = contextGraphData.nodes.length;
    const baseChargeStrength = -1100 - Math.max(0, nodeCount - 200) * 1.5;
    const chargeStrength = baseChargeStrength * chargeMul;

    const charge = fg.d3Force("charge");
    if (charge) charge.strength(chargeStrength).distanceMax(1000);

    const linkForce = fg.d3Force("link");
    if (linkForce) {
      linkForce
        .distance((link: any) => {
          let base: number;
          if (link._ctxType === "combination") base = 300;
          else if (link._ctxType === "driven_by") base = 240;
          else {
            const srcId = typeof link.source === "object" ? link.source.id : link.source;
            if (srcId === "root") base = 200;
            else {
              const siblings = childCount.get(srcId) || 1;
              base = Math.max(90, Math.min(360, 70 + Math.sqrt(siblings) * 14));
            }
          }
          return base * linkDistMul;
        })
        .strength((link: any) => {
          if (link._ctxType === "combination") return 0;
          if (link._ctxType === "driven_by") return 0; // visual only — no pull
          return Math.max(0, Math.min(1, 0.7 * linkStrengthMul));
        });
    }

    fg.d3Force(
      "collide",
      forceCollide<any>((node: any) => {
        let base: number;
        if (node.type === "keyword" || node.id === "root") base = 28;
        else if (node._ctxType === "category" || node._ctxType === "context_theme")
          base = 55;
        else {
          const r = node.size || 6;
          base = r + 16;
        }
        return base * collideMul;
      })
        .strength(0.8)
        .iterations(1),
    );

    if (fg.d3ReheatSimulation) fg.d3ReheatSimulation();
  }, [fgReady, contextGraphData, chargeMul, linkDistMul, collideMul, linkStrengthMul]);

  return (
    <div className="flex h-[78vh] min-h-[600px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-soft">
      {/* Toolbar — replaces the old in-card header. Keyword chip + one stat strip. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-2">
        <span className="rounded-sm bg-secondary px-2 py-0.5 text-sm font-semibold text-foreground">
          {keyword}
        </span>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {statStrip.map((s, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-border">·</span>}
              <b className="font-semibold text-foreground tabular-nums">{s.n}</b>
              <span className="text-muted-foreground">{s.label}</span>
            </span>
          ))}
          {matrix.enrichment_stats.deep_evidence_linked > 0 && (
            <span className="ml-1 rounded-sm bg-bg-warm px-1.5 py-0.5 text-[10px] font-semibold text-accent-gold">
              {t("badge.deepEvidence")} {matrix.enrichment_stats.deep_evidence_linked}
            </span>
          )}
        </div>
      </div>

      {/* Body: Graph + Sidebar (+ slide-over) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Force Graph */}
        <div ref={graphPanelRef} className="relative min-h-0 min-w-0 flex-1 bg-bg-soft">
          {/* Physics controls */}
          <div className="absolute top-3 left-3 z-40">
            <button
              onClick={() => setPhysicsPanelOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-popover/90 px-2.5 py-1.5 text-xs text-foreground shadow-soft backdrop-blur hover:bg-secondary"
              title={t("physics.title")}
            >
              <Sliders className="h-3.5 w-3.5" />
              {t("physics.button")}
            </button>
            {physicsPanelOpen && (
              <div className="mt-2 w-64 rounded-md border border-border bg-popover/95 p-3 shadow-soft-lg backdrop-blur">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">
                    {t("physics.title")}
                  </span>
                  <button
                    onClick={() => {
                      setChargeMul(1);
                      setLinkDistMul(1);
                      setCollideMul(1);
                      setLinkStrengthMul(1);
                    }}
                    className="inline-flex items-center gap-1 text-[10px] text-brand-500 hover:text-brand-700"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t("physics.reset")}
                  </button>
                </div>

                {[
                  { label: t("physics.repulsion"), v: chargeMul, set: setChargeMul, min: 0.3, max: 4 },
                  { label: t("physics.linkDistance"), v: linkDistMul, set: setLinkDistMul, min: 0.3, max: 4 },
                  { label: t("physics.collide"), v: collideMul, set: setCollideMul, min: 0.5, max: 4 },
                  { label: t("physics.linkStrength"), v: linkStrengthMul, set: setLinkStrengthMul, min: 0.1, max: 1.5 },
                ].map((row, i) => (
                  <div key={i} className="mb-3">
                    <div className="mb-1 flex justify-between">
                      <label className="text-[10px] text-muted-foreground">{row.label}</label>
                      <span className="font-mono text-[10px] text-foreground">
                        {row.v.toFixed(2)}x
                      </span>
                    </div>
                    <input
                      type="range"
                      min={row.min}
                      max={row.max}
                      step={0.05}
                      value={row.v}
                      onChange={(e) => row.set(parseFloat(e.target.value))}
                      className="w-full accent-brand-500"
                    />
                  </div>
                ))}

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      if (graphRef.current?.d3ReheatSimulation)
                        graphRef.current.d3ReheatSimulation();
                    }}
                    className="flex-1 rounded bg-brand-700 px-2 py-1.5 text-[11px] font-medium text-bg hover:bg-brand-500"
                  >
                    {t("physics.reheat")}
                  </button>
                  <button
                    onClick={() => {
                      if (graphRef.current?.zoomToFit)
                        graphRef.current.zoomToFit(500, 80);
                    }}
                    className="flex-1 rounded bg-secondary px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-bg-warm"
                  >
                    {t("physics.fit")}
                  </button>
                </div>

                <p className="mt-2 text-[9px] leading-tight text-muted-foreground">
                  {t("physics.hint")}
                </p>
              </div>
            )}
          </div>

          <ForceGraphCanvas
            fgRef={graphRef}
            width={dims.w}
            height={dims.h}
            graphData={contextGraphData}
            nodeCanvasObject={(node: any, ctx: any, globalScale: number) => {
              const isHighlighted = !highlightedAttr || highlightedNodeIds.has(node.id);
              const dimmed = highlightedAttr && !isHighlighted;
              const alpha = dimmed ? 0.18 : 1;

              if (node.type === "keyword" || node.id === "root") {
                const r = 16;
                ctx.globalAlpha = alpha;
                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = KEYWORD_COLOR;
                ctx.fill();
                ctx.strokeStyle = "#001533";
                ctx.lineWidth = 2 / globalScale;
                ctx.stroke();

                const fontSize = 11;
                ctx.font = `bold ${fontSize}px Sans-Serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillStyle = "#ffffff";
                ctx.fillText(node.label.substring(0, 20), node.x, node.y);
                ctx.globalAlpha = 1;
              } else if (node._ctxType === "category" || node._ctxType === "context_theme") {
                const isCtxTheme = node._ctxType === "context_theme";
                const label = node.label || "";
                const fontSize = 9;
                ctx.font = `bold ${fontSize}px Sans-Serif`;
                const textWidth = ctx.measureText(label).width;
                const padding = 5;
                const w = textWidth + padding * 2;
                const h = fontSize + padding * 2;
                const radius = 3;

                ctx.globalAlpha = alpha;

                if (highlightedAttr && highlightedNodeIds.has(node.id)) {
                  ctx.shadowColor = node.color;
                  ctx.shadowBlur = 12;
                }

                ctx.beginPath();
                ctx.roundRect(node.x - w / 2, node.y - h / 2, w, h, radius);
                ctx.fillStyle = node.color;
                ctx.fill();
                ctx.shadowBlur = 0;

                const attrCount = node._attrCount || 0;
                if (attrCount > 0) {
                  const badgeFontSize = 6;
                  const badgeText = String(attrCount);
                  ctx.font = `bold ${badgeFontSize}px Sans-Serif`;
                  const badgeW = ctx.measureText(badgeText).width + 4;
                  const badgeH = badgeFontSize + 3;
                  ctx.beginPath();
                  ctx.roundRect(
                    node.x + w / 2 - badgeW / 2,
                    node.y - h / 2 - badgeH / 2,
                    badgeW,
                    badgeH,
                    2,
                  );
                  ctx.fillStyle = "#ffffff";
                  ctx.fill();
                  ctx.fillStyle = node.color;
                  ctx.textAlign = "center";
                  ctx.textBaseline = "middle";
                  ctx.fillText(badgeText, node.x + w / 2, node.y - h / 2);
                }

                const labelFontSize = 9;
                ctx.font = `bold ${labelFontSize}px Sans-Serif`;
                ctx.fillStyle = "#ffffff";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(label, node.x, node.y);

                if (globalScale > 1) {
                  ctx.font = `6px Sans-Serif`;
                  ctx.fillStyle = isCtxTheme ? "#1a4d8e" : "#a36b4f";
                  ctx.fillText(isCtxTheme ? "CTX" : "COND", node.x, node.y + h / 2 + 5);
                }
                ctx.globalAlpha = 1;
              } else if (node._ctxType === "context") {
                const r = node.size || 6;
                const mentionCount = node._mentionCount || 0;
                const perspBreakdown = node._perspectiveBreakdown;

                ctx.globalAlpha = alpha;

                if (highlightedAttr === node.id) {
                  ctx.beginPath();
                  ctx.arc(node.x, node.y, r + 5, 0, 2 * Math.PI);
                  ctx.fillStyle = node.color.substring(0, 7) + "30";
                  ctx.fill();
                  ctx.strokeStyle = node.color.substring(0, 7);
                  ctx.lineWidth = 1.5 / globalScale;
                  ctx.stroke();
                }

                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = node.color;
                ctx.fill();

                if (perspBreakdown && r >= 4) {
                  const total =
                    (perspBreakdown.buyer || 0) +
                    (perspBreakdown.seller || 0) +
                    (perspBreakdown.neutral || 0);
                  if (total > 0) {
                    const buyerRatio = perspBreakdown.buyer / total;
                    const sellerRatio = perspBreakdown.seller / total;
                    ctx.lineWidth = 2 / globalScale;
                    let startAngle = -Math.PI / 2;
                    if (buyerRatio > 0) {
                      ctx.beginPath();
                      ctx.arc(node.x, node.y, r + 2.5, startAngle, startAngle + buyerRatio * 2 * Math.PI);
                      ctx.strokeStyle = "#16a34a";
                      ctx.stroke();
                      startAngle += buyerRatio * 2 * Math.PI;
                    }
                    if (sellerRatio > 0) {
                      ctx.beginPath();
                      ctx.arc(node.x, node.y, r + 2.5, startAngle, startAngle + sellerRatio * 2 * Math.PI);
                      ctx.strokeStyle = "#e63312";
                      ctx.stroke();
                      startAngle += sellerRatio * 2 * Math.PI;
                    }
                    if (startAngle < Math.PI * 1.5) {
                      ctx.beginPath();
                      ctx.arc(node.x, node.y, r + 2.5, startAngle, Math.PI * 1.5);
                      ctx.strokeStyle = "#8a8079";
                      ctx.stroke();
                    }
                  }
                }

                if (globalScale > 0.4 || isHighlighted) {
                  const fontSize = 9;
                  ctx.font = `${fontSize}px Sans-Serif`;
                  ctx.textAlign = "center";
                  ctx.textBaseline = "top";
                  const displayLabel = node.label.substring(0, 16);
                  const tw = ctx.measureText(displayLabel).width;
                  ctx.fillStyle = "rgba(255,255,255,0.85)";
                  ctx.fillRect(node.x - tw / 2 - 2, node.y + r + 1.5, tw + 4, fontSize + 3);
                  ctx.fillStyle = "#2b2825";
                  ctx.fillText(displayLabel, node.x, node.y + r + 2.5);
                }

                if (mentionCount > 0 && (globalScale > 0.8 || isHighlighted) && r >= 5) {
                  const countFontSize = Math.max(6, Math.min(r * 0.8, 9));
                  ctx.font = `bold ${countFontSize}px Sans-Serif`;
                  ctx.fillStyle = "#ffffff";
                  ctx.textAlign = "center";
                  ctx.textBaseline = "middle";
                  ctx.fillText(String(mentionCount), node.x, node.y);
                }

                ctx.globalAlpha = 1;
              } else if (node._ctxType === "attribute") {
                const r = node.size || 6;
                const mentionCount = node._mentionCount || 0;
                const hasDeepEvidence = node._hasDeepEvidence;

                ctx.globalAlpha = alpha;

                if (hasDeepEvidence && !dimmed) {
                  ctx.beginPath();
                  ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
                  ctx.strokeStyle = "#a36b4f";
                  ctx.lineWidth = 1.5 / globalScale;
                  ctx.setLineDash([2 / globalScale, 2 / globalScale]);
                  ctx.stroke();
                  ctx.setLineDash([]);
                }

                if (highlightedAttr === node.id) {
                  ctx.beginPath();
                  ctx.arc(node.x, node.y, r + 5, 0, 2 * Math.PI);
                  ctx.fillStyle = node.color.substring(0, 7) + "30";
                  ctx.fill();
                  ctx.strokeStyle = node.color.substring(0, 7);
                  ctx.lineWidth = 1.5 / globalScale;
                  ctx.stroke();
                }

                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = node.color;
                ctx.fill();

                if (globalScale > 0.4 || isHighlighted) {
                  const fontSize = 9;
                  ctx.font = `${fontSize}px Sans-Serif`;
                  ctx.textAlign = "center";
                  ctx.textBaseline = "top";
                  const displayLabel = node.label.substring(0, 16);
                  const tw = ctx.measureText(displayLabel).width;
                  ctx.fillStyle = "rgba(255,255,255,0.85)";
                  ctx.fillRect(node.x - tw / 2 - 2, node.y + r + 1.5, tw + 4, fontSize + 3);
                  ctx.fillStyle = "#2b2825";
                  ctx.fillText(displayLabel, node.x, node.y + r + 2.5);
                }

                const srcCnt = node._enrichedAttr?.unique_source_count || 0;
                if ((srcCnt > 0 || mentionCount > 0) && (globalScale > 0.8 || isHighlighted) && r >= 5) {
                  const countFontSize = Math.max(6, Math.min(r * 0.8, 9));
                  ctx.font = `bold ${countFontSize}px Sans-Serif`;
                  ctx.fillStyle = "#ffffff";
                  ctx.textAlign = "center";
                  ctx.textBaseline = "middle";
                  const displayText = srcCnt > 0 ? String(srcCnt) : String(mentionCount);
                  ctx.fillText(displayText, node.x, node.y);
                }

                ctx.globalAlpha = 1;
              }
            }}
            linkCanvasObjectMode={() => "replace"}
            linkCanvasObject={(link: any, ctx: any, globalScale: number) => {
              const start = link.source;
              const end = link.target;
              if (!start || !end || typeof start.x !== "number") return;

              const srcId = typeof start === "object" ? start.id : start;
              const tgtId = typeof end === "object" ? end.id : end;
              const isCombination = link._ctxType === "combination";
              const isDrivenBy = link._ctxType === "driven_by";
              const bothEndsHighlighted =
                highlightedNodeIds.has(srcId) && highlightedNodeIds.has(tgtId);

              // Semantic links (drives / co-occurrence): ghosted at rest, curved,
              // and only fully drawn (with arrowhead) for the selected island.
              if (isCombination || isDrivenBy) {
                const restAlpha = isCombination ? 0.12 : 0.1;
                ctx.globalAlpha = bothEndsHighlighted
                  ? 0.95
                  : highlightedAttr
                    ? 0.05
                    : restAlpha;

                const midX = (start.x + end.x) / 2;
                const midY = (start.y + end.y) / 2;
                const dx = end.x - start.x;
                const dy = end.y - start.y;
                const k = isCombination ? 0.25 : 0.18;
                const cpX = midX - dy * k;
                const cpY = midY + dx * k;

                ctx.beginPath();
                ctx.moveTo(start.x, start.y);
                ctx.quadraticCurveTo(cpX, cpY, end.x, end.y);

                if (isCombination) {
                  const width =
                    link._width ||
                    (link._frequency === "high" ? 2.5 : link._frequency === "medium" ? 1.5 : 1);
                  ctx.setLineDash([4 / globalScale, 3 / globalScale]);
                  ctx.strokeStyle = link.color || COMBINATION_COLORS.medium;
                  ctx.lineWidth = width / globalScale;
                  ctx.stroke();
                  ctx.setLineDash([]);
                } else {
                  const width = link._width || 1.5;
                  ctx.setLineDash([]);
                  ctx.strokeStyle = "#1a4d8e";
                  ctx.lineWidth = width / globalScale;
                  ctx.stroke();
                  if (bothEndsHighlighted) {
                    const angle = Math.atan2(end.y - cpY, end.x - cpX);
                    const arrowLen = 6 / globalScale;
                    ctx.beginPath();
                    ctx.moveTo(end.x, end.y);
                    ctx.lineTo(
                      end.x - arrowLen * Math.cos(angle - 0.4),
                      end.y - arrowLen * Math.sin(angle - 0.4),
                    );
                    ctx.lineTo(
                      end.x - arrowLen * Math.cos(angle + 0.4),
                      end.y - arrowLen * Math.sin(angle + 0.4),
                    );
                    ctx.closePath();
                    ctx.fillStyle = "#1a4d8e";
                    ctx.fill();
                  }
                }
                ctx.globalAlpha = 1;
                return;
              }

              // Structural skeleton (root→theme→leaf): a quiet hairline. On
              // selection, keep the focused island's branches and fade the rest.
              ctx.globalAlpha = highlightedAttr ? (bothEndsHighlighted ? 0.55 : 0.1) : 0.4;
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.moveTo(start.x, start.y);
              ctx.lineTo(end.x, end.y);
              ctx.strokeStyle = link.color || "#c9bfb4";
              ctx.lineWidth = 1 / globalScale;
              ctx.stroke();
              ctx.globalAlpha = 1;
            }}
            onNodeClick={(node: any) => {
              if (node._ctxType === "attribute") {
                setHighlightedAttr((prev) => (prev === node.id ? null : node.id));
                const enrichedAttr = node._enrichedAttr as EnrichedAttribute | undefined;
                if (enrichedAttr) {
                  setSelectedAttr((prev) =>
                    prev?.name === enrichedAttr.name
                      ? null
                      : { ...enrichedAttr, _categoryName: node._categoryName },
                  );
                  setSelectedCtx(null);
                  setSelectedCombo(null);
                }
              } else if (node._ctxType === "context") {
                setHighlightedAttr((prev) => (prev === node.id ? null : node.id));
                const enrichedCtx = node._enrichedCtx as EnrichedContext | undefined;
                if (enrichedCtx) {
                  setSelectedCtx((prev) =>
                    prev?.name === enrichedCtx.name
                      ? null
                      : { ...enrichedCtx, _themeName: node._categoryName },
                  );
                  setSelectedAttr(null);
                  setSelectedCombo(null);
                }
              } else if (node._ctxType === "category") {
                setHighlightedAttr((prev) => (prev === node.id ? null : node.id));
                setSelectedAttr(null);
                setSelectedCtx(null);
                setSelectedCombo(null);
                const catIdx = matrix.condition_categories.findIndex(
                  (c) => c.category_name === node.label,
                );
                if (catIdx >= 0) {
                  setExpandedCategories((prev) => {
                    const next = new Set(prev);
                    if (next.has(catIdx)) next.delete(catIdx);
                    else next.add(catIdx);
                    return next;
                  });
                }
              } else if (node._ctxType === "context_theme") {
                setHighlightedAttr((prev) => (prev === node.id ? null : node.id));
                setSelectedAttr(null);
                setSelectedCtx(null);
                setSelectedCombo(null);
                const themeIdx = matrix.context_themes.findIndex(
                  (theme) => theme.theme_name === node.label,
                );
                if (themeIdx >= 0) {
                  setExpandedThemes((prev) => {
                    const next = new Set(prev);
                    if (next.has(themeIdx)) next.delete(themeIdx);
                    else next.add(themeIdx);
                    return next;
                  });
                }
              }
            }}
            onNodeHover={(node: any) => {
              if (!node) {
                setHoveredNode(null);
                return;
              }
              if (node._ctxType === "attribute" || node._ctxType === "context") {
                setHoveredNode(node);
              } else {
                setHoveredNode(null);
              }
            }}
            onBackgroundClick={() => {
              setHighlightedAttr(null);
              setSelectedCtx(null);
            }}
            cooldownTicks={250}
            d3AlphaDecay={0.05}
            d3VelocityDecay={0.45}
            enableNodeDrag={true}
            warmupTicks={200}
            onEngineStop={() => {
              if (!ctxFitDoneRef.current && graphRef.current) {
                graphRef.current.zoomToFit(500, 80);
                ctxFitDoneRef.current = true;
              }
            }}
            backgroundColor="#f6f3f2"
          />

          {/* Hover tooltip (attribute or context) */}
          {hoveredNode && (hoveredNode._enrichedAttr || hoveredNode._enrichedCtx) && (
            <div
              className="pointer-events-none absolute z-50 max-w-xs rounded-lg border border-border bg-popover p-3 shadow-soft-lg"
              style={{ top: 60, right: 16 }}
            >
              {hoveredNode._ctxType === "context" && hoveredNode._enrichedCtx
                ? (() => {
                    const c = hoveredNode._enrichedCtx as EnrichedContext;
                    return (
                      <>
                        <div className="mb-1 text-sm font-bold text-brand-700">
                          {hoveredNode.label}
                        </div>
                        <div className="mb-1 text-xs text-muted-foreground">
                          {hoveredNode._categoryName}
                          {" · "}
                          {c.unique_source_count > 0
                            ? t("tooltip.sources", { n: c.unique_source_count })
                            : t("tooltip.mentions", { n: c.mention_count })}
                          {c.driven_conditions?.length > 0 &&
                            ` · ${t("tooltip.drives", { n: c.driven_conditions.length })}`}
                        </div>
                        {c.perspective_breakdown && (
                          <div className="text-[10px] text-muted-foreground">
                            <span className="text-green-700">
                              {t("tooltip.buyer", { n: c.perspective_breakdown.buyer })}
                            </span>
                            {c.perspective_breakdown.seller > 0 && (
                              <span className="ml-1 text-danger">
                                {t("tooltip.seller", { n: c.perspective_breakdown.seller })}
                              </span>
                            )}
                            {c.perspective_breakdown.neutral > 0 && (
                              <span className="ml-1">
                                {t("tooltip.neutral", { n: c.perspective_breakdown.neutral })}
                              </span>
                            )}
                          </div>
                        )}
                        {c.evidence_quotes?.length > 0 && (
                          <div className="mt-1 text-xs text-foreground/80">
                            <span className="text-muted-foreground">{t("tooltip.evidence")}:</span>{" "}
                            {c.evidence_quotes
                              .slice(0, 1)
                              .map((eq) => `"${eq.quote.substring(0, 80)}..."`)
                              .join("; ")}
                          </div>
                        )}
                      </>
                    );
                  })()
                : (() => {
                    const a = hoveredNode._enrichedAttr as EnrichedAttribute;
                    const domainCount = Object.keys(a.source_domains || {}).length;
                    return (
                      <>
                        <div className="mb-1 text-sm font-bold text-foreground">
                          {hoveredNode.label}
                        </div>
                        <div className="mb-1 text-xs text-muted-foreground">
                          {hoveredNode._categoryName}
                          {" · "}
                          {a.unique_source_count > 0
                            ? t("tooltip.sources", { n: a.unique_source_count })
                            : t("tooltip.mentions", { n: hoveredNode._mentionCount })}
                          {domainCount > 0 && ` · ${t("tooltip.domains", { n: domainCount })}`}
                          {hoveredNode._totalWorkers > 0 &&
                            ` · ${t("tooltip.clusters", { m: hoveredNode._mentionCount, w: hoveredNode._totalWorkers })}`}
                        </div>
                        {a.evidence_quotes?.length > 0 && (
                          <div className="mt-1 text-xs text-foreground/80">
                            <span className="text-muted-foreground">{t("tooltip.evidence")}:</span>{" "}
                            {a.evidence_quotes
                              .slice(0, 2)
                              .map((eq: EvidenceQuote) => `"${eq.quote.substring(0, 60)}..."`)
                              .join("; ")}
                          </div>
                        )}
                        {a.related_conditions?.length > 0 && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            <span>{t("tooltip.related")}:</span> {a.related_conditions.join(", ")}
                          </div>
                        )}
                        {hoveredNode._hasDeepEvidence && (
                          <div className="mt-1 text-[10px] text-accent-gold">
                            {t("tooltip.deepLinked")}
                          </div>
                        )}
                      </>
                    );
                  })()}
            </div>
          )}

          {/* Legend */}
          <div className="absolute right-3 bottom-3 rounded-lg border border-border bg-card/90 px-3 py-2 text-xs text-muted-foreground shadow-soft backdrop-blur">
            <div className="mb-1 flex items-center gap-4">
              <span className="flex items-center gap-1">
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={{ backgroundColor: CTX_THEME_COLOR }}
                />
                {t("legend.context")}
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: CTX_NODE_COLOR }}
                />
                {t("legend.contextLeaf")}
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={{ backgroundColor: COND_CAT_COLOR }}
                />
                {t("legend.condition")}
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: COND_NODE_COLOR }}
                />
                {t("legend.conditionLeaf")}
              </span>
            </div>
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 border-t-2 border-brand-500" />
                {t("legend.drives")}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 border-t-2 border-dashed border-accent-gold" />
                {t("legend.combo")}
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
                {t("badge.buyer")}
                <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                {t("badge.seller")}
                <span className="h-1.5 w-1.5 rounded-full bg-ink-300" />
                {t("badge.neutral")}
              </span>
            </div>
            <p className="mt-1.5 border-t border-border pt-1.5 text-[10px] text-muted-foreground/80">
              {t("legend.hint")}
            </p>
          </div>
        </div>

        {/* Sidebar */}
        <div className="relative z-10 flex w-[320px] flex-shrink-0 flex-col overflow-y-auto border-l border-border bg-card">
          {/* Perspective Filter */}
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5">
            <span className="mr-1 text-[10px] text-muted-foreground">{t("perspective.label")}</span>
            {(["all", "buyer", "seller", "neutral"] as const).map((p) => (
              <button
                key={p}
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  perspectiveFilter === p
                    ? p === "buyer"
                      ? "bg-brand-50 text-brand-700"
                      : p === "seller"
                        ? "bg-destructive/10 text-destructive"
                        : p === "neutral"
                          ? "bg-bg-warm text-foreground"
                          : "bg-brand-700 text-bg"
                    : "bg-bg-subtle text-muted-foreground hover:bg-bg-warm"
                }`}
                onClick={() => setPerspectiveFilter(p)}
              >
                {t(`perspective.${p}`)}
              </button>
            ))}
          </div>

          {/* Context Theme Sections */}
          {visibleThemes.length > 0 && (
            <div className="border-b border-border">
              <div className="flex items-center border-l-[3px] border-brand-700 bg-bg-subtle px-4 py-2">
                <h3 className="text-xs font-semibold text-foreground">{t("section.contexts")}</h3>
              </div>
              <div className="divide-y divide-border">
                {visibleThemes.map(({ theme, ti, contexts: ctxs }) => {
                  const isExpanded = expandedThemes.has(ti);

                  return (
                    <div key={`theme-${ti}`}>
                      <button
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-muted"
                        onClick={() => {
                          const themeNodeId = `theme-${ti}`;
                          setHighlightedAttr((prev) =>
                            prev === themeNodeId ? null : themeNodeId,
                          );
                          setSelectedAttr(null);
                          setSelectedCtx(null);
                          setSelectedCombo(null);
                          setExpandedThemes((prev) => {
                            const next = new Set(prev);
                            if (next.has(ti)) next.delete(ti);
                            else next.add(ti);
                            return next;
                          });
                        }}
                      >
                        <span
                          className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                          style={{ backgroundColor: CTX_THEME_COLOR }}
                        />
                        <span className="flex-1 text-sm font-medium text-foreground">
                          {theme.theme_name}
                        </span>
                        <span className="text-xs text-muted-foreground">{ctxs.length}</span>
                        <svg
                          className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </button>
                      {isExpanded && (
                        <div className="px-4 pb-2">
                          <p className="mb-1.5 pl-4 text-[10px] text-muted-foreground">
                            {theme.description}
                          </p>
                          <div className="space-y-0.5">
                            {ctxs.map(({ ctx: ctxItem, originalIndex }, ci) => {
                              const ctxId = `ctx-${ti}-${originalIndex}`;
                              const drivenCount = ctxItem.driven_conditions?.length || 0;
                              const pb = ctxItem.perspective_breakdown;
                              const dominantPersp = pb
                                ? pb.buyer >= pb.seller && pb.buyer >= pb.neutral
                                  ? "buyer"
                                  : pb.seller >= pb.neutral
                                    ? "seller"
                                    : "neutral"
                                : null;

                              return (
                                <button
                                  key={ci}
                                  className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs transition-colors ${
                                    highlightedAttr === ctxId
                                      ? "bg-secondary"
                                      : "hover:bg-muted"
                                  }`}
                                  onClick={() => {
                                    setHighlightedAttr((prev) =>
                                      prev === ctxId ? null : ctxId,
                                    );
                                    setSelectedCtx((prev) =>
                                      prev?.name === ctxItem.name
                                        ? null
                                        : { ...ctxItem, _themeName: theme.theme_name },
                                    );
                                    setSelectedAttr(null);
                                    setSelectedCombo(null);
                                    const node = contextGraphData.nodes.find(
                                      (n) => n.id === ctxId,
                                    );
                                    if (node && graphRef.current) {
                                      graphRef.current.centerAt(node.x, node.y, 500);
                                      graphRef.current.zoom(2.0, 500);
                                    }
                                  }}
                                >
                                  <span
                                    className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                                    style={{ backgroundColor: CTX_NODE_COLOR }}
                                  />
                                  <span className="flex-1 truncate text-foreground/80">
                                    {ctxItem.name}
                                  </span>
                                  {dominantPersp && (
                                    <span
                                      className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dominantPersp === "buyer" ? "bg-green-600" : dominantPersp === "seller" ? "bg-danger" : "bg-ink-300"}`}
                                    />
                                  )}
                                  {drivenCount > 0 && (
                                    <span className="flex-shrink-0 font-mono text-[10px] text-brand-500">
                                      {"⟶"}
                                      {drivenCount}
                                    </span>
                                  )}
                                  <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground">
                                    {ctxItem.mention_count}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Condition Category Sections */}
          {visibleCategories.length > 0 && (
            <div className="border-b border-border">
              <div className="flex items-center border-l-[3px] border-accent-gold bg-bg-subtle px-4 py-2">
                <h3 className="text-xs font-semibold text-foreground">{t("section.conditions")}</h3>
              </div>
            </div>
          )}
          <div className="divide-y divide-border">
            {visibleCategories.map(({ cat, ci, conditions: attrs }) => {
              const isExpanded = expandedCategories.has(ci);
              const catColor = BRANCH_COLORS[ci % BRANCH_COLORS.length];

              return (
                <div key={ci}>
                  <button
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-muted"
                    onClick={() => {
                      const catNodeId = `cat-${ci}`;
                      setHighlightedAttr((prev) => (prev === catNodeId ? null : catNodeId));
                      setSelectedAttr(null);
                      setSelectedCtx(null);
                      setSelectedCombo(null);
                      setExpandedCategories((prev) => {
                        const next = new Set(prev);
                        if (next.has(ci)) next.delete(ci);
                        else next.add(ci);
                        return next;
                      });
                    }}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                      style={{ backgroundColor: catColor }}
                    />
                    <span className="flex-1 text-sm font-medium text-foreground">
                      {cat.category_name}
                    </span>
                    <span className="text-xs text-muted-foreground">{attrs.length}</span>
                    <svg
                      className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                  {isExpanded && (
                    <div className="px-4 pb-2">
                      <p className="mb-1.5 pl-4 text-[10px] text-muted-foreground">
                        {cat.description}
                      </p>
                      <div className="space-y-0.5">
                        {attrs.map(({ cond: attr, originalIndex }, ai) => {
                          const attrId = `cond-${ci}-${originalIndex}`;
                          const srcCount = attr.unique_source_count || 0;
                          const totalSources = matrix.enrichment_stats.total_sources || 1;
                          const srcPct = Math.min(
                            100,
                            Math.round((srcCount / totalSources) * 100 * 10),
                          );

                          return (
                            <button
                              key={ai}
                              className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs transition-colors ${
                                highlightedAttr === attrId
                                    ? "bg-secondary"
                                    : "hover:bg-muted"
                              }`}
                              onClick={() => {
                                setHighlightedAttr((prev) =>
                                  prev === attrId ? null : attrId,
                                );
                                setSelectedAttr((prev) =>
                                  prev?.name === attr.name
                                    ? null
                                    : { ...attr, _categoryName: cat.category_name },
                                );
                                setSelectedCombo(null);
                                const node = contextGraphData.nodes.find(
                                  (n) => n.id === attrId,
                                );
                                if (node && graphRef.current) {
                                  graphRef.current.centerAt(node.x, node.y, 500);
                                  graphRef.current.zoom(2.0, 500);
                                }
                              }}
                            >
                              <span
                                className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                                style={{ backgroundColor: catColor }}
                              />
                              <span className="flex-1 truncate text-foreground/80">
                                {attr.name}
                              </span>
                              {attr.deep_evidence && (
                                <span
                                  className="text-[9px] text-accent-gold"
                                  title={t("detail.deepEvidence")}
                                >
                                  {t("badge.deepEvidence")}
                                </span>
                              )}
                              {srcCount > 0 ? (
                                <div className="flex flex-shrink-0 items-center gap-1">
                                  <div className="h-1.5 w-12 overflow-hidden rounded-full bg-bg-subtle">
                                    <div
                                      className="h-full rounded-full"
                                      style={{
                                        width: `${Math.min(100, srcPct)}%`,
                                        backgroundColor: catColor,
                                      }}
                                    />
                                  </div>
                                  <span className="w-6 text-right font-mono text-[10px] text-muted-foreground">
                                    {srcCount}
                                  </span>
                                </div>
                              ) : attr.mention_count > 0 ? (
                                <span className="font-mono text-[10px] text-muted-foreground">
                                  {attr.mention_count}
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Combination Patterns */}
          {enrichedCombinations.length > 0 && (
            <div className="border-t border-border">
              <div className="flex items-center border-l-[3px] border-ink-300 bg-bg-subtle px-4 py-2">
                <h3 className="text-xs font-semibold text-foreground">
                  {t("section.combinations")}
                </h3>
              </div>
              <div className="space-y-1.5 px-4 py-2.5">
                {[...enrichedCombinations]
                  .sort((a, b) => b.co_occurrence_count - a.co_occurrence_count)
                  .map((combo, i) => (
                    <button
                      key={i}
                      className="w-full rounded-md border border-border p-2 text-left transition-colors hover:bg-muted"
                      onClick={() => {
                        setSelectedCombo(combo);
                        setSelectedAttr(null);
                      }}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        {combo.attributes.map((attr, j) => (
                          <span key={j}>
                            {j > 0 && <span className="mx-0.5 text-muted-foreground">&times;</span>}
                            <span className="inline-block rounded bg-bg-warm px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                              {attr}
                            </span>
                          </span>
                        ))}
                        <span
                          className="ml-auto inline-block rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                          style={{
                            backgroundColor: COMBINATION_COLORS[combo.frequency] + "30",
                            color: COMBINATION_COLORS[combo.frequency],
                          }}
                        >
                          {t(`freq.${combo.frequency}`)}
                        </span>
                      </div>
                      {combo.frequency_justification && (
                        <p className="mt-0.5 font-mono text-[10px] text-brand-500">
                          {combo.frequency_justification}
                        </p>
                      )}
                      {combo.description && (
                        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                          {combo.description}
                        </p>
                      )}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Context Detail Slide-Over Panel */}
        {selectedCtx && !selectedAttr && (
          <div className="relative z-20 w-[380px] flex-shrink-0 overflow-y-auto border-l border-border bg-card">
            <div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-brand-700">{selectedCtx.name}</h3>
                  <p className="text-[10px] text-muted-foreground">{selectedCtx._themeName}</p>
                </div>
                <button
                  onClick={() => {
                    setSelectedCtx(null);
                    setHighlightedAttr(null);
                  }}
                  className="rounded p-1 hover:bg-muted"
                >
                  <svg
                    className="h-4 w-4 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <div className="border-b border-border px-4 py-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md bg-brand-50 p-2 text-center">
                  <div className="text-base font-bold text-brand-700">
                    {selectedCtx.unique_source_count}
                  </div>
                  <div className="text-[10px] text-brand-500">{t("detail.sources")}</div>
                </div>
                <div className="rounded-md bg-muted p-2 text-center">
                  <div className="text-base font-bold text-foreground">
                    {Object.keys(selectedCtx.source_domains || {}).length}
                  </div>
                  <div className="text-[10px] text-muted-foreground">{t("detail.domains")}</div>
                </div>
                <div className="rounded-md bg-secondary p-2 text-center">
                  <div className="text-base font-bold text-brand-700">
                    {selectedCtx.total_workers > 0
                      ? `${selectedCtx.mention_count}/${selectedCtx.total_workers}`
                      : selectedCtx.mention_count}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {selectedCtx.total_workers > 0
                      ? `${t("detail.clusters")} (${Math.round(selectedCtx.mention_rate * 100)}%)`
                      : t("detail.mentions")}
                  </div>
                </div>
              </div>
            </div>

            {selectedCtx.perspective_breakdown && (
              <PerspectiveBar pb={selectedCtx.perspective_breakdown} t={t} />
            )}

            {selectedCtx.driven_conditions && selectedCtx.driven_conditions.length > 0 && (
              <div className="border-b border-border px-4 py-3">
                <h4 className="mb-2 text-xs font-bold text-foreground">
                  {t("detail.drivenConditions")}
                </h4>
                <div className="space-y-1">
                  {[...selectedCtx.driven_conditions]
                    .sort((a, b) => b.strength - a.strength)
                    .map((dc, i) => (
                      <div
                        key={i}
                        className="group/dc flex cursor-pointer items-center gap-2 rounded px-1 -mx-1 py-0.5 text-xs hover:bg-muted"
                        onClick={() => {
                          for (const cat of matrix.condition_categories) {
                            const match = cat.conditions.find(
                              (c) =>
                                c.name.toLowerCase().trim() === dc.name.toLowerCase().trim(),
                            );
                            if (match) {
                              setSelectedAttr({ ...match, _categoryName: cat.category_name });
                              setSelectedCtx(null);
                              break;
                            }
                          }
                        }}
                      >
                        <span className="flex-1 text-foreground/80 group-hover/dc:text-brand-700">
                          {dc.name}
                        </span>
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-subtle">
                          <div
                            className="h-full rounded-full bg-brand-500"
                            style={{ width: `${Math.min(100, dc.strength * 20)}%` }}
                          />
                        </div>
                        <span className="w-4 text-right font-mono text-[10px] text-muted-foreground">
                          {dc.strength}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {selectedCtx.evidence_quotes && selectedCtx.evidence_quotes.length > 0 && (
              <EvidenceList quotes={selectedCtx.evidence_quotes} t={t} />
            )}

            {selectedCtx.source_domains &&
              Object.keys(selectedCtx.source_domains).length > 0 && (
                <DomainList domains={selectedCtx.source_domains} t={t} last />
              )}
          </div>
        )}

        {/* Attribute Detail Slide-Over Panel */}
        {selectedAttr && (
          <div className="relative z-20 w-[380px] flex-shrink-0 overflow-y-auto border-l border-border bg-card">
            <div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-foreground">{selectedAttr.name}</h3>
                  <p className="text-[10px] text-muted-foreground">{selectedAttr._categoryName}</p>
                </div>
                <button
                  onClick={() => {
                    setSelectedAttr(null);
                    setHighlightedAttr(null);
                  }}
                  className="rounded p-1 hover:bg-muted"
                >
                  <svg
                    className="h-4 w-4 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <div className="border-b border-border px-4 py-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md bg-brand-50 p-2 text-center">
                  <div className="text-base font-bold text-brand-700">
                    {selectedAttr.unique_source_count}
                  </div>
                  <div className="text-[10px] text-brand-500">{t("detail.sources")}</div>
                </div>
                <div className="rounded-md bg-muted p-2 text-center">
                  <div className="text-base font-bold text-foreground">
                    {Object.keys(selectedAttr.source_domains).length}
                  </div>
                  <div className="text-[10px] text-muted-foreground">{t("detail.domains")}</div>
                </div>
                <div className="rounded-md bg-secondary p-2 text-center">
                  <div className="text-base font-bold text-brand-700">
                    {selectedAttr.total_workers > 0
                      ? `${selectedAttr.mention_count}/${selectedAttr.total_workers}`
                      : selectedAttr.mention_count}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {selectedAttr.total_workers > 0
                      ? `${t("detail.clusters")} (${Math.round(selectedAttr.mention_rate * 100)}%)`
                      : t("detail.mentions")}
                  </div>
                </div>
              </div>
            </div>

            {selectedAttr.evidence_quotes.length > 0 && (
              <EvidenceList quotes={selectedAttr.evidence_quotes} t={t} />
            )}

            {Object.keys(selectedAttr.source_domains).length > 0 && (
              <DomainList domains={selectedAttr.source_domains} t={t} />
            )}

            {selectedAttr.deep_evidence && (
              <div className="border-b border-border px-4 py-3">
                <h4 className="mb-2 text-xs font-bold text-accent-gold">
                  {t("detail.deepEvidence")}
                </h4>
                <p className="mb-2 text-[10px] text-muted-foreground">
                  &ldquo;{selectedAttr.deep_evidence.claim}&rdquo;
                </p>
                {(() => {
                  const de = selectedAttr.deep_evidence;
                  const total = de.supporting + de.contradicting + de.neutral || 1;
                  return (
                    <>
                      <div className="mb-1.5 flex h-3 overflow-hidden rounded-full">
                        {de.supporting > 0 && (
                          <div
                            className="bg-green-600"
                            style={{ width: `${(de.supporting / total) * 100}%` }}
                          />
                        )}
                        {de.contradicting > 0 && (
                          <div
                            className="bg-danger"
                            style={{ width: `${(de.contradicting / total) * 100}%` }}
                          />
                        )}
                        {de.neutral > 0 && (
                          <div
                            className="bg-ink-300"
                            style={{ width: `${(de.neutral / total) * 100}%` }}
                          />
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span className="text-green-700">
                          {de.supporting} {t("detail.supporting")}
                        </span>
                        <span className="text-danger">
                          {de.contradicting} {t("detail.contradicting")}
                        </span>
                        <span>
                          {de.neutral} {t("detail.neutral")}
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {t("detail.scanned", {
                          n: de.total_scanned,
                          c: t(
                            de.confidence === "high"
                              ? "freq.high"
                              : de.confidence === "low"
                                ? "freq.low"
                                : "freq.medium",
                          ),
                        })}
                      </div>
                      {de.sample_quotes.length > 0 && (
                        <div className="mt-2 space-y-1.5">
                          {de.sample_quotes.slice(0, 3).map((sq, i) => (
                            <div key={i} className="text-[10px]">
                              <span
                                className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${sq.stance === "supporting" ? "bg-green-600" : sq.stance === "contradicting" ? "bg-danger" : "bg-ink-300"}`}
                              />
                              <span className="text-muted-foreground italic">
                                &ldquo;{sq.quote.substring(0, 100)}...&rdquo;
                              </span>
                              <span className="ml-1 text-muted-foreground">- {sq.source}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {selectedAttr.driven_by_contexts && selectedAttr.driven_by_contexts.length > 0 && (
              <div className="border-b border-border px-4 py-3">
                <h4 className="mb-2 text-xs font-bold text-foreground">
                  {t("detail.drivenByContexts")}
                </h4>
                <div className="space-y-1">
                  {[...selectedAttr.driven_by_contexts]
                    .sort((a, b) => b.strength - a.strength)
                    .map((dc, i) => (
                      <div
                        key={i}
                        className="group/dc flex cursor-pointer items-center gap-2 rounded px-1 -mx-1 py-0.5 text-xs hover:bg-muted"
                        onClick={() => {
                          for (const theme of matrix.context_themes) {
                            const match = theme.contexts.find(
                              (c) =>
                                c.name.toLowerCase().trim() === dc.name.toLowerCase().trim(),
                            );
                            if (match) {
                              setSelectedCtx({ ...match, _themeName: theme.theme_name });
                              setSelectedAttr(null);
                              break;
                            }
                          }
                        }}
                      >
                        <span
                          className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: CTX_NODE_COLOR }}
                        />
                        <span className="flex-1 text-foreground/80 group-hover/dc:text-brand-700">
                          {dc.name}
                        </span>
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-subtle">
                          <div
                            className="h-full rounded-full bg-brand-500"
                            style={{ width: `${Math.min(100, dc.strength * 20)}%` }}
                          />
                        </div>
                        <span className="w-4 text-right font-mono text-[10px] text-muted-foreground">
                          {dc.strength}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {selectedAttr.perspective_breakdown && (
              <PerspectiveBar pb={selectedAttr.perspective_breakdown} t={t} />
            )}

            {selectedAttr.related_conditions.length > 0 && (
              <div className="px-4 py-3">
                <h4 className="mb-2 text-xs font-bold text-foreground">{t("detail.related")}</h4>
                <div className="flex flex-wrap gap-1">
                  {selectedAttr.related_conditions.map((ra, i) => (
                    <span
                      key={i}
                      className="inline-block rounded bg-bg-warm px-2 py-0.5 text-[10px] text-foreground"
                    >
                      {ra}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Combination Detail Slide-Over Panel */}
        {selectedCombo && !selectedAttr && (
          <div className="relative z-20 w-[380px] flex-shrink-0 overflow-y-auto border-l border-border bg-card">
            <div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-foreground">
                    {selectedCombo.attributes.join(" × ")}
                  </h3>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span
                      className="inline-block rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                      style={{
                        backgroundColor: COMBINATION_COLORS[selectedCombo.frequency] + "30",
                        color: COMBINATION_COLORS[selectedCombo.frequency],
                      }}
                    >
                      {t(`freq.${selectedCombo.frequency}`)}
                    </span>
                    {selectedCombo.frequency_justification && (
                      <span className="font-mono text-[10px] text-brand-500">
                        {selectedCombo.frequency_justification}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedCombo(null)}
                  className="rounded p-1 hover:bg-muted"
                >
                  <svg
                    className="h-4 w-4 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <div className="border-b border-border px-4 py-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md bg-bg-warm p-2 text-center">
                  <div className="text-base font-bold text-accent-gold">
                    {selectedCombo.co_occurrence_count}
                  </div>
                  <div className="text-[10px] text-accent-gold">{t("detail.coOccur")}</div>
                </div>
                <div className="rounded-md bg-brand-50 p-2 text-center">
                  <div className="text-base font-bold text-brand-700">
                    {selectedCombo.unique_source_count}
                  </div>
                  <div className="text-[10px] text-brand-500">{t("detail.sources")}</div>
                </div>
                <div className="rounded-md bg-muted p-2 text-center">
                  <div className="text-base font-bold text-foreground">
                    {selectedCombo.total_speakers > 0
                      ? `${Math.round(selectedCombo.co_occurrence_rate * 100)}%`
                      : "-"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">{t("detail.overlapRate")}</div>
                </div>
              </div>
            </div>

            {selectedCombo.description && (
              <div className="border-b border-border px-4 py-3">
                <h4 className="mb-1 text-xs font-bold text-foreground">{t("detail.scenario")}</h4>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {selectedCombo.description}
                </p>
              </div>
            )}

            {selectedCombo.evidence_quotes.length > 0 && (
              <EvidenceList quotes={selectedCombo.evidence_quotes} t={t} />
            )}

            {selectedCombo.source_urls.length > 0 && (
              <div className="px-4 py-3">
                <h4 className="mb-2 text-xs font-bold text-foreground">
                  {t("detail.sourceUrls")} ({selectedCombo.source_urls.length})
                </h4>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {selectedCombo.source_urls.slice(0, 20).map((url, i) => (
                    <a
                      key={i}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-[10px] text-brand-500 hover:text-brand-700"
                    >
                      {(() => {
                        try {
                          return (
                            new URL(url).hostname + new URL(url).pathname.substring(0, 40)
                          );
                        } catch {
                          return url.substring(0, 60);
                        }
                      })()}
                    </a>
                  ))}
                  {selectedCombo.source_urls.length > 20 && (
                    <p className="text-[10px] text-muted-foreground">
                      {t("detail.andMore", { n: selectedCombo.source_urls.length - 20 })}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Small shared detail sub-blocks ────────────────────────────────────────

function PerspectiveBar({
  pb,
  t,
}: {
  pb: { buyer: number; seller: number; neutral: number };
  t: any;
}) {
  const total = pb.buyer + pb.seller + pb.neutral;
  return (
    <div className="border-b border-border px-4 py-3">
      <h4 className="mb-2 text-xs font-bold text-foreground">{t("detail.perspective")}</h4>
      {total > 0 && (
        <div className="mb-1.5 flex h-3 overflow-hidden rounded-full">
          {pb.buyer > 0 && (
            <div className="bg-green-600" style={{ width: `${(pb.buyer / total) * 100}%` }} />
          )}
          {pb.seller > 0 && (
            <div className="bg-danger" style={{ width: `${(pb.seller / total) * 100}%` }} />
          )}
          {pb.neutral > 0 && (
            <div className="bg-ink-300" style={{ width: `${(pb.neutral / total) * 100}%` }} />
          )}
        </div>
      )}
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="text-green-700">
          {pb.buyer} {t("detail.buyer")}
        </span>
        <span className="text-danger">
          {pb.seller} {t("detail.seller")}
        </span>
        <span>
          {pb.neutral} {t("detail.neutral")}
        </span>
      </div>
    </div>
  );
}

function EvidenceList({
  quotes,
  t,
}: {
  quotes: EvidenceQuote[];
  t: any;
}) {
  return (
    <div className="border-b border-border px-4 py-3">
      <h4 className="mb-2 text-xs font-bold text-foreground">{t("detail.evidence")}</h4>
      <div className="space-y-2">
        {quotes.map((eq, i) => (
          <div key={i} className="text-xs">
            <div className="flex items-start gap-1.5">
              {eq.perspective && eq.perspective !== "neutral" && (
                <span
                  className={`mt-0.5 flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-medium ${eq.perspective === "buyer" ? "bg-brand-50 text-brand-700" : "bg-destructive/10 text-destructive"}`}
                >
                  {eq.perspective === "buyer" ? t("badge.buyer") : t("badge.seller")}
                </span>
              )}
              <p className="leading-relaxed text-foreground/80 italic">&ldquo;{eq.quote}&rdquo;</p>
            </div>
            {eq.source_url && eq.source_url.startsWith("http") && (
              <a
                href={eq.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 ml-5 inline-flex items-center gap-0.5 text-[10px] text-brand-500 hover:text-brand-700"
              >
                {eq.source_title ||
                  (() => {
                    try {
                      return new URL(eq.source_url).hostname;
                    } catch {
                      return eq.source_url;
                    }
                  })()}
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DomainList({
  domains,
  t,
  last,
}: {
  domains: Record<string, number>;
  t: any;
  last?: boolean;
}) {
  return (
    <div className={`px-4 py-3 ${last ? "" : "border-b border-border"}`}>
      <h4 className="mb-2 text-xs font-bold text-foreground">{t("detail.sourcesByDomain")}</h4>
      <div className="space-y-1">
        {Object.entries(domains)
          .sort(([, a], [, b]) => b - a)
          .map(([domain, count]) => (
            <div key={domain} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate text-foreground/80">{domain}</span>
              <span className="font-mono text-muted-foreground">({count})</span>
            </div>
          ))}
      </div>
    </div>
  );
}
