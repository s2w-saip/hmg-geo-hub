// Color palette + bipartite graph builder, ported verbatim from aeorank's
// social-scraping page (the `buildContextGraph` helper + its color constants).
// Converts an EnrichedContextMatrix into the {nodes, links} the ForceGraph2D
// canvas renders: root keyword in the center, context themes/contexts fanning
// left (teal), condition categories/conditions fanning right (amber), plus
// driven_by + combination cross-links.

import type {
  EnrichedContextMatrix,
  GraphData,
  GraphLink,
  GraphNode,
} from "./types";

// HMG-branded bipartite palette (2026-06 redesign). The canvas is the one
// sanctioned place for hex literals (canvas API needs them); these map to the
// app's @theme tokens. Condition categories de-rainbow from 12 hues to a
// 4-tone GOLD ramp so categories differ by tone, not hue — calmer + on-brand.
export const BRANCH_COLORS = [
  "#a36b4f", // accent-gold
  "#b07d5f", // gold tint
  "#8c5a42", // gold deep
  "#c08a64", // gold light
];

export const KEYWORD_COLOR = "#002c5f"; // brand-700 — root

export const COMBINATION_COLORS = {
  high: "#a36b4f", // accent-gold
  medium: "#b88a6e", // gold mid
  low: "#d8c2b3", // gold pale
} as const;

// Colors for bipartite layout — navy LEFT (context), gold RIGHT (condition).
export const CTX_THEME_COLOR = "#1a4d8e"; // brand-500 — context themes (left)
export const CTX_NODE_COLOR = "#6b89b3"; // brand-300 — context leaves
export const COND_CAT_COLOR = "#a36b4f"; // accent-gold — condition categories (right)
export const COND_NODE_COLOR = "#b07d5f"; // gold tint — condition leaves

