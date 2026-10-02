-- ════════════════════════════════════════════════════════════════════════════
-- 화면 키 `S1.periodCompare` 켜기 — 기간 비교 Δ (GGMD-107 / WU B3)
-- ════════════════════════════════════════════════════════════════════════════
--
-- 이 파일은 **실행되지 않은 상태로** 커밋된다. 켜는 것은 운영 결정이고 — 기간을 고른
-- 화면의 **카드 값 자체와 증감이 모두 바뀐다**(실측: 글로벌 무필터 AI 노출률 7일 창이
-- 오늘 기준 76.27%(28,656/37,570) → 앵커 기준 74.57%(56,033/75,138)) — 고객 고지와
-- 승인 뒤에 사람이 실행한다. 고지 문안은 proposal "고객 고지 (컷오프 전)" 6항.
--
-- 정본 경로는 스크립트다:
--     npx tsx --env-file=.env.local scripts/summary/read-switch.ts screens '[...]'
-- 이 SQL 은 그 스크립트를 못 쓰는 환경(Supabase SQL Editor)용 **같은 뜻의 문장**이다.
--
-- ── 이 키 하나가 두 가지를 함께 켠다 ───────────────────────────────────────
--
--   ① 기간 프리셋의 **끝점** `E`(= 최신 노출 회차 앵커일) — 값의 창
--   ② **창 대 창** Δ 산식 — 증감의 창
--
-- 둘을 따로 켜는 스위치는 **일부러 만들지 않았다**. 갈리면 같은 카드에서 값과 Δ 가
-- 서로를 설명하지 못한다(design §1-3 B안 기각 근거).
--
-- ── ⚠️ `read_screens` 는 단순 목록이 아니다 ────────────────────────────────
--
-- 값의 의미는 `lib/summary/read/screens.ts` 가 정본이고, 세 가지가 다르다:
--   · 행 없음 · 빈 문자열 · '[]'  → **전 화면 허용**. 단, 옵트인 키는 그래도 꺼진다.
--   · 비어 있지 않은 배열         → **그 목록으로 제한**. 목록에 없는 화면은 미러 폴백.
--   · 파싱 불가 · 미지 키만       → **전 화면 차단**(fail-closed).
--
-- 그래서 `'["S1.periodCompare"]'` 로 **덮어쓰면 안 된다** — 지금 켜져 있던 다른 화면이
-- 전부 미러로 떨어진다(= 고객이 보는 숫자가 통째로 바뀐다). 아래 UPDATE 는 현재 목록에
-- **덧붙이기만** 한다.

-- ── ① 지금 값을 먼저 읽는다 (읽기 전용) ────────────────────────────────────
SELECT key,
       value,
       updated_at,
       CASE
         WHEN value IS NULL OR btrim(value) = '' OR btrim(value) = '[]'
           THEN 'ALLOW_ALL (옵트인 키는 꺼짐) — 아래 ②를 그대로 쓰면 안 된다. ③을 보라.'
         ELSE 'RESTRICTED — ②로 덧붙이면 된다.'
       END AS interpretation
FROM summary_settings
WHERE key = 'read_screens';

-- ── ② 이미 제한 목록이 있는 경우: 덧붙이기 (멱등) ──────────────────────────
--
-- 현재 값이 **비어 있지 않은 JSON 배열**일 때만 움직인다. 이미 들어 있으면 no-op 이고,
-- rowcount 가 0 이면 전제(위 ①의 interpretation)가 RESTRICTED 가 아니었다는 뜻이다.
UPDATE summary_settings
SET value = (
      SELECT jsonb_agg(DISTINCT e ORDER BY e)::text
      FROM (
        SELECT jsonb_array_elements_text(value::jsonb) AS e
        UNION
        SELECT 'S1.periodCompare'
      ) s
    ),
    updated_at = now()
WHERE key = 'read_screens'
  AND value IS NOT NULL
  AND btrim(value) NOT IN ('', '[]')
  AND jsonb_typeof(value::jsonb) = 'array'
  AND jsonb_array_length(value::jsonb) > 0
  AND NOT (value::jsonb ? 'S1.periodCompare')
RETURNING key, value, updated_at;

-- ── ③ 행이 없거나 값이 '[]'(전 화면 허용)인 경우 ───────────────────────────
--
-- 여기서는 **자동으로 하지 않는다.** '[]' 에 키 하나를 넣는 순간 의미가
-- "전 화면 허용" → "이 하나만 허용" 으로 뒤집혀, 지금 사실표로 서빙되던 화면이 전부
-- 미러로 떨어진다.
--
-- 그때는 **지금 켜 두려는 화면을 전부 적어야** 한다. 목록은 그 시점의 운영 현황에서
-- 확인한다(위 ①의 `value`). 이 주석에 예시 목록을 적지 않는 이유는, 사본이 그 순간부터
-- 실제 설정과 갈리기 때문이다.

-- ── ④ 되돌리기 ─────────────────────────────────────────────────────────────
--
-- UPDATE summary_settings
-- SET value = (SELECT jsonb_agg(e ORDER BY e)::text
--              FROM jsonb_array_elements_text(value::jsonb) AS e
--              WHERE e <> 'S1.periodCompare'),
--     updated_at = now()
-- WHERE key = 'read_screens' AND value::jsonb ? 'S1.periodCompare'
-- RETURNING key, value, updated_at;

-- ── ⑤ 적용일(선택) — 상수를 덮어쓰고 싶을 때만 ─────────────────────────────
--
-- 기본은 코드 상수 `lib/kpi/period-compare.ts::PERIOD_COMPARE_EPOCH` 다. 이 행이 있으면
-- **그것이 이긴다**(design §14-1). 새 산식은 `cur.hi >= epoch` 인 구간에만 걸리므로,
-- 적용일 이전 구간을 직접 조회하면 종전 Δ 가 그대로 나온다(기발행 리포트 재현).
-- 형식은 `YYYY-MM-DD` — 아니면 코드가 무시하고 상수로 돌아간다.
--
-- INSERT INTO summary_settings (key, value, updated_at)
-- VALUES ('period_compare_epoch', '2026-09-19', now())
-- ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
-- RETURNING key, value, updated_at;
--
-- 바꾼 뒤에는 캐시를 무효화한다(적용일은 캐시 키에 넣지 않는다 — design §14-2):
--     POST /api/internal/summary/published

-- ── ⑥ 프리뷰에서만 미리 보려면 이 파일이 필요 없다 ─────────────────────────
--
-- 프리뷰와 프로덕션이 같은 `summary_settings` 를 읽는지 **미확인**이다(design §11-2·§16).
-- 같다면 이 SQL 은 프로덕션에도 켠다. 프리뷰에서만 보려면 env 를 쓴다:
--     PERIOD_COMPARE_FORCE=1   (Vercel Environment: Preview 에만)
-- 판정은 `lib/summary/read/period-compare-flag.ts` — `VERCEL_ENV=preview` 가 아니면 이
-- 변수를 아예 읽지 않으므로 프로덕션에 실수로 설정돼도 켜지지 않는다.
