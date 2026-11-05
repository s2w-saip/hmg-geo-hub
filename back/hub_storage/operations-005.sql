-- Incremental migration (2026-11-05): a region or country account has one brand. The scope is stored and applied
-- flat (brands × the regions' or chosen countries), so two brands would cross: 'Hyundai Europe + Kia North America'
-- would also read Hyundai US and Kia DE (admin-todo 결정 기록 '범위 교차', 2026-11-02). RHQ regions are per brand
-- (kia-western-europe …), so one brand removes the crossing without changing the stored shape. HQ keeps several
-- brands. The API refuses the other counts too (bff/hub_stores/accounts.py scope_of); this keeps the table's shape.
ALTER TABLE system.global_role DROP CONSTRAINT global_role_scope;
ALTER TABLE system.global_role
    ADD CONSTRAINT global_role_scope CHECK(CASE role
        WHEN 'admin' THEN brands='{}' AND regions='{}' AND countries='{}'
        WHEN 'hq' THEN cardinality(brands)>0 AND regions='{}' AND countries='{}'
        WHEN 'region' THEN cardinality(brands)=1 AND cardinality(regions)>0 AND countries='{}'
        ELSE cardinality(brands)=1 AND cardinality(regions)>0 AND cardinality(countries)>0 END);
