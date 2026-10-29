import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SKIPPED_MIGRATIONS: Record<string, string> = {
  "0035_migrate_project_framework_axes_to_custom_fields.sql": "Existing project data only; reads taxonomy columns introduced out of band (0044). No DDL or fresh-project seed.",
  "0056_genesis_sa_city_sites.sql": "Existing Genesis SA data only; asserts production counts 69/93/84. No DDL or fresh-project seed.",
};

// Deliberately reviewed inventory, independent of the incomplete Drizzle journal.
// A new/renamed/deleted migration must be reviewed before a bootstrap can run.
const REVIEWED_MIGRATIONS = `
0000_mute_deathbird.sql
0001_handy_santa_claus.sql
0002_public_hammerhead.sql
0003_project_brand_description.sql
0004_prompts_and_candidates.sql
0005_standard_catalog.sql
0006_member_audit_logs.sql
0007_tracked_entities.sql
0008_answer_analysis_pipeline.sql
0009_project_scope_link.sql
0010_prompts_depth4.sql
0011_keyword_volume_cache.sql
0012_keyword_cache.sql
0013_profiles_operator.sql
0015_project_tracked_urls.sql
0016_scope_citations_category.sql
0017_project_ga4_property.sql
0018_tracked_keywords.sql
0019_website_sites_prompts.sql
0020_scope_runs_project.sql
0021_project_owned_bases.sql
0022_tracked_competitor_target.sql
0023_entity_registry.sql
0024_project_custom_fields.sql
0025_prompt_kind_acr_rollups.sql
0026_project_custom_fields_text_only.sql
0027_scope_context_map.sql
0028_scope_context_prompt_cache.sql
0029_scope_context_query_indexes.sql
0030_scope_context_prompt_cache_version.sql
0031_website_prompt_lens_index.sql
0032_prompt_brand_presence.sql
0033_bff_audit_logs.sql
0034_role_website.sql
0035_migrate_project_framework_axes_to_custom_fields.sql
0036_ga4_properties.sql
0037_ga4_tracked_events.sql
0038_prompt_status_paused.sql
0039_profiles_menu_groups.sql
0040_entity_registry_alias_rows.sql
0041_prompt_audit_logs.sql
0042_project_ai_engines.sql
0043_citation_domain_overrides.sql
0043_scope_sync_cursors.sql
0044_out_of_band_columns_backfill.sql
0045_perf_indexes_2026_08_26.sql
0046_scope_prompts_is_korean.sql
0047_prompt_lang_regions.sql
0048_scope_prompts_lang_regions.sql
0049_website_prompts_owned_base.sql
0050_perf_root_cycle_cover_2026_09_01.sql
0051_perf_prompts_scope_prompt_id_2026_09_01.sql
0052_scope_citations_url_norm.sql
0053_scope_answer_anchors.sql
0054_scope_answer_drops.sql
0055_qa_review_console.sql
0056_genesis_sa_city_sites.sql
0058_scope_runs_cycle_anchor.sql
0059_summary_tables.sql
0060_summary_report_unit_flags.sql
0061_scope_mention_occurrences.sql
0062_summary_cycle_gen_stats.sql
0063_summary_presence_set.sql
0064_summary_cycle_ops.sql
0065_summary_aggregate_layer.sql
0066_summary_aggregate_keys.sql
0067_summary_detail_report_fs.sql
0068_summary_trend_s1_cover_idx.sql
0069_summary_trend_brands_comp_rank.sql
0070_summary_cycle_hidden.sql
0071_summary_cycle_hidden_scope.sql
0072_scope_answer_stances.sql
0073_scope_mirror_progress.sql
`.trim().split("\n");

export type BootstrapStep = { name: string; sql: string };

export function bootstrapPlan(root = REPO_ROOT): BootstrapStep[] {
  const dir = path.join(root, "lib/db/migrations");
  const actual = fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(REVIEWED_MIGRATIONS)) {
    throw new Error("Migration inventory changed. Review bootstrap-plan.ts and run bootstrap integration tests before applying.");
  }
  const names = [
    "scripts/db/scope-mirror.sql",
    ...REVIEWED_MIGRATIONS.filter((name) => !(name in SKIPPED_MIGRATIONS))
      .map((name) => `lib/db/migrations/${name}`),
    "scripts/db/lockdown.sql",
  ];
  return names.map((name) => ({ name, sql: fs.readFileSync(path.join(root, name), "utf8") }));
}
