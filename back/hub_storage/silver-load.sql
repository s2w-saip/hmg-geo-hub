-- Fills the virtual Silver (silver-001.sql) from the copy of the old upstream database (gold_db, schema gold). Run by build_virtual_obt.py,
-- one section per COPY: each section's last statement writes rows to stdout. Only the live release's builds are read: the release is the old
-- database's operating snapshot, so one Silver run per cycle, status public.
-- Nothing is estimated. Contract fields the old database does not hold are NULL (listed in back/hub_storage/README.md). What it holds outside the
-- contract goes in ext under the module's prefix with v_gold in the name.

-- @section setup
SET work_mem='512MB';
SET temp_buffers='4GB';
SET jit=off;
SET statement_timeout=0;
CREATE TEMP TABLE live_builds AS
    SELECT DISTINCT i.family,i.build_id,i.slice_key FROM gold.active_release a JOIN gold.release_item i USING(release_id) WHERE a.read_mode='live';
CREATE TEMP TABLE cycle_run AS
    SELECT c.*,md5('virtual-silver-run:'||c.cycle_id)::uuid AS silver_run,
           CASE c.surface WHEN 1 THEN 'global' WHEN 2 THEN 'website' WHEN 3 THEN 'project' END AS surface_name
    FROM gold.dim_cycle c
    WHERE EXISTS(SELECT 1 FROM gold.job_index j WHERE j.cyc_key=c.cyc_key)
       OR EXISTS(SELECT 1 FROM gold.acr_cell_fact f JOIN live_builds b ON b.family='acr' AND b.build_id=f.build_id WHERE f.cyc_key=c.cyc_key);
CREATE UNIQUE INDEX ON cycle_run(cyc_key);
ANALYZE cycle_run;

-- @section cycle
COPY (SELECT cycle_id,surface_name FROM cycle_run ORDER BY cycle_id) TO STDOUT;

-- @section run
COPY (SELECT silver_run,cycle_id,NULL::uuid,'silver','succeeded','silver.v1',NULL::text,
             jsonb_build_object('virtual',true,'source','gold_db','rule_signature',(SELECT max(rule_signature) FROM gold.active_release WHERE read_mode='live')),
             now(),now()
      FROM cycle_run ORDER BY cycle_id) TO STDOUT;

-- @section answers
CREATE TEMP TABLE live_answer AS
    SELECT f.* FROM gold.answer_fact f JOIN live_builds b ON b.family='fact' AND b.build_id=f.build_id;
CREATE UNIQUE INDEX ON live_answer(answer_key);
CREATE TEMP TABLE live_brand AS
    SELECT f.answer_key,f.brand_key,f.competitive,f.own_bit,f.rk,f.first_pos FROM gold.answer_brand_fact f JOIN live_builds b ON b.family='fact' AND b.build_id=f.build_id;
CREATE INDEX ON live_brand(answer_key);
CREATE TEMP TABLE live_citation AS
    SELECT f.answer_key,f.ord,f.url_key,f.source_key,f.owner_key,f.scope_key,f.loc_owned,f.tgt_hit,f.src_first FROM gold.citation_fact f JOIN live_builds b ON b.family='fact' AND b.build_id=f.build_id;
CREATE UNIQUE INDEX ON live_citation(answer_key,ord);
CREATE TEMP TABLE entity_rollup AS
    SELECT DISTINCT ON (entity_id) entity_id,brand_rollup_entity_id FROM gold.answer_mention_raw WHERE entity_id IS NOT NULL ORDER BY entity_id,answer_key DESC;