export function buildContextGraph(
  kw: string,
  matrix: EnrichedContextMatrix,
): GraphData {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  // Root keyword node at center
  nodes.push({
    id: "root",
    label: kw,
    type: "keyword",
    color: KEYWORD_COLOR,
    size: 20,
    fx: 0,
    fy: 0,
  });

  // ====== LEFT SIDE: Context Themes → Contexts (teal) ======
  const themes = matrix.context_themes || [];
  const allCtxNodes: Array<{ id: string; name: string }> = [];

  themes.forEach((theme, ti) => {
    const themeId = `theme-${ti}`;
    const angle =
      Math.PI + ((ti / Math.max(themes.length, 1)) * Math.PI * 0.8 - Math.PI * 0.4); // 150°~210° range
    const radius = 180;

    nodes.push({
      id: themeId,
      label: theme.theme_name,
      type: "branch",
      color: CTX_THEME_COLOR,
      size: 12,
      fx: Math.cos(angle) * radius,
      fy: Math.sin(angle) * radius,
      _ctxType: "context_theme",
      _description: theme.description,
      _attrCount: theme.contexts.length,
    });

    links.push({ source: "root", target: themeId, color: CTX_THEME_COLOR });

    // Context nodes fanning out from theme
    const ctxs = theme.contexts;
    const maxRate = Math.max(...ctxs.map((c) => c.mention_rate || c.mention_count), 1);

    ctxs.forEach((ctx, ci) => {
      const ctxId = `ctx-${ti}-${ci}`;
      const ctxAngle = angle + (ci - ctxs.length / 2) * 0.2;
      const ctxRadius = radius + 80 + (ci % 2) * 25;
      const rateOrCount =
        ctx.mention_rate > 0 ? ctx.mention_rate : ctx.mention_count / maxRate;
      const sizeFactor = Math.max(4, Math.min(10, rateOrCount * 10));

      nodes.push({
        id: ctxId,
        label: ctx.name,
        type: "finding",
        color: CTX_NODE_COLOR,
        size: sizeFactor,
        x: Math.cos(ctxAngle) * ctxRadius,
        y: Math.sin(ctxAngle) * ctxRadius,
        _ctxType: "context",
        _mentionCount: ctx.mention_count,
        _totalWorkers: ctx.total_workers,
        _mentionRate: ctx.mention_rate,
        _categoryName: theme.theme_name,
        _categoryIndex: ti,
        _enrichedCtx: ctx,
        _perspectiveBreakdown: ctx.perspective_breakdown,
      });

      links.push({ source: themeId, target: ctxId, color: CTX_THEME_COLOR });
      allCtxNodes.push({ id: ctxId, name: ctx.name });
    });
  });

  // ====== RIGHT SIDE: Condition Categories → Conditions (amber) ======
  const cats = matrix.condition_categories || [];
  const allCondNodes: Array<{ id: string; name: string; catIndex: number }> = [];

  cats.forEach((cat, ci) => {
    const catId = `cat-${ci}`;
    const angle = (ci / Math.max(cats.length, 1)) * Math.PI * 0.8 - Math.PI * 0.4; // -30°~30° range
    const radius = 180;
    const color = BRANCH_COLORS[ci % BRANCH_COLORS.length];

    nodes.push({
      id: catId,
      label: cat.category_name,
      type: "branch",
      color: COND_CAT_COLOR,
      size: 12,
      fx: Math.cos(angle) * radius,
      fy: Math.sin(angle) * radius,
      _ctxType: "category",
      _description: cat.description,
      _attrCount: cat.conditions.length,
    });

    links.push({ source: "root", target: catId, color: COND_CAT_COLOR });

    // Condition nodes fanning out from category
    const conds = cat.conditions;
    const maxRate = Math.max(...conds.map((c) => c.mention_rate || c.mention_count), 1);

    conds.forEach((cond, ai) => {
      const condId = `cond-${ci}-${ai}`;
      const condAngle = angle + (ai - conds.length / 2) * 0.18;
      const condRadius = radius + 80 + (ai % 2) * 25;
      const rateOrCount =
        cond.mention_rate > 0 ? cond.mention_rate : cond.mention_count / maxRate;
      const sizeFactor = Math.max(4, Math.min(10, rateOrCount * 10));

      nodes.push({
        id: condId,
        label: cond.name,
        type: "finding",
        color: color,
        size: sizeFactor,
        x: Math.cos(condAngle) * condRadius,
        y: Math.sin(condAngle) * condRadius,
        _ctxType: "attribute",
        _mentionCount: cond.mention_count,
        _totalWorkers: cond.total_workers,
        _mentionRate: cond.mention_rate,
        _categoryName: cat.category_name,
        _categoryIndex: ci,
        _enrichedAttr: cond,
        _hasDeepEvidence: !!cond.deep_evidence,
        _perspectiveBreakdown: cond.perspective_breakdown,
      });

      links.push({ source: catId, target: condId, color: color });
      allCondNodes.push({ id: condId, name: cond.name, catIndex: ci });
    });
  });

  // ====== DIRECTED LINKS: Context → Condition (driven_by relationships) ======
  for (const theme of themes) {
    for (const ctx of theme.contexts) {
      if (!ctx.driven_conditions?.length) continue;
      const ctxNode = allCtxNodes.find(
        (n) => n.name.toLowerCase().trim() === ctx.name.toLowerCase().trim(),
      );
      if (!ctxNode) continue;
      for (const dc of ctx.driven_conditions) {
        const condNode = allCondNodes.find(
          (n) => n.name.toLowerCase().trim() === dc.name.toLowerCase().trim(),
        );
        if (!condNode) continue;
        const width = dc.strength > 5 ? 3 : dc.strength > 2 ? 2 : 1;
        links.push({
          source: ctxNode.id,
          target: condNode.id,
          color: "#1a4d8e", // brand-500 — alpha applied at render time
          _ctxType: "driven_by",
          _width: width,
          _description: `${ctx.name} → ${dc.name} (strength: ${dc.strength})`,
        });
      }
    }
  }

  // ====== Combination links between conditions ======
  const combinations = matrix.combinations || [];
  for (const combo of combinations) {
    const matchedIds: string[] = [];
    for (const attrName of combo.attributes) {
      const normalizedName = attrName.toLowerCase().trim();
      const found = allCondNodes.find(
        (n) => n.name.toLowerCase().trim() === normalizedName,
      );
      if (found) matchedIds.push(found.id);
    }
    for (let a = 0; a < matchedIds.length; a++) {
      for (let b = a + 1; b < matchedIds.length; b++) {
        const width =
          combo.co_occurrence_count >= 10 ? 3 : combo.co_occurrence_count >= 4 ? 2 : 1;
        links.push({
          source: matchedIds[a],
          target: matchedIds[b],
          color: COMBINATION_COLORS[combo.frequency] || COMBINATION_COLORS.medium,
          _ctxType: "combination",
          _frequency: combo.frequency,
          _description: combo.description,
          _enrichedCombo: combo,
          _width: width,
        });
      }
    }
  }

  return { nodes, links };
}
