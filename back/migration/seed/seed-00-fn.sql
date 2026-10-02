-- seed-00-fn.sql : 시드·검증 공용 세션 함수(pg_temp, 세션 종료 시 소멸). 영구 객체를 만들지 않는다.
-- 현행 TS 정규화의 SQL 쌍둥이. 파리티는 verify 스크립트가 TS 덤프 결과와 md5 로 대조한다.

-- JS String.prototype.trim() 이 지우는 문자 집합: lib/scope/text-trim.ts:18 JS_TRIM_CHARS
CREATE OR REPLACE FUNCTION pg_temp.js_trim(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT btrim(t, E'\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
$f$;

-- normalizeUrlForMatch: lib/scope/url-match.ts:29-43 (trim → lower → scheme → www → fragment → 트래킹 3패스 → 끝 슬래시)
--   TRACKING_PARAM :19-20, TRACK_MID(g) :25, TRACK_HEAD(1회) :26, TRACK_ONLY(1회) :27
CREATE OR REPLACE FUNCTION pg_temp.norm_match(raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN raw IS NULL OR raw = '' THEN '' ELSE
    regexp_replace(
     regexp_replace(
      regexp_replace(
       regexp_replace(
        regexp_replace(
         regexp_replace(
          regexp_replace(lower(pg_temp.js_trim(raw)), '^https?://', ''),
         '^www\.', ''),
        '#.*$', ''),
       '&(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*', '', 'g'),
      '\?(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*&', '?'),
     '\?(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*$', ''),
    '/+$', '') END
$f$;

-- ownedBasePrefixFromUrl: lib/geo-catalog/owned.ts:137-146 (normalizeOwnedBaseUrl :121-125 = 위 정규화 후 '?' 앞)
CREATE OR REPLACE FUNCTION pg_temp.owned_prefix(raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  WITH n AS (SELECT split_part(pg_temp.norm_match(raw), '?', 1) AS norm),
       s AS (SELECT norm,
                    CASE WHEN strpos(norm, '/') = 0 THEN NULL ELSE regexp_replace(norm, '^.*/', '') END AS seg,
                    regexp_replace(norm, '/[^/]*$', '') AS head
               FROM n)
  SELECT CASE WHEN norm = '' THEN ''
              WHEN seg IS NULL THEN norm
              WHEN seg ~ '^(main|index|home)(\.[a-z0-9]+)?$' THEN head
              WHEN seg ~ '^(.+)\.html?$' THEN head || '/' || regexp_replace(seg, '\.html?$', '')
              ELSE norm END
    FROM s
$f$;

-- run_month: run 시작 시각의 KST 월 1일(DB-적재-쓰기-스키마.sql:22 "started_at KST 월 1일 = ing 파티션 키 원천")
CREATE OR REPLACE FUNCTION pg_temp.kst_month(t timestamptz) RETURNS date LANGUAGE sql STABLE AS $f$
  SELECT date_trunc('month', t AT TIME ZONE 'Asia/Seoul')::date
$f$;