CREATE UNIQUE INDEX ON entity_rollup(entity_id);
ANALYZE live_answer; ANALYZE live_brand; ANALYZE live_citation; ANALYZE entity_rollup;
COPY (
    SELECT c.silver_run,j.job_id,dp.scope_project_id,b.run_id,p.prompt_id,e.code,coalesce(b.region,g.code),nullif(upper(l.code),''),j.measured_at,b.model_slug,b.answer_text,
        b.status,NULL::text,j.dropped,coalesce(r.pin_source_measured_at,j.measured_at),coalesce(f.anchor_date,r.pin_anchor),j.round_date,c.view_date,e.is_default,f.anchor_src,
        cit.citations,'succeeded',
        NULL::text,CASE WHEN b.status='failed' THEN 'upstream_failed' ELSE 'skipped' END,
        men.rollups,occ.occurrences,
        CASE WHEN b.status='failed' THEN 'upstream_failed' WHEN j.analysis_code='complete_empty' THEN 'empty' WHEN j.analysis_code='complete' THEN 'succeeded' ELSE 'failed' END,
        jud.judgments,
        CASE WHEN b.status='failed' THEN 'upstream_failed' WHEN jud.judgments IS NULL THEN 'empty' ELSE 'succeeded' END,
        men.semantics,occ.semantics,
        CASE WHEN b.status='failed' THEN 'upstream_failed' WHEN j.analysis_code='complete_empty' THEN 'empty' WHEN j.analysis_code='complete' THEN 'succeeded' ELSE 'failed' END,
        sta.stances,
        CASE WHEN b.status='failed' THEN 'upstream_failed' WHEN sta.stances IS NULL THEN 'empty' ELSE 'succeeded' END,
        jsonb_strip_nulls(jsonb_build_object(
            's1_normalize_v_gold',jsonb_build_object('analysis_state',f.analysis_state,'analysis_label',nullif(j.analysis_code,''),'served',j.served,'status_code',j.status_code,
                'market',g.code,'bgrp',j.bgrp,'elig',f.elig,'dflt',f.dflt,'is_acr',f.is_acr,'is_rep',f.is_rep,'web_reg',f.web_reg,'std_in',f.std_in,'cit_in',f.cit_in,'gap',f.gap,
                'acr_in',f.acr_in,'elig_nc',f.elig_nc,'std_in_nc',f.std_in_nc,'cit_in_nc',f.cit_in_nc,'acr_iter_rank',f.acr_iter_rank,'cat_mask',f.cat_mask,'own_mask',f.own_mask,
                'rep_cit_xor',f.rep_cit_xor,'prompt_run_id',b.prompt_run_id,'rule_ver',f.rule_ver,'ecat_ver',f.ecat_ver),
            's1_normalize_v_registry',CASE WHEN r.pin_reason IS NULL AND r.drop_reason IS NULL THEN NULL
                ELSE jsonb_strip_nulls(jsonb_build_object('pin_reason',r.pin_reason,'drop_reason',r.drop_reason,'dropped_at',r.dropped_at,'drop_source_measured_at',r.drop_source_measured_at)) END,
            's2_mention_rollups',men.rollup_ext,
            's2_mention_v_gold_brands',bra.brands,
            's2_citation_judgments',jud.judgment_ext))
    FROM gold.job_index j
    JOIN cycle_run c ON c.cyc_key=j.cyc_key
    LEFT JOIN gold.answer_body b ON b.answer_key=j.answer_key
    LEFT JOIN gold.answer_registry r ON r.answer_key=j.answer_key
    LEFT JOIN live_answer f ON f.answer_key=j.answer_key
    LEFT JOIN gold.dim_prompt p ON p.prompt_key=j.prompt_key
    LEFT JOIN gold.dim_project dp ON dp.project_key=j.project_key
    LEFT JOIN gold.dim_engine e ON e.engine_key=j.engine_key
    LEFT JOIN gold.dim_country g ON g.geo_key=j.geo_key
    LEFT JOIN gold.dim_lang l ON l.lang_key=j.lang_key
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('citation_seq',x.ord,'ref_index',x.ref_index,'url',x.url,'url_norm',u.url_norm,'url_base_norm',u.url_base_norm,'host',x.host,
                   'domain',coalesce(u.domain,x.domain_label),'title',x.title,'scope_category',nullif(x.scope_category,'')) ORDER BY x.ord) AS citations
        FROM gold.answer_citation_raw x LEFT JOIN live_citation lc ON lc.answer_key=x.answer_key AND lc.ord=x.ord LEFT JOIN gold.dim_url u ON u.url_key=lc.url_key
        WHERE x.answer_key=j.answer_key) cit ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('citation_seq',lc.ord,'url_norm',u.url_norm,'domain',coalesce(s.domain,u.domain),'group_key',s.skey,'category',k.name,
                   'category_method',CASE s.category_src WHEN 1 THEN 'override' WHEN 2 THEN 'official_social' WHEN 3 THEN 'owned_domain' WHEN 4 THEN 'seed' WHEN 5 THEN 'rule' WHEN 6 THEN 'default' END,
                   'is_owned',coalesce(lc.owner_key,0)<>0,'matched_base_url',o.prefix,'matched_brand',o.brand_code,'matched_base_country',NULL,'loc_owned',lc.loc_owned,'tgt_hit',lc.tgt_hit) ORDER BY lc.ord) AS judgments,
               jsonb_agg(jsonb_build_object('citation_seq',lc.ord,'src_first',lc.src_first,'scope_key',lc.scope_key) ORDER BY lc.ord) AS judgment_ext
        FROM live_citation lc LEFT JOIN gold.dim_url u ON u.url_key=lc.url_key LEFT JOIN gold.dim_source s ON s.source_key=lc.source_key
             LEFT JOIN gold.dim_category k ON k.category_key=s.category_key LEFT JOIN gold.dim_owned_base o ON o.owner_key=lc.owner_key
        WHERE lc.answer_key=j.answer_key) jud ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('entity_id',x.entity_id,'entity_type',x.entity_type,'brand',br.name,'brand_rollup_entity_id',x.brand_rollup_entity_id,
                   'mention_count',x.mention_count,'avg_position',x.avg_position,'surfaces',x.surfaces) ORDER BY x.ord) AS rollups,
               jsonb_agg(jsonb_build_object('entity_id',x.entity_id,'sentiment_positive',x.sentiment_positive,'sentiment_neutral',x.sentiment_neutral,'sentiment_negative',x.sentiment_negative,
                   'sentiment_mixed',x.sentiment_mixed,'type_mention',x.type_mention,'type_recommendation',x.type_recommendation,'type_comparison',x.type_comparison,
                   'type_definition',x.type_definition,'type_final_choice',x.type_final_choice) ORDER BY x.ord) AS semantics,
               jsonb_agg(jsonb_build_object('entity_id',x.entity_id,'display_name',x.display_name,'registry_role',x.registry_role) ORDER BY x.ord) AS rollup_ext
        FROM gold.answer_mention_raw x LEFT JOIN gold.dim_entity en ON en.entity_id=x.entity_id LEFT JOIN gold.dim_brand br ON br.brand_key=en.brand_key
        WHERE x.answer_key=j.answer_key) men ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('occurrence_seq',x.ord,'analysis_index',x.ord,'analysis_position',NULL,'turn_index',x.turn_index,'source_start',x.source_start,'source_end',x.source_end,
                   'entity_id',x.entity_id,'entity_type',en.entity_type,'brand_rollup_entity_id',er.brand_rollup_entity_id,'surface_text',x.surface_text,'mention_role',x.mention_role,
                   'assertion',x.assertion,'base_sentiment',NULL,'context_snippet',x.context_snippet,'descriptors',x.descriptors,'criteria',x.criteria) ORDER BY x.ord) AS occurrences,
               jsonb_agg(jsonb_build_object('analysis_index',x.ord,'turn_index',x.turn_index,'entity_id',x.entity_id,'sentiment',x.sentiment,'sentiment_source',NULL,
                   'mention_type',CASE x.assertion WHEN 'mention_only' THEN 'mention' WHEN 'compare' THEN 'comparison' WHEN 'recommend' THEN 'recommendation' WHEN 'final_choice' THEN 'final_choice' END,
                   'evidence',NULL,'reason',NULL) ORDER BY x.ord) AS semantics
        FROM gold.answer_occurrence x LEFT JOIN gold.dim_entity en ON en.entity_id=x.entity_id LEFT JOIN entity_rollup er ON er.entity_id=x.entity_id
        WHERE x.answer_key=j.answer_key) occ ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('turn_index',x.turn_index,'entity_id',x.entity_id,'brand_label',x.brand_label,'is_tracked',NULL,'stance',x.stance,'confidence',x.confidence,
                   'evidence_text',x.evidence_text,'evidence_start',x.evidence_start,'evidence_end',x.evidence_end,'reason',x.reason,'model_slug',NULL) ORDER BY x.turn_index,x.entity_id) AS stances
        FROM gold.answer_stance_raw x WHERE x.answer_key=j.answer_key) sta ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('brand_key',x.brand_key,'brand',br.name,'own_bit',x.own_bit,'competitive',x.competitive,'rk',x.rk,'first_pos',x.first_pos) ORDER BY x.brand_key,x.competitive) AS brands
        FROM live_brand x LEFT JOIN gold.dim_brand br ON br.brand_key=x.brand_key WHERE x.answer_key=j.answer_key) bra ON true
) TO STDOUT;

