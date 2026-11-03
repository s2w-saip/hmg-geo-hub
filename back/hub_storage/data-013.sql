-- Incremental migration (2026-11-03): explicit versions of the 인용 출처 분류 inputs, as a prompt has them (decision
-- '인용 출처 버전', docs/handoff/admin-todo.md). Every change of a correction, seed, official social account or code-table
-- row is one numbered version holding the whole row, so any past state reads back without replaying the event diffs
-- (whose import rows never held every column). The lists' own versions stay the published sets (reference_set.version per
-- family). Versions take change_seq like prompt and project revisions, so one point in time (change_seq <= n) reads the
-- prompts and these lists together or apart, whichever way they end up being versioned.
--
-- catalog.<list>_version: one row per change (version 1, 2, ... per key) with the row's values after it, recorded_at,
-- recorded_by (the row's updated_by: the account; NULL for manage.py) and change_seq. Only the trigger
-- catalog.record_source_version() writes them, on every INSERT or UPDATE of the list that changes a value (updated_at /
-- updated_by alone change nothing); nobody updates or deletes them. The current tables stay as they are (keys, CHECKs,
-- the category order constraint) and always equal their latest version (verify-data.sql).
-- The rows already there get their history from the event tables: walking each key's events back from the current row,
-- the values before an event are its `changes` before-values (every value the screen and the imports changed is there).
-- Each version keeps its event's time, actor and the change_seq of the list it went out in.
CREATE TABLE catalog.source_override_version (
    skey text NOT NULL REFERENCES catalog.source_override(skey),
    version integer NOT NULL CHECK (version > 0),
    category text NOT NULL,
    note text,
    status text NOT NULL,
    origin text NOT NULL,
    recorded_at timestamptz NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    PRIMARY KEY (skey, version)
);
CREATE TABLE catalog.source_seed_version (
    skey text NOT NULL REFERENCES catalog.source_seed(skey),
    version integer NOT NULL CHECK (version > 0),
    category text NOT NULL,
    note text,
    status text NOT NULL,
    origin text NOT NULL,
    recorded_at timestamptz NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    PRIMARY KEY (skey, version)
);
CREATE TABLE catalog.source_social_version (
    account_key text NOT NULL REFERENCES catalog.source_social(account_key),
    version integer NOT NULL CHECK (version > 0),
    display_key text NOT NULL,
    domain text NOT NULL,
    matchers jsonb NOT NULL,
    note text,
    status text NOT NULL,
    origin text NOT NULL,
    recorded_at timestamptz NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    PRIMARY KEY (account_key, version)
);
CREATE TABLE catalog.source_code_version (
    kind text NOT NULL,
    code text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    number smallint NOT NULL,
    name_en text NOT NULL,
    name_ko text NOT NULL,
    ord smallint NOT NULL,
    description text,
    recorded_at timestamptz NOT NULL,
    recorded_by uuid,
    change_seq bigint NOT NULL,
    PRIMARY KEY (kind, code, version),
    FOREIGN KEY (kind, code) REFERENCES catalog.source_code(kind, code)
);
CREATE INDEX source_override_version_change_seq ON catalog.source_override_version(change_seq);
CREATE INDEX source_seed_version_change_seq ON catalog.source_seed_version(change_seq);
CREATE INDEX source_social_version_change_seq ON catalog.source_social_version(change_seq);
CREATE INDEX source_code_version_change_seq ON catalog.source_code_version(change_seq);

-- ═══ the history so far ═════════════════════════════════════════════════════════════════════════════════
-- Per list (the family has the table's name) and key: the current row is the state after its newest event; undoing an
-- event's changes gives the state after the one before. The oldest event created the row, so all its before-values are
-- null; anything else means a change went unrecorded and the migration stops rather than invent a history. A row with
-- no event (none so far) is one version as it stands. An event that published nothing takes the change_seq of the list
-- as it stood then (0 before the first).
DO $$
DECLARE
    spec record;
    cur record;
    e record;
    vt text;
    state jsonb;
    keyed jsonb;
    built jsonb;
    oldest jsonb;
    seq bigint;
BEGIN
    FOR spec IN SELECT * FROM (VALUES ('source_override',ARRAY['skey']),('source_seed',ARRAY['skey']),
                                      ('source_social',ARRAY['account_key']),('source_code',ARRAY['kind','code'])) s(tbl,keys)
    LOOP
        vt := spec.tbl || '_version';
        FOR cur IN EXECUTE format('SELECT to_jsonb(t) AS r FROM catalog.%I t', spec.tbl) LOOP
            state := cur.r - 'created_at' - 'updated_at' - 'updated_by';
            keyed := (SELECT jsonb_object_agg(k, state->k) FROM unnest(spec.keys) k);
            built := '[]';
            oldest := NULL;
            FOR e IN EXECUTE format('SELECT v.actor_id,v.changes,v.published_seq,v.occurred_at FROM catalog.%I v
                                     WHERE to_jsonb(v) @> $1 ORDER BY v.event_id DESC', spec.tbl || '_event') USING keyed
            LOOP
                seq := coalesce(e.published_seq, (SELECT max(s.change_seq) FROM catalog.reference_set s
                                                   WHERE s.family=spec.tbl AND s.recorded_at<=e.occurred_at), 0);
                built := jsonb_build_array(state || jsonb_build_object('recorded_at',e.occurred_at,'recorded_by',e.actor_id,
                                                                       'change_seq',seq)) || built;
                state := state || coalesce((SELECT jsonb_object_agg(c.key, c.value->0) FROM jsonb_each(e.changes) c), '{}');
                oldest := e.changes;
            END LOOP;
            IF oldest IS NULL THEN
                built := jsonb_build_array(state || jsonb_build_object(
                    'recorded_at', coalesce(cur.r->'updated_at', to_jsonb(now())), 'recorded_by', cur.r->'updated_by',
                    'change_seq', coalesce((SELECT max(s.change_seq) FROM catalog.reference_set s WHERE s.family=spec.tbl
                                              AND s.recorded_at<=coalesce((cur.r->>'updated_at')::timestamptz, now())), 0)));
            ELSIF EXISTS(SELECT 1 FROM jsonb_each(oldest) c WHERE c.value->0 <> 'null') THEN
                RAISE EXCEPTION '% %: the oldest event changes an existing value; the history has a gap', spec.tbl, keyed;
            END IF;
            EXECUTE format('INSERT INTO catalog.%1$I SELECT (jsonb_populate_record(NULL::catalog.%1$I, b.v || jsonb_build_object(''version'', b.i))).*
                            FROM jsonb_array_elements($1) WITH ORDINALITY b(v,i)', vt) USING built;
        END LOOP;
    END LOOP;
END $$;

-- ═══ every change from now on ═══════════════════════════════════════════════════════════════════════════
-- TG_ARGV: the key columns. The values are the row without its bookkeeping (created_at, updated_at, updated_by). Under
-- the catalog lock like every catalog writer, so change_seq order is commit order.
CREATE FUNCTION catalog.record_source_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
    vt text := TG_TABLE_NAME || '_version';
    vals jsonb := to_jsonb(NEW) - 'created_at' - 'updated_at' - 'updated_by';
    keyed text;
    next_version integer;
BEGIN
    IF TG_OP = 'UPDATE' AND vals = to_jsonb(OLD) - 'created_at' - 'updated_at' - 'updated_by' THEN
        RETURN NULL;
    END IF;
    PERFORM pg_advisory_xact_lock(617427413);
    keyed := (SELECT string_agg(format('v.%1$I=($1).%1$I', k), ' AND ') FROM unnest(TG_ARGV) k);
    EXECUTE format('SELECT coalesce(max(v.version),0)+1 FROM catalog.%I v WHERE %s', vt, keyed) INTO next_version USING NEW;
    EXECUTE format('INSERT INTO catalog.%1$I SELECT (jsonb_populate_record(NULL::catalog.%1$I, $1)).*', vt)
        USING vals || jsonb_build_object('version', next_version, 'recorded_at', now(), 'recorded_by', NEW.updated_by,
                                         'change_seq', nextval('catalog.change_seq'));
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION catalog.record_source_version() FROM PUBLIC;
CREATE TRIGGER source_override_version AFTER INSERT OR UPDATE ON catalog.source_override
    FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('skey');
CREATE TRIGGER source_seed_version AFTER INSERT OR UPDATE ON catalog.source_seed
    FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('skey');
CREATE TRIGGER source_social_version AFTER INSERT OR UPDATE ON catalog.source_social
    FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('account_key');
CREATE TRIGGER source_code_version AFTER INSERT OR UPDATE ON catalog.source_code
    FOR EACH ROW EXECUTE FUNCTION catalog.record_source_version('kind','code');

-- Read by the API (the reader and the screen's role); written by the trigger only.
GRANT SELECT ON catalog.source_override_version,catalog.source_seed_version,catalog.source_social_version,
    catalog.source_code_version TO hmg_analytics_reader,hmg_source_override_editor;
COMMENT ON TABLE catalog.source_override_version IS 'Every version of a source correction (the whole row), written by catalog.record_source_version() only.';
COMMENT ON TABLE catalog.source_seed_version IS 'Every version of a seed (the whole row), written by catalog.record_source_version() only.';
COMMENT ON TABLE catalog.source_social_version IS 'Every version of an official social account (the whole row), written by catalog.record_source_version() only.';
COMMENT ON TABLE catalog.source_code_version IS 'Every version of a code-table row (the whole row), written by catalog.record_source_version() only.';
COMMENT ON FUNCTION catalog.record_source_version() IS 'Records the whole row as its next version on every change of a 인용 출처 분류 list (data-013).';
