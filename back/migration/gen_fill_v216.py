"""fill-v216.sql 생성기(WEBREG16, WU-7): 테넌트 보고서 명세 front/scripts/reports/report-spec.json(hmg-geo 벤더 사본)을 app.website_report_unit 행으로.

사용: python back/migration/gen_fill_v216.py  → back/migration/fill-v216.sql 을 다시 쓴다(명세 파일이 바뀌면 다시 돌리고 커밋).
제외 유닛(app.website_report_excluded)은 운영 hmg-geo summary_settings.website_excluded_fs 값을 EXCLUDED 에 옮긴다(2026-09-05 값 [71,94,97]).
"""
from __future__ import annotations

import hashlib
import json
import pathlib

BACK = pathlib.Path(__file__).resolve().parents[1]
SPEC = BACK.parent / "front" / "scripts" / "reports" / "report-spec.json"
OUT = BACK / "migration" / "fill-v216.sql"
EXCLUDED = (71, 94, 97)            # 운영 summary_settings.website_excluded_fs(2026-10-01 WU-0 old-context 실측, updated_at 2026-09-05)


def _lit(v: object) -> str:
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def render() -> str:
    raw = SPEC.read_bytes()
    spec = json.loads(raw)
    rows = ",\n  ".join(f"({i}, {_lit(s['brand'])}, {_lit(s['cc'])}, {_lit(s.get('langCode'))}, {_lit(s.get('urlLike'))}, "
                        f"{_lit(s.get('urlNotLike'))}, {int(s['fs'])})" for i, s in enumerate(spec))
    excl = ", ".join(f"({x})" for x in EXCLUDED)
    sha = hashlib.sha256(raw).hexdigest()[:16]
    return f"""-- ============================================================================
-- 1회 채우기: DB-v2.16 P91~P93(WEBREG16 웹 보고서 유닛 게이트, WU-7). 이 파일은 back/migration/gen_fill_v216.py 가 만든다(손으로 고치지 않는다).
-- 원천: front/scripts/reports/report-spec.json sha256 {sha}… ({len(spec)}행) · 제외 유닛 = 운영 summary_settings.website_excluded_fs {list(EXCLUDED)}.
-- 무엇을: ① app.website_report_unit = 명세 행(값이 다른 행만, 명세에 없는 ix 는 지운다) ② app.website_report_excluded = 제외 유닛
--   ③ rd.refresh_web_report_prompt(NULL)(웹 프롬프트 전체, 바뀐 행만) ④ rd.assert_web_report_prompt().
-- 드라이런이 기본: 같은 쓰기를 한 트랜잭션에서 해 보고 개수만 낸 뒤 ROLLBACK(commit=1 이면 COMMIT). 롤 = migrator(app 두 표 쓰기 권한은 DB-v2.16).
--   psql -X -v ON_ERROR_STOP=1 -f fill-v216.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 -f fill-v216.sql
-- 뒤처리 없음: 세 표가 결과 캐시 추적 표라 바뀐 행이 있으면 데이터 버전이 오른다. 스위치 web_registered_only 를 켜기 전에 돌린다.
-- 규모: 웹 프롬프트 약 1.3만·명세 {len(spec)}행, 전체 판정 약 35ms(stg hmg_r2 2026-10-01 EXPLAIN ANALYZE). 출력 = 개수만.
-- ============================================================================
\\if :{{?commit}}
\\else
  \\set commit 0
\\endif
SET statement_timeout = '10min';
SET lock_timeout = '30s';
BEGIN;
DO $v$ BEGIN
  IF to_regprocedure('rd.refresh_web_report_prompt(int4[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.16 가 먼저 적용돼야 한다(rd.refresh_web_report_prompt 없음)';
  END IF;
END $v$;
CREATE TEMP TABLE _v216_unit (ix int2 PRIMARY KEY, brand_code text, country_code text, lang_code text, url_like text, url_not_like text,
                              spec_fs int) ON COMMIT DROP;
INSERT INTO _v216_unit VALUES
  {rows};
CREATE TEMP TABLE _v216_excl (file_seq int PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _v216_excl VALUES {excl};
SELECT 'unit_upsert' AS step, count(*) AS n FROM _v216_unit s LEFT JOIN app.website_report_unit u ON u.ix = s.ix
 WHERE (u.brand_code, u.country_code, u.lang_code, u.url_like, u.url_not_like, u.spec_fs)
       IS DISTINCT FROM (s.brand_code, s.country_code, s.lang_code, s.url_like, s.url_not_like, s.spec_fs)
UNION ALL SELECT 'unit_delete', count(*) FROM app.website_report_unit u WHERE NOT EXISTS (SELECT 1 FROM _v216_unit s WHERE s.ix = u.ix)
UNION ALL SELECT 'excluded_insert', count(*) FROM _v216_excl x WHERE NOT EXISTS (SELECT 1 FROM app.website_report_excluded e WHERE e.file_seq = x.file_seq)
UNION ALL SELECT 'excluded_delete', count(*) FROM app.website_report_excluded e WHERE NOT EXISTS (SELECT 1 FROM _v216_excl x WHERE x.file_seq = e.file_seq);
INSERT INTO app.website_report_unit AS u (ix, brand_code, country_code, lang_code, url_like, url_not_like, spec_fs)
SELECT * FROM _v216_unit
ON CONFLICT (ix) DO UPDATE SET brand_code = EXCLUDED.brand_code, country_code = EXCLUDED.country_code, lang_code = EXCLUDED.lang_code,
       url_like = EXCLUDED.url_like, url_not_like = EXCLUDED.url_not_like, spec_fs = EXCLUDED.spec_fs
 WHERE (u.brand_code, u.country_code, u.lang_code, u.url_like, u.url_not_like, u.spec_fs)
       IS DISTINCT FROM (EXCLUDED.brand_code, EXCLUDED.country_code, EXCLUDED.lang_code, EXCLUDED.url_like, EXCLUDED.url_not_like, EXCLUDED.spec_fs);
DELETE FROM app.website_report_unit u WHERE NOT EXISTS (SELECT 1 FROM _v216_unit s WHERE s.ix = u.ix);
INSERT INTO app.website_report_excluded (file_seq) SELECT file_seq FROM _v216_excl ON CONFLICT (file_seq) DO NOTHING;
DELETE FROM app.website_report_excluded e WHERE NOT EXISTS (SELECT 1 FROM _v216_excl x WHERE x.file_seq = e.file_seq);
SELECT 'prompt_refresh' AS step, rd.refresh_web_report_prompt(NULL) AS n;
SELECT 'prompt_assert' AS step, rd.assert_web_report_prompt() AS n;
SELECT 'prompt_excluded' AS step, count(*) AS n FROM rd.web_report_prompt w JOIN app.website_report_excluded e ON e.file_seq = w.report_fs;
\\if :commit
COMMIT;
\\else
ROLLBACK;
\\endif
"""


if __name__ == "__main__":
    OUT.write_text(render(), encoding="utf-8")
    print(OUT)
