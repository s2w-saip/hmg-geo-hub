-- 2026-11-07: what a collecting caller can read, and the time a response states.
-- A project reached a caller only after its own approval and a grant for that caller, both by hand, one project at a time: 4 of 258 projects
-- could be read, and a project made in Admin › 측정 설정 reached nobody. A collecting caller can now hold every project, new ones included.
-- An approval row that says no still holds a project back; without a row a project is open to such a caller and closed to the others.
ALTER TABLE publication.api_client ADD COLUMN all_projects boolean NOT NULL DEFAULT false;
ALTER TABLE publication.api_client ADD CONSTRAINT api_client_all_projects_check CHECK (NOT all_projects OR audience='collect');

CREATE OR REPLACE VIEW ext.caller WITH (security_barrier=true) AS
    SELECT c.client_id,c.name AS client_name,k.key_id,k.expires_at,c.audience,c.all_projects
    FROM publication.api_key k JOIN publication.api_client c USING(client_id)
    WHERE k.key_hash=nullif(current_setting('hgh.key_hash',true),'')
      AND k.revoked_at IS NULL AND k.expires_at>now() AND c.status='active';

-- as_of was the last Gold import, which stopped for good (T10.1), so it stood still. It is now when the response was read.
CREATE OR REPLACE VIEW ext.meta WITH (security_barrier=true) AS
    SELECT c.client_id,c.client_name,c.key_id,c.expires_at,c.audience,now() AS as_of,
        (SELECT string_agg(s.family||':'||s.sha256,',' ORDER BY s.family) FROM catalog.current_reference_set s
         WHERE s.source='hub') AS hub_reference
    FROM ext.caller c;

CREATE OR REPLACE VIEW ext.projects WITH (security_barrier=true) AS
    SELECT p.project_id,p.origin,greatest(p.change_seq,m.change_seq) AS change_seq,
        encode(sha256(convert_to(p.sha256||':'||coalesce(m.sha256,''),'UTF8')),'hex') AS sha256,
        greatest(p.recorded_at,m.recorded_at) AS recorded_at,coalesce(greatest(g.grant_seq,a.access_seq),0) AS reset_seq,
        CASE WHEN coalesce(p.definition->>'status','active')='active'
             THEN p.definition-'scope_project_id'-'source_project_id'-'site_id'
             ELSE jsonb_build_object('status',p.definition->>'status') END AS definition,
        CASE WHEN coalesce(p.definition->>'status','active')='active' AND m.project_id IS NOT NULL THEN jsonb_build_object(
             'brands',to_jsonb(m.brands),'countries',to_jsonb(m.countries),'engines',to_jsonb(m.engines),'cadence',m.cadence,
             'acr_repeats',m.acr_repeats,'web_units',m.web_units,'owned_urls',to_jsonb(m.owned_urls),'tracked_urls',to_jsonb(m.tracked_urls),
             'tracked_targets',m.tracked_targets) END AS measurement
    FROM ext.caller c
    CROSS JOIN catalog.current_project p
    LEFT JOIN publication.api_client_project g ON g.client_id=c.client_id AND g.project_id=p.project_id AND g.revoked_at IS NULL
    LEFT JOIN publication.project_access a ON a.project_id=p.project_id
    LEFT JOIN catalog.current_measurement m ON m.project_id=p.project_id
    WHERE c.audience='collect' AND coalesce(a.projects,c.all_projects) AND (c.all_projects OR g.client_id IS NOT NULL);

CREATE OR REPLACE VIEW ext.prompts WITH (security_barrier=true) AS
    SELECT q.prompt_id,q.project_id,q.origin,q.change_seq,q.sha256,q.recorded_at,
        CASE WHEN coalesce(q.definition->>'status','active')='active' THEN q.text END AS text,
        CASE WHEN coalesce(q.definition->>'status','active')='active' THEN q.definition
             ELSE jsonb_build_object('status',q.definition->>'status') END AS definition
    FROM ext.projects p
    CROSS JOIN ext.caller c
    LEFT JOIN publication.project_access a ON a.project_id=p.project_id
    JOIN catalog.current_prompt q ON q.project_id=p.project_id
    WHERE coalesce(a.prompts,c.all_projects);