-- @section acr
CREATE TEMP TABLE live_cell AS
    SELECT f.* FROM gold.acr_cell_fact f JOIN live_builds b ON b.family='acr' AND b.build_id=f.build_id;
CREATE UNIQUE INDEX ON live_cell(acr_cell_key);
ANALYZE live_cell;
COPY (
    SELECT c.silver_run,x.prompt_run_id,dp.scope_project_id,x.run_id,p.prompt_id,e.code,g.code,nullif(upper(l.code),''),job.measured_at,NULL::text,
        f.planned,f.valid_turn1,f.valid_acr,f.co_single,f.co_conditional,f.co_generic,f.co_off_shortlist,f.co_unresolved,f.co_none,
        ent.entities,'succeeded',
        jsonb_strip_nulls(jsonb_build_object(
            's3_acr_v_gold',jsonb_build_object('is_rep',f.is_rep,'acr_in',f.acr_in,'cat_mask',f.cat_mask,'bgrp',f.bgrp,'round_date',f.round_date,'measured_date',f.measured_date,'market',g.code,'rule_ver',f.rule_ver),
            's3_acr_v_entities',ent.entity_ext,
            's3_acr_v_iterations',itr.iterations,
            's3_acr_v_shortlist',sho.shortlist,
            's3_acr_v_jobs',job.jobs))
    FROM live_cell f
    JOIN cycle_run c ON c.cyc_key=f.cyc_key
    JOIN gold.acr_cell_run x ON x.acr_cell_key=f.acr_cell_key
    LEFT JOIN gold.dim_prompt p ON p.prompt_key=f.prompt_key
    LEFT JOIN gold.dim_project dp ON dp.project_key=f.project_key
    LEFT JOIN gold.dim_engine e ON e.engine_key=f.engine_key
    LEFT JOIN gold.dim_country g ON g.geo_key=f.geo_key
    LEFT JOIN gold.dim_lang l ON l.lang_key=f.lang_key
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('entity_id',en.entity_id,'rollup_level',CASE y.level WHEN 1 THEN 'brand' WHEN 2 THEN 'model' WHEN 3 THEN 'company' END,'brand',br.name,'parent_brand',pb.name,
                   'brand_rollup_entity_id',NULL,'entity_type',en.entity_type,'appearance_count',y.appearance,'choice_count',y.choice,'conditional_choice_count',y.cond_choice,
                   'off_shortlist_choice_count',y.off_shortlist,'unresolved_choice_count',y.unresolved,'generic_choice_count',y.generic,'co_single_entity',NULL,'co_conditional_multiple',NULL,
                   'co_generic_category',NULL,'co_resolved_off_shortlist',NULL,'co_unresolved_choice',NULL,'co_none',NULL) ORDER BY y.level,y.entity_key) AS entities,
               jsonb_agg(jsonb_build_object('entity_id',en.entity_id,'rollup_level',y.level,'brand_key',y.brand_key,'parent_brand_key',y.parent_brand_key,'own_bit',y.own_bit,'name_own',y.name_own,'keep',y.keep) ORDER BY y.level,y.entity_key) AS entity_ext
        FROM gold.acr_entity_fact y LEFT JOIN gold.dim_entity en ON en.entity_key=y.entity_key LEFT JOIN gold.dim_brand br ON br.brand_key=y.brand_key LEFT JOIN gold.dim_brand pb ON pb.brand_key=y.parent_brand_key
        WHERE y.build_id=f.build_id AND y.acr_cell_key=f.acr_cell_key) ent ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('iter_no',y.iter_no,'answer_key',jj.job_id,'result_type',y.result_type,'winner_brand_key',y.winner_brand_key,'winner_entity_id',en.entity_id,'own_bit',y.own_bit) ORDER BY y.iter_no) AS iterations
        FROM gold.acr_iter_fact y LEFT JOIN gold.job_index jj ON jj.answer_key=y.answer_key LEFT JOIN gold.dim_entity en ON en.entity_key=y.winner_entity_key
        WHERE y.build_id=f.build_id AND y.acr_cell_key=f.acr_cell_key) itr ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('iter_no',y.iter_no,'rollup_level',y.level,'entity_id',en.entity_id,'brand_key',y.brand_key,'parent_brand_key',y.parent_brand_key,'is_choice',y.is_choice) ORDER BY y.iter_no,y.level,y.entity_key) AS shortlist
        FROM gold.acr_iter_shortlist y LEFT JOIN gold.dim_entity en ON en.entity_key=y.entity_key
        WHERE y.build_id=f.build_id AND y.acr_cell_key=f.acr_cell_key) sho ON true
    LEFT JOIN LATERAL (
        SELECT max(jj.measured_at) AS measured_at,jsonb_agg(jj.job_id ORDER BY jj.job_id) AS jobs
        FROM gold.acr_cell_job y JOIN gold.job_index jj ON jj.answer_key=y.answer_key
        WHERE y.build_id=f.build_id AND y.acr_cell_key=f.acr_cell_key) job ON true
) TO STDOUT;

-- @section manifest
COPY (SELECT cycle_id,round_date,
             jsonb_build_object('v_gold',jsonb_build_object('servable',servable,'view_date',view_date,'anchor_date',anchor_date,'status',status,'hidden_scope',hidden_scope,'hidden_reason',hidden_reason,
                 'ledger_backed',ledger_backed,'generation',generation,'ecat_ver',ecat_ver,'expected_units',expected_units,'completed_units',completed_units,
                 'completed_answers',completed_answers,'gap_answers',gap_answers)),
             silver_run,(SELECT max(rule_signature) FROM gold.active_release WHERE read_mode='live')
      FROM cycle_run ORDER BY cycle_id) TO STDOUT;
