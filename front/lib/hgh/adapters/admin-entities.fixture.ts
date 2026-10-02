// Preview fixture (E4 compute_preview shape, v = 1) shared by the E7 adapter and action tests.
// Hand-computed expectations are in admin-entities.test.ts.

const zero = { answers: 0, total_mentions: 0, tracked: 0, own_mentions: 0, sent_pos: 0, sent_neg: 0, sent_all: 0, rank_sum: 0, ranked: 0 };
const k = (o: Partial<typeof zero>) => ({ ...zero, ...o });
const brands = (h: Partial<typeof zero>, kia: Partial<typeof zero> = {}, g: Partial<typeof zero> = {}) => ({ Hyundai: k(h), Kia: k(kia), Genesis: k(g) });
const U9 = "00000000-0000-4000-8000-000000000009";

export const PREVIEW = {
  v: 1,
  apply_id: 7,
  ver: 3,
  from_ver: 2,
  computed_at: "2026-10-01T01:00:00+00:00",
  requires_approval: true,
  impact: { entities: 2, block_surfaces: [11], add_surfaces: [], impacted_answers: 120, work_answers: 130, changed_answers: 90, prompt_runs: 4, orphan_prompt_runs: 1, gating_drift: 0 },
  cycles: { in_scope: 3, exposed_in_scope: [5], exposed_labels: [{ cyc_key: 5, round_date: "2026-09-20", surface: 1 }] },
  approx: { no_occurrence_answers: 30, acr_answers: 2, note: "x" },
  kpi: [
    // round 2026-09-20 global, KR / chatgpt: Hyundai visibility 50% -> 40% (10pp), SoV 20% -> 25%
    { cyc_key: 5, round_date: "2026-09-20", surface: 1, project_key: 0, exposed: true, geo_key: 1, geo: "KR", engine_key: 1, engine: "chatgpt",
      before: brands({ answers: 10, tracked: 5, own_mentions: 2, total_mentions: 10, rank_sum: 6, ranked: 3 }),
      after: brands({ answers: 10, tracked: 4, own_mentions: 2, total_mentions: 8, rank_sum: 4, ranked: 2 }) },
    // same round, US / gemini: Hyundai visibility 20% -> 22%
    { cyc_key: 5, round_date: "2026-09-20", surface: 1, project_key: 0, exposed: true, geo_key: 2, geo: "US", engine_key: 2, engine: "gemini",
      before: brands({ answers: 50, tracked: 10, own_mentions: 10, total_mentions: 100 }),
      after: brands({ answers: 50, tracked: 11, own_mentions: 10, total_mentions: 100 }) },
    // later unexposed round, Kia only: Kia SoV 0/0 -> 1/4
    { cyc_key: 6, round_date: "2026-09-27", surface: 2, project_key: 0, exposed: false, geo_key: 1, geo: "KR", engine_key: 1, engine: "chatgpt",
      before: brands({ answers: 4 }, {}), after: brands({ answers: 4, total_mentions: 4 }, { total_mentions: 4, own_mentions: 1 }) },
  ],
  kpi_truncated: false,
  kpi_groups_changed: 3,
  brands: [{ bare: "Tesla", delta_mentions: -5, delta_answers: -2, before_mentions: 40, after_mentions: 35, before_answers: 20, after_answers: 18 }],
  samples: {
    removed: [{ answer_key: 1, job_id: "j", entity_id: U9, name: "N", surface: "N", change: "block", start: 3, end: 4, context: "the N line", highlight: [4, 5], approx: false, cyc_key: 5 }],
    added: [],
    moved: [{ answer_key: 2, name: "X", surface: "x", change: "move", context: null, highlight: null, approx: true }],
  },
};

