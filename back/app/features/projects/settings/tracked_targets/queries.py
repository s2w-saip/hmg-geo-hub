"""projects.settings.tracked_targets SQL(app 만). 복합 PK 자연키(brand_name, (brand, model))."""
from __future__ import annotations

COMP_COLS = "c.brand_name, c.aliases, c.notes, c.is_target, c.created_at"
VEH_COLS = "v.brand, v.model, v.segment, v.aliases, v.created_at"

LIST_COMPETITORS = f"SELECT {COMP_COLS} FROM app.project_tracked_competitor c WHERE c.project_id = :pid ORDER BY c.brand_name"
LIST_VEHICLES = f"SELECT {VEH_COLS} FROM app.project_tracked_vehicle v WHERE v.project_id = :pid ORDER BY v.brand, v.model"
BRAND_ROW = "SELECT canonical_name, aliases FROM app.project_tracked_brand WHERE project_id = :pid AND canonical_name = :name"
LOCK_PROJECT = "SELECT brand_code FROM app.project WHERE project_id = :pid FOR UPDATE"

UPSERT_BRAND = """
INSERT INTO app.project_tracked_brand (project_id, canonical_name, aliases) VALUES (:pid, :name, CAST(:aliases AS text[]))
ON CONFLICT (project_id, canonical_name) DO UPDATE SET aliases = EXCLUDED.aliases
"""
DELETE_BRAND = "DELETE FROM app.project_tracked_brand WHERE project_id = :pid AND canonical_name = :name"

INSERT_COMPETITOR = f"""
INSERT INTO app.project_tracked_competitor AS c (project_id, brand_name, aliases, notes)
VALUES (:pid, :name, CAST(:aliases AS text[]), :notes)
ON CONFLICT (project_id, brand_name) DO NOTHING
RETURNING {COMP_COLS}
"""
DELETE_COMPETITOR = "DELETE FROM app.project_tracked_competitor WHERE project_id = :pid AND brand_name = :name RETURNING brand_name"
CLEAR_TARGET = "UPDATE app.project_tracked_competitor SET is_target = false WHERE project_id = :pid AND is_target"
SET_TARGET = "UPDATE app.project_tracked_competitor SET is_target = true WHERE project_id = :pid AND brand_name = :name RETURNING brand_name"

INSERT_VEHICLE = f"""
INSERT INTO app.project_tracked_vehicle AS v (project_id, brand, model, segment, aliases)
VALUES (:pid, :brand, :model, :segment, CAST(:aliases AS text[]))
ON CONFLICT (project_id, brand, model) DO NOTHING
RETURNING {VEH_COLS}
"""
AUTO_COMPETITOR = """
INSERT INTO app.project_tracked_competitor (project_id, brand_name) VALUES (:pid, :name)
ON CONFLICT (project_id, brand_name) DO NOTHING
"""
DELETE_VEHICLE = "DELETE FROM app.project_tracked_vehicle WHERE project_id = :pid AND brand = :brand AND model = :model RETURNING model"
