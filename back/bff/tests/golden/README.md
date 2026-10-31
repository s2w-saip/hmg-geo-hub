# Screen goldens

Frozen expected outputs for the BFF screens (`back/bff/screens/`). Each case was produced by running
the **front's TypeScript computation before it moved to the API** (the adapters and view models the
pages used, plus the client-side derivations) and recording what it returned. The Python port must
reproduce every case exactly; `bff.tests.test_golden` replays all of them.

- Recorded 2026-10-26 from the working tree at the time of the move, against Gold release 443
  (generation 5, rule signature `2026-10-25.provisional.2`) and the HUB analytics DB.
- The TypeScript sources and the recording scripts were removed once the screens replaced them, so the
  cases cannot be re-recorded. Treat them as a contract: a change that breaks a case changes what a
  screen shows and needs a deliberate decision, not a re-recording.

Changes since recording (additive, each derived only from functions pinned by other goldens):
- 2026-10-27 `mention/*kpi-period*`: `output.periodSlots` added (the chip and caption PeriodDeltaSlot used to
  compute in the browser, now built by `mention.period_slots` from `period_chip`/`period_caption`, which the
  `ov` goldens pin to the old TypeScript).
- 2026-10-30 `acr/renewal` (all 41 cases): `body.asOf` added — the `funnel/acr` read's `meta.as_of` (the snapshot's
  round, a period's last), which the page names in its header pill, summary chip and footer (metric review ⚠️ #1: the
  page showed no measurement date). Each case differs from its previous output by that one key only.
- 2026-10-30 renewal Mention brand trend `pin_top_rival` (the user's go-ahead: the auto compare brand follows the
  original screens' rule, the rival with the largest share on the snapshot, `mention_surfaces.comparison_of`). Every
  renewal read of the KPI brand trend now asks the reader for that rival too (`pinned` when the round total leaves it
  outside the top 10; the competitor average and the rank chart leave it out). The 18 `mention/rn-fix-*` ·
  `rn-live-*` bundle tapes got `pin_top_rival=true` on their one `trend` dimension=brand entry (the key only); the
  bodies are the recorded answers, which hold no pinned rival, so no output changes.

Deliberate changes (what the screen shows changed by decision):
- 2026-10-28 citation URL country (the user's decision: Gold, not the legacy hard-coded catalog). The domain
  detail URL country is Gold's — the reader sends `urls[].country` = dim_url.owner_key → dim_owned_base.geo_code
  (contract DetailUrl.country) and the screen passes it on; the front web-geo catalog port
  (`citation_geo.py`, `citation_geo_data.py`) and its `citation/fn-geo-country` case are gone.
  `citation/route-detail-live`: the tape's URLs carry the country Gold gives them today, the output the same.
  `citation/route-detail-fix`, `citation/fn-to-domain-drilldown`: the fixture URLs carry the code of the country
  the old case named ("not a url" none), the output the same.
- 2026-10-29 ACR 당사 = every own brand (metric review R1; the user's go-ahead to fix the review's mismatches).
  The renewal page summed the own brands among the top series (rounded values, Genesis left out) and counted the
  standing inside the brand table. The reader now sends `own.brands` · `own.rank` · `own.ranked_brands` and
  `trend.buckets[].own`, and the renewal view takes 당사's brands, trend and standing from them; the distribution
  sheet's 당사 column counts every `is_ours` entry. Every `acr/*` tape got the new fields from what it holds (the
  table's own brands, then the other own brands its sheets show; a one-round trend's own = `own.choice`, else
  the own series summed; the standing from `choice_share`). Outputs that change, all `acr/renewal`:
  `rn-default` (ownTrend 11.4 → 12.4 = 4,441 ÷ 35,927, chip + Genesis, sheet 당사 column and orders),
  `rn-hmg-us` (ownTrend 12.1 → 12.0, rounded once), and 14 fixtures whose `own` is null although cells exist —
  a state the reader never sends — now show no 당사 (no own brands, rank and field size null, the page hides the
  standing line), or an own trend where none of the own brands had a series (`fix-rn-r31`: 0.0).
- 2026-10-29 a Δ or a gap is the exact difference rounded once (metric review R2). The front subtracted two values
  it had already rounded to 0.1, off by up to 0.1 (Overview AI 우선 노출도 2.286 → 2.345 showed "no change";
  ACR "Toyota에 5.3pp 뒤짐" for 12.36 vs 17.74). `_convert.Exact` keeps the exact value behind every rounded
  percent and rank (`round1`, `pct1_or_*`, `rank_avg` and the screens' local rounding), sums keep the sum of exact
  values, and every Δ and gap subtracts exact values (`delta1`): the Overview cards, sparkline WoW, brand matrix
  and website tiles, the competitor Δs, the Mention Δs, gaps and averages, the Citation category Δ and finding
  gaps, the ACR Δ, gap and the map's average line (`k`, `dev`). Two whole-percent displays get a value rounded once
  from the exact share: the Citation opportunity finding (`params.share`, 50.49 → 50, was 50.5 → "51") and the
  category tooltip's top domains (`top[].pct`). 109 cases change (screen and function cases), only in those
  values and what is drawn from them (Δ bar scale `cap`, Δ mark size `deltaMark.r`; the Mention engine cards' gap
  to the rival average, which keeps its exact mean: `rn-fn-engine-rows`, `rn-fn-rate-engines`, `rn-fn-summary`); function cases whose inputs
  are already rounded now take Δ from the less rounded intermediate (a sum of shares, an average) — the same rule.
- 2026-10-29 period mode compares the period with the one before, on the values the page shows (metric review R3).
  Mention and Citation show live values, so their `kpi/compare` reads lost `card` (the Δ was the card release's);
  the per-answer citation rate divides by the citation population's answers; a rival's, an engine's and a Citation
  category's Δ next to a period total compares it with the period before (reads of the period before: Mention
  `mentions/brands` and `kpi/engines`, Citation `citations/sources`); the AI 인용 점유율 card and tile get the
  period comparison too (`citation_share`). Tapes: the Mention / Citation `kpi/compare` entries answer without
  `card` (same recorded body); the Overview / website `kpi/compare` entries gain a `citation_share` item answered
  as not recorded (`suppressed`, `no_data` — so 5 website cases now show that tile's suppression caption); the
  reads of the period before were never recorded and answer empty, so those cases show no rival / engine /
  category Δ in period mode. 25 cases change, only in those Δs, the period blocks and what is drawn from them
  (findings, orders, `cap`); `ov/fn-to-compare-result` maps `citation_share` (it was dropped).
- 2026-10-29 the readers apply the filters, picks, sorts and searches of the contract (metric review R4), and the
  Citation screen follows the 출처 filter. A category tooltip's top domains come from every source
  (`citations/sources` `categories[].top_sources`, carried as `live.categories[].top`), not the domain table's
  first page; under a 출처 filter the prompt split is not computed (the original's rule: `promptSplit` absent →
  `notComputed`, tiles off) and 공식(HMG) takes its category Δ from the filtered category trend (the card trend
  has no 출처 axis). Tapes: every `citations/sources` category got `top_sources` from the case's own domain read
  (first three per category, in order — what the old code picked); function cases' citation models got
  `categories[].top` the same way. 21 cases change: the new `top` key, the 출처-filter cases (`promptSplit`,
  status tiles, 공식(HMG) Δ), and `fn-rn-category-rows`, whose fixture domains are not in citation order (the
  top is now by citations).
- 2026-10-29 ACR read range and model source (metric review R5). A snapshot's trend spans the last 12 ACR rounds
  (the contract's `trend_cycles`; it held the one snapshot round, so no Δ); a model's conversion is its final picks
  over the repetitions of the cells it was a candidate in, from every repetition's level-2 row (the contract's
  AcrModelRow), the models picked at least once, best first, 12 of them (it came from one representative repetition
  per cell, every model); sheets come most rows first and a sheet row's brands most picked first. The renewal view:
  the distribution finding counts the sheet's prompts 당사 was never picked in, of its prompts (not rows without a
  당사 entry, of the cells), and an engine bar keeps prompts nobody was picked in apart (`noneWins`; `restBase` =
  prompts another brand won). Reader-side changes leave the tapes as recorded; 35 `acr/renewal` cases change, only in
  `engineWins[].noneWins` / `restBase` and the distribution finding (and the top four findings it enters or leaves).
- 2026-10-29 metric review R6. A domain uncited in a week has no rank in the Citation bump (it ranked among the
  cited ones); a Mention treemap group's share is of every mention, the base of the brands' shares (it divided by the
  shown brands' sum; the 1.5 % fold follows the same base). `rn-fn-treemap-groups` calls get the base as the new
  argument, set to the shown rows' sum each case used, so their outputs stay. 19 cases change, only in the bump's
  ranks, moves and movers and the treemap's shares and folded groups.
- 2026-10-29 the Overview AI 인용 점유율 card's competitor row takes each source's brand and category from Gold
  (metric review ⚠️, the user's go-ahead): it guessed the brand from the domain's first label with the old front's
  token table (`competitor-brand.ts` port: bydauto.com.br read as none, smart.com as smart for Gold's Smart,
  maybach.com folded into Mercedes-Benz) and filed every source as official competitor. The rows now carry
  `competitor_sources[].competitor_brand` and the category's name, and fold by Gold's brand; the table and its
  `ov/fn-competitor-brand-of-domain`, `ov/fn-domain-first-label` cases are gone. Tapes: fixture competitor sources
  (no brand, no category) got the brand the table read from their domain and Official (Competitor); the ones it
  could not read are dropped (the reader sends only sources Gold gives a brand). Function cases' domain rows got
  `brand` the same way. Only `ov/fn-to-competitor-citation-domains` changes (rows carry `brand`; the dropped
  sources' rows are gone); every screen case, the live tapes included, shows the same row.
- 2026-10-29 ACR distribution sheets on demand, and no 최빈 without a pick (the user's go-ahead after the ACR load
  diagnosis: every sheet's rows were 94 % of the renewal page's 4.4 MB answer, and a row nobody was picked in showed
  its alphabetically first candidate as 최빈, "Audi 0"). The reader sends every territory sheet's `row_count`; with
  `territory_rows=first` (the renewal page's read) only the first sheet carries its rows, and `funnel/acr/territory`
  sends one sheet (screen `acr/renewal-sheet`, read when its tab opens). The renewal view: `sheets` are the tabs
  (`key`, `region`, `engine`, `count`) and `sheet` is the first sheet as it was built; a row whose first entry has no
  pick has `top` null. Tapes: every `funnel/acr` sheet got `row_count` from its rows; the `acr/renewal` reads ask
  `territory_rows=first` and keep the first sheet's rows only. The 35 `acr/renewal` cases with a view change, only in
  `sheets` / `sheet` (taken from the old sheets: the counts are their rows, `sheet` is the old first one) and the
  `top` of rows without a pick (first sheet: `rn-default` 30 rows, `rn-hmg-us` 53, `rn-kia-period` 31, and 12
  fixtures); the standard and website/project outputs stay.
- 2026-10-29 renewal Mention load (the user's request to speed the page up; what the page shows is the same). The
  brand drawer opens from the ranking's rows only (the first 100 body brands), so `mention/rn-shell` sends the drawer
  rows of those brands, not of every body brand (0.3–0.6 MB the whole body waited on). The 9 `rn-live-*` cases
  change only in `rn-shell.drawer` (454 → 100, 493, 215, 460, 454, 215, 460, 752, 752 → 100 rows); every kept row is
  the old one, and each case's ranking brands all keep theirs.
  The reader then honoured the contract's `mentions/brands` `include` (prompts · multi · types · hmg): a row field
  and its read only when asked for. The website / project mention views ask for `multi` too (they read it; the
  reader had sent it unasked) and the period before's read asks for none (it gives the Δ of rate, share, position
  and sentiment only). Tapes: those 40 entries carry the new request, and every `mentions/brands` body lost the row
  fields its request does not ask for (`is_hmg_own`, `prompts`, `multi`, `types`, `types_total`) — 307 cases, no
  output changes.
- 2026-10-29 ACR 분포 card redesign (the user's picks after the ACR data analysis: 당사's state in three classes with
  filters, 당사 열세 first). The reader sends one row per prompt — its cells in the read window summed (a round
  re-measures a prompt up to 20 times; a period holds its rounds) — with `cells` and each entry's `appearance`. A
  renewal sheet row carries `state` (pick / listed: a candidate never picked / absent), `candidates` and `cells`; its
  bar `entries` are the brands picked; `present` and the CSV pivot are the brands picked in the sheet; `counts` per
  state; `orders[sort][state]` for 당사 열세 (the most picked rival's share − 당사's), 당사 몫 and the prompt.
  Tapes: every `funnel/acr` sheet row got `cells` 1 and every entry `appearance` = its choice, at least 1 (a tape row
  was one cell, and the tapes recorded which brands a cell listed, not how often). The 35 `acr/renewal` cases with a
  view change only in `view.sheet`, rebuilt by the new code after checking it against the recorded one: the rest of
  the view, every row's kept fields, the picked entries and the old text / own orders (now `[...]["all"]`) are the same.
- 2026-10-29 ACR rounds not compared (the user's decision on the measurement break, P1 of
  docs/handoff/acr-next-session.html: for the same prompts, countries and engines the answers judged generic went
  76.8 % → 2.6 % from the 09-28 to the 10-05 round, and 27 % → 86 % at 08-31, with the same models and Gold rule,
  so a Δ, a trend or a period sum across rounds shows a change of measurement as a change of the market). Until Gold
  marks each round's measurement method `acr.COMPARE_ROUNDS` is off — no date, no inferred boundary: the renewal
  view sends `compareRounds` false, no trend (`dates` [], `ownTrend` and every brand's `trend` null) and no Δ
  (`ownDelta`, `d` null, `showDelta` false), so the mover finding and the standing finding's move are gone; a period
  of several rounds sends `held` {rounds, from, to} and no view. The 41 `acr/renewal` cases: built with the switch
  on, each equals its recorded output (plus `held` null and `compareRounds` true); with it off they change only in
  those fields (33 views; `fix-rn-r02` and `fix-rn-r17` are periods of two rounds, held; 9 mover findings dropped,
  none entered). The standard and website/project outputs stay.
- 2026-10-29 ACR battle rows in a fixed order (the user's pick when the reader's brand, 당사, battle and model sums
  moved into the database for speed: 1.2 → 0.86 s, a month 4.3 → 1.6 s). `funnel/acr` sent the battle rows in the
  entity table's physical order — no contract names it, and a rewrite of the table reshuffles it while the pages show
  the first 30. A row now comes at its prompt's first cell (round_date, acr_cell_key, the territory rows' rule) and
  its cells at their engine's first cell. Against live Gold, every other field of 12 reads (snapshot, a month, every
  round, all sheets, Kia, US·ChatGPT, ko, card, limits, website, two sheets) is the same as before; the battle rows and
  cells are the same set. The renewal snapshot's first 30 rows stay under 전체 and 당사 미선택; 엔진 갈림 shows the
  same 30 with 8 moved. No case changes (the tapes hold the reader's answers).
- 2026-10-29 ACR 후보 → 선택 전환 and 결선 맞대결 cards (the user's approval of their definitions; 후보 탈락 count first
  with its share shown). The reader: every `funnel/acr` and `funnel/acr/territory` sheet carries `states` {pick, listed,
  absent} — 당사's state in its prompt rows by the 분포 rows' rule, rows sent or not; `include_head_to_head=true` adds
  `head_to_head` {sample, rows per engine × rival: iterations, own_wins, rival_wins} from acr_iter_fact and
  acr_iter_shortlist (about one repetition per cell, a sample the card says; brand_key 0 "(이름 없음)", Gold's no-brand
  key, is no rival and its wins are no pick). The renewal page asks for it and its view adds `conversion` and `duels`.
  Tapes: every `funnel/acr` sheet got `states` — from its rows where the tape holds them all, else from the same case's
  34e2f3b tape, which held every sheet's rows (167 sheets; the 21 renewal first sheets agree both ways); 65 renewal
  sheets in 8 cases keep a `row_count` above their prompts (the 10-29 migration counted cells), so their states add up
  to the prompts. Every `funnel/acr` answer got `head_to_head`: null, or an empty sample on the renewal reads, which now
  ask `include_head_to_head` (no repetitions were recorded). The 33 `acr/renewal` cases with a view change only by the
  two new keys; the standard and website/project outputs stay. Against live Gold every sheet's `states` equal the
  screen's own classification of its rows (snapshot, a month, every round, Kia, Genesis card) and the head-to-head gives
  the 10-29 analysis' figures (Toyota 7.9 % / 35.9 %, Tesla 13.2 / 28.5, BMW 16.5 / 8.0).
- 2026-10-29 ACR rounds not compared: the reason revised, and the standard and website/project pages too (the user's
  decision after a trend analysis; they take a measurement-method change as normal, not a reason to hide). The rounds
  measured different markets and questions — 6–9 countries and 54–88 questions with KR at 38–52 % of the repetitions up
  to 08-24, 51 countries and 926 questions since 09-28 — so the line showed the measured scope (08-17 → 08-24: −6.0 pp
  over all cells, +7.0 pp on the questions both rounds measured), and on the same questions every week-on-week move was
  within sampling noise (e.g. 09-07 → 09-14 −0.3 pp, ±0.4). `COMPARE_ROUNDS` stays off until the user turns it on when
  rounds on the same scope have built up. `acr/standard` and `acr/gold` (`live_vm`) send no trend (`trendRows`,
  `trendBrands` []), `compareRounds` and `held` (a period of several rounds: its rounds and an empty view). The 86
  standard and website/project cases: built with the switch on, each equals its recorded output (plus `compareRounds`
  true, `held` null); with it off 55 lose their trend only, 27 had none, and `fix-std-r02`, `fix-std-r17`,
  `fix-gold-r02`, `fix-gold-r17` are periods of two rounds, held.
- 2026-10-29 ACR rounds compared again (the user's final call the same day: the measurement method, and with it the
  measured scope, may change any week, and the reader takes that, so no value is hidden for it). `acr.COMPARE_ROUNDS`
  is on: every ACR page shows its trend, its Δ and the sums of a period of several rounds. The 121 `acr` cases that
  the hold had changed were rebuilt with the switch on. Each of the 133 outputs equals its 341a09e output (before the
  hold), apart from the keys added since (`compareRounds` true, `held` null, and the renewal `conversion` · `duels`).
- 2026-10-29 the ACR hold removed (the user's go-ahead). The switch, `held_rounds` and the `compareRounds` and `held`
  keys are gone from the renewal body, the renewal view and the standard and website/project views, and so are the
  pages' hold notes. The 127 `acr` cases that carried the keys were rebuilt. Each of the 133 outputs now equals its
  341a09e output apart from the renewal `conversion` · `duels`.
- 2026-10-29 renewal Mention BI review, defects A1–A6 (the user's go-ahead). The Gold reader's `trend` now answers
  `dimension=type` and `dims` (none · engine · type) as the contract says: M08 type_exposure per bucket and type = the
  cells' own type answers over the bucket's answers, which equal `mentions/types` own_answers round by round. It
  answered no dims, so the engine KPI load always lacked its type trend and was marked degraded. Changed cases, all
  renewal Mention (`rn-*`, 24 files; the tapes hold the reader's answers, so no other case changes):
  - `rn-favor-hero.trendMissing` follows the rate hero's rule (the overview slots draw): true → false in the 20 cases
    whose load has slots; the points were already there and are unchanged.
  - 유형별 감정 `rows[0]` (전체) is every 당사 mention (the `rn-favor-dist` counts, e.g. 175,995 / 325,173 = 54.1 %), not
    the type rows summed (368,346 / 633,786 = 58.1 %): the bundle cases' 전체 row equals their 감정 분포 segments and
    the type rows are unchanged; `rn-fn-favor-matrix(-model)` pass no totals and lose the 전체 row.
  - The 당사 type lines (`rn-fn-rate-types`, `rn-fn-type-own-rows`): a round with type answers draws. The shared
    `type_combo_points` keeps only rounds with measurement days, which the reader sends as null, so every line was
    empty; `spark`, `delta` and `hasSpark` change, the legacy page's cases stay.
- 2026-10-30 ACR tape `row_count` = the sheet's prompts. The 10-29 migration gave 65 `funnel/acr` sheets in 8 cases the
  count of their cells (the reader sends its prompts, one row per prompt), so their `states` added up to fewer rows
  than `row_count`. Those sheets now carry `row_count` = Σ `states`. The 6 `acr/standard` cases (`std-brand-kia` 17
  sheets, `std-default` 20, `std-engine-chatgpt`, `std-geo-us`, `std-lang-ko` 1 each, `std-open-from` 2) keep their
  outputs (the standard view does not show the count); the 2 `acr/renewal` cases change only in those tabs'
  `view.sheets[].count` (`rn-default` 20 tabs, e.g. US · ChatGPT 80 → 65; `rn-kia-period` 3, its first sheet 47 → 43).
  The first sheet of `rn-kia-period` and the standard tapes' sheet rows stay one per cell, as recorded.
- 2026-10-30 the renewal brand table names what failed (metric review ⚠️ Overview #31/#32). `overview/brand-matrix`
  adds `degraded` — the old labels of the parts that failed transiently (COMPETITOR_LABELS order, then
  `standardTrend:day` for the table's own trend) — only when one did. `overview/fix-rn-matrix-10`
  (`["standardTrend:day"]`) and `fix-rn-matrix-11` (`["standardMentions"]`) change, nothing else.
- 2026-10-30 a renewal Mention hero without a value sends no parts (metric review ⚠️ Mention #69: "—%" over "0 / 0").
  `rn-rate-value` `numerator`/`denominator` are null when `pct` is, `rn-favor-hero` `positive`/`total` when
  `positivePct` is, `rn-rank` `hero.rankedAnswers` and `ahead` when `hero.avgPosition` is. 7 `mention` cases change
  only in those keys: `rn-fix-nulls`, `rn-fix-suppressed`, `rn-live-month`, `rn-live-week` (0 → null),
  `rn-fn-rate-value`, `rn-fn-favor-hero` (0 → null), `rn-fn-rank` (0 → null; 6 random calls whose overview card has no
  position but a count, e.g. call 2: 120 → null).
- 2026-10-30 no HUB threshold in the renewal summaries (W6 Website review, the user's go-ahead: the HUB makes no
  'meaningful change' call). The Mention and Citation findings take one fixed order (Mention `FINDING_ORDER`: standing →
  engine → type → negative → mover → climb; Citation: standing → engineGap → typeGap → opportunity → mover → skew →
  climb) instead of priorities set by cut-offs (5pp, 4pp, −1.5pp, 40 %, 3 ranks, +0.3pp …); tones follow the direction
  only (a competitor's or a category's move is `info`); the negative-signal finding has no +0.3pp gate, the skew no 1pp
  gate (a move shown as 0.0 is still none); the Mention type finding is the smallest gap with no type preferred and no
  `params.strong`. The Citation matrix no longer greys columns under 30 citations: no `cols[].thin` / `anyThin`, every
  column is live, so `cap` and the skew may take a small column. 25 cases change, only in those keys and in which
  findings fill the four places: `citation/fn-matrix`, `fn-rn-findings`, `fn-rn-type-matrix`, `rn-fix-all-owned`,
  `rn-fix-degraded`, `rn-fix-picks-source`, `rn-fix-rounds`, `rn-live`; `mention/rn-fix-empty`, `rn-fix-names`,
  `rn-fix-nulls`, `rn-fix-period`, `rn-fix-rounds`, `rn-fix-ties`, `rn-fn-findings`, `rn-fn-summary`, and the 9
  `rn-live-*` bundles (`chatgpt`, `en`, `geo`, `kia`, `kpi-fav`, `kpi-rank`, `kpi-sov`, `none`, `period`).
  The renewal ACR summary followed on 2026-10-31 (renewal audit step 11-1, the entry below).
- 2026-10-31 renewal audit step 3 (Overview). 26 cases change, only in these keys:
  - 3-3: without 당사's share-of-voice numerator (`share_of_voice` absent or `num` null) the 경쟁사 대비 SOV has no value
    (`competitorSov.value` null); it took 당사's mentions as 0 and the website tile read "0.0배".
    `ov/fn-apply-competitor-sov-from-brands` (the 12 calls whose own mentions are null and whose reference has
    mentions: 0.0 → null) and the website fixtures without that numerator `overview/fix-w-summary-03`, `-06`, `-08`,
    `fix-w-deferred-09`.
  - 3-4: `overview/cards` `compareTitle` is the label the cards with a period block share, null when they differ (each
    card names its own `period.label`); it was the first compare result's label. A compare that answered for no card
    keeps that old label. `fix-g-cards-02`, `-03` (window labels with different rounds per metric → null),
    `fix-g-cards-10` (the one compared card's label with its rounds; the first result had none).
  - 3-5 (additive): under a period compare every website tile with a period chip names what it compares against
    (`periodLabel`, the `overview/cards` label rule) and `tiles.compareTitle` is the label they share, null when they
    differ; both are absent without a period compare. The renewal header said '바로 앞 같은 길이의 기간' for a calendar
    month too. 20 cases: `fix-w-summary-02`…`-06`, `fix-w-summary-admin-02`, `-03`, `-05`, `-06`, `fix-w-deferred-02`…`-06`,
    `-11`, `fix-w-deferred-admin-02`…`-06`. No live case changes.
- 2026-10-31 renewal audit step 4-4 (Overview competitor citation row). The citation-share minis keep the domains whose
  category slug is `officialCompetitor` (Gold `dim_category.slug`); they compared the name "Official (Competitor)",
  which is the HUB code table's and an admin may edit it. `to_competitor_citation_domains` passes the slug on as
  `categorySlug`. 3 function cases, no output a screen shows changes:
  - `ov/fn-to-competitor-citation-domains`: every output row gains `categorySlug`, the slug its recorded source holds
    (361 rows in 140 calls).
  - `ov/fn-competitor-citation-shares` (200 calls), `ov/fn-competitor-row` (106 calls): every recorded domain row in
    `args` gains `categorySlug`, the slug Gold's `dim_category` gives its recorded `category` name (null for a name Gold
    has none for: "News", null). The outputs are the recorded ones.

- 2026-10-31 renewal audit step 5 (Mention KPI tabs). 24 cases change, only in these keys:
  - 5-1 (additive): a KPI trend names each round's counts, as the original's tooltips and type chart did. `rn-rate-hero`
    `trend.ownNum` / `ownDen` (당사's numerator and denominator on `x`), `rn-favor-hero` `points[].positiveCount` /
    `total` (the signal counts under the positive share), `rn-rate-types` `own.<metric>.x` / `answers` (the exposure
    lines' rounds and each round's answers; [] for the share view) and `rows[].counts` (the type's own answers per
    round). A round without a rate sends none (null). `rn-fn-rate-hero` (242 calls), `rn-fn-favor-hero` (121),
    `rn-fn-rate-types` (121) and the 18 `rn-fix-*` · `rn-live-*` bundles.
  - 5-2 (additive): `mention/rn-summary` adds `monthLine` — in a calendar month the original's period line with the one
    compare metric no tab shows, 답변당 언급 수 (`mentionsPerAnswer`, which the reader answers when asked); null otherwise.
    The 18 bundles; only `rn-live-month` is a calendar month, and its `args` gained `ctx.today` 2026-10-31 so the line's
    month label (`presetKey` lastMonth) does not follow the replay day.
  - 5-4: the summary cards' 전체 언급 수 Δ (every brand's mentions, not a 당사 measure) is `neutral`; a rise read as
    good. Shared with the original website / project Mention: `mention/fix-view-website-01` (good → neutral), `-02`,
    `-04` (bad → neutral).
- 2026-10-31 renewal audit step 6-1 (Mention brand ranking, every brand). `mention/rn-ranking` sends a row for every
  body brand; it cut them to the first 100 (`BRANDS_TOP`), so the table could neither show nor search the rest (the
  original Global searched every brand and showed 100, the original website table showed every brand). The table shows
  100 first and adds 100 at a time. Each row past the first 100 carries `drawer` (the shell's drawer row shape, which
  the shell sends for the first 100 only), and `orders` index every row. The first 100 rows, `count`, `treemap` (still
  the top 100) and every other screen are unchanged. 9 cases: the `rn-live-*` bundles `chatgpt` (454 rows), `en`
  (493), `geo` (215), `kia` (460), `kpi-fav` (454), `kpi-rank` (215), `kpi-sov` (460), `none` (752), `period` (752).
- 2026-10-31 renewal audit step 8 (Mention attribution, treemap).
  - 8-1: the 'HMG 계열' badge (`sibling`) is Gold's flag, not the HUB name list Hyundai · Kia · Genesis. The renewal
    body brand read asks for `include=hmg` (`is_hmg_own` = dim_brand.own_bit; the original pages' read is unchanged) and
    `to_mentions_brand_live` keeps it as `hmgOwn`; `board`, `rank_board` (new last arg `brands`, the body rows),
    `_drawer_row` and `ranking_payload` take the badge from it. On the live data both rules pick the same brands
    (renewal audit U1), so the args and tapes gain the flag set by that rule and the outputs stay, except where noted:
    - tapes: the one `mentions/brands` entry of the 18 `rn-fix-*` · `rn-live-*` bundles gained `include=hmg` and each
      brand item `is_hmg_own` (the reader's own row true, a rival `name` ∈ {Hyundai, Kia, Genesis}). No output changes.
    - args: `rn-fn-board`, `rn-fn-rate-hero`, `rn-fn-rank`, `rn-fn-ranking`, `rn-fn-shell` (every brand row `hmgOwn`, the
      same rule), `rn-fn-rank-board` (the 4th and 5th args: `prev_brands` null when absent, `brands` = the fp latest rows
      with the flag), `rn-fn-is-hmg-sibling` (the first arg is the flag, was the name). Outputs unchanged, except
      `rn-fn-rank` calls 32, 92, 112, 117: a rank row names an HMG brand (Hyundai, Genesis) the call's random body rows
      do not hold, so no Gold flag and no badge (`sibling` true → false). Live, the rank rows come from the body read.
    - `mention/conv-to-mentions-live` (25 of 30 calls, the key only): the recorded reader items carry `is_hmg_own`, which
      a brand row now keeps as `hmgOwn`.
  - 8-2: the treemap folded the '자동차 외' group (`NON_AUTO_GROUP`) into '그 외' whatever its share; it now folds by the
    rule every group follows (under 1.5 %, or past the 14th). Only random inputs hold a large one (Alexa):
    `rn-fn-treemap-groups` (10 calls) and the `treemap` of `rn-fn-ranking` (12 calls). No live case changes (live
    '자동차 외' brands are 0.2 % of mentions).
- 2026-10-31 renewal audit step 9 (Citation). 7 cases change, only in these keys:
  - 9-1: a source preference matrix column without citations (`n` 0: a mention type no answer of the filter carries)
    has no share. `cols[].shares` and the view's `gaps` are null there (they were 0, drawn 0.0% and coloured), `live`
    keeps the columns with citations only when two or more have them, so the cap and the findings (typeGap, skew)
    leave it out. `citation/fn-rn-type-matrix` (21 of 120 calls: `shares`, `live`, `cap` in 2), and the fixtures whose
    definition column is 0, `rn-fix-all-owned`, `rn-fix-degraded`, `rn-fix-picks-source`, `rn-fix-rounds`
    (`rn.typeMatrix.m`: definition's shares and gaps null, `live` without it; cap and findings unchanged). When no
    type has citations `rn.typeMatrix` is `{status: "empty", m: null}` (the original type chart's empty note); no
    case holds that state. No live case changes (no type is 0 on the recorded filters).
  - 9-6: a tone URL row whose source has no category has `category` null; it read 'Other', Gold's category 13.
    `citation/sub-tone-fix-counts`, `sub-tone-fix-reuse` (`page.rows[1]`, a fixture row without a category). Gold
    has no such source on 2026-10-31 (dim_source.category_key is nullable, 0 null rows).
- 2026-10-31 renewal audit step 10-2 (Website domain table, every row). The renewal Website table shows every row it
  loads (the screen's first page of 200, then 200 more per '더 보기' through `citation/domains`, the original Website
  table's pages) and picks a category among them, so a route page's `views` cover every row of the page and the
  `citation/website` renewal `rn.table.views` every first-page row (both stopped at the first 100, the standard table's
  cut). 1 case changes: `citation/route-domains-live-more` (`views` of its 200 rows: `""` 100 → 200 indices, the
  categories with more indices and larger scales, two more categories). The other route cases hold 100 rows or fewer;
  the standard page keeps its top 100 (`rn-live` unchanged). No other key changes.
- 2026-10-31 renewal audit step 11 (ACR). 40 `acr/renewal` files are rewritten: 35 outputs change, 5 tapes only
  (`fix-rn-r08`, `-r26`, `-r32`, `-r34`, `-r36`). `acr/standard`, `acr/gold` and `rn-zz-empty` are unchanged.
  - 11-1 (the 2026-10-30 no-HUB-threshold rule, now for ACR): the findings take one fixed order (`acr.FINDING_ORDER`:
    standing → leak → engine → sweep → model → dist → mover, `pri` 7 … 1), the first four with a value. The cut-offs
    are gone: the leak's 6pp shortlist band and −0.5pp, the engine gap of 3, three sweeps, a 0.5pp move, three
    never-picked prompts. The leak is the rival whose 후보군 포함율 is closest to an own brand's (exact values, the first
    in table order on a tie) and their Top1 ACR difference (`delta1`), the own brand with the smallest difference;
    `params.dir` is less · more · same (0.0). An engine gap of 0 and a single sweep or never-picked prompt are facts; a
    move shown as 0.0 is none. Tones follow 당사's direction only: engine, sweep and dist are info, a competitor's move
    is info (it was warn when it rose). 33 outputs change in `body.view.findings`.
  - 11-2: the 'HMG 계열' badge is Gold's HMG flag, not the names Hyundai · Kia · Genesis. The reader sends `is_hmg`
    with every brand row (registry `acr_entity_fact.own_bit` ≠ 0, the value `is_ours` reads), model row (parent
    `dim_brand.own_bit` ≠ 0, the value its `is_ours` reads) and head-to-head row (`dim_brand.own_bit` ≠ 0, as its
    shortlist's own); `to_standard_acr` keeps it as `isHmg` when sent. The `funnel/acr` tapes of the `acr/renewal`
    cases gain the flag by the rule live Gold gives those names (renewal audit U1): a row's `is_ours`, or its name ∈
    {Hyundai, Kia, Genesis}. Outputs gain the `isHmg` key on brand rows, `leader` and model rows; no brand or duel
    badge changes on these tapes.
  - 11-3: a model is 당사 by Gold's `isOurs` alone (it was also its parent's name among the own brands) and its badge is
    `isHmg` and not 당사. 8 model rows of random tapes flip 당사 → 'HMG 계열' (`isOurs` false, the parent's name an own
    brand: `fix-rn-r02`, `-r04`, `-r10`, `-r17`, `-r24`, `-r25`, `-r28`), and 23 own model rows lose a `sibling` that the
    page never drew (당사 wins).
  - 11-4 (additive): `boardOrders` adds `choiceCount`, `appearanceCount` (descending, ties by rank) and `brand`
    (ascending, ko collation), the original brand table's sorts. Every measured case (35).
- 2026-10-31 renewal audit step 15 (⛔L, HUB rule 5: the HUB makes no baseline of its own). The renewal pages drop the
  baselines they made; the compare brands' own values are shown instead. 59 files, outputs only except one:
  - `acr/renewal` (35 measured cases: `fix-rn-hand`, 31 `fix-rn-rNN`, `rn-default`, `rn-hmg-us`, `rn-kia-period`): the
    map's 'brand average line' `view.k` (ΣTop1 ACR ÷ Σ후보군 포함율 of the brands shown) and each brand's `dev` · `devCsv`
    (the distance to it) are gone; the map draws each brand's two values as a dot (`mapX`, `mapY`, unchanged). No other
    key changes. The standing finding's `widened` is "same" when the gap change rounds to 0.0 (it read widened or
    narrowed); no recorded case has such a change.
  - Mention, the hero: `rate_hero_payload` · `hero_trend_series` lose `trend.average` (the top-10 rivals' mean per round
    over whichever had a value). `rn-fn-hero-trend-series` (726 calls), `rn-fn-rate-hero` (242) and the 18 bundles
    (`rn-fix-*` 7, `rn-live-*` 11, key `rn-rate-hero`).
  - Mention, the type card: `type_compare_rows` rows lose `avg` (the top-5 rivals' mean), and a type without a compare
    brand with a value has no reference (`ref` {null, null}) and no gap (it fell back to the mean); `rate_types_payload`
    loses `cmp.avgRef` and `cmp.rows[].avg`, and `options[pick].top` is the axis over 당사 and the picks only.
    `rn-fn-type-compare-rows` (318 of 363), `rn-fn-rate-types` (121), the bundles' `rn-rate-types`.
  - Mention, the summary: a type finding needs a compare brand (the pick without one, `options["0"]`, has none; a pick
    whose brands have no value on a type does not fall back), and a smallest type gap of 0.0 is level: tone info and
    `params.dir` "same" (it was 'ahead', tone good). The standing finding's `widened` is "same" when the gap change
    rounds to 0.0; no recorded case has one. `rn-fn-summary` (80 of 121), the bundles' `rn-summary` (13 of 18:
    `typeFindings`, `options[].type` · `order`). `rn-fn-findings`: the recorded type rows (args) are rewritten to the
    rows `type_compare_rows` gives now (no `avg`; a row whose reference was the mean has none: `ref` {null, null}, `gap`
    null; 106 of 121 calls), and 16 outputs change: 14 lose their type finding (its reference was the mean), 2 are level
    (Mercedes-Benz, BMW at 0.0: info, `dir` same).
  - Kept: the engine cards' 당사 vs 경쟁사 평균 (`engine_rows` `avg`, the original page's, a legacy KPI) and every live
    number. AI Conversion has no golden case (its render fixture is regenerated).
- 2026-10-31 renewal audit step 14 (period compare suppression, ⛔K; HUB rule 5: a value that jumps because the
  measured range changed is shown, not hidden or warned about). The reader (`kpi/compare`) suppresses only a comparison
  without a value to compare (`unsupported` · `no_prev` · `no_data`); `missing_share` (under 70 % of the planned
  collection), `start_window` · `start_month` (the start-of-measurement grace) are gone, and so are the screens' copy of
  those rules (`_period.compute_compare` · `compare_suppression_of` and helpers), their caption sentences
  (`period_caption` reason.missingShare · startWindow · startMonth) and the adapter's 2026-09-08 cut-off
  (`before_epoch` → no compare; the Gold reader never sent it). The recorded answers that held one of those reasons
  are rewritten to what the reader answers now: the item compares (`suppressed` false, `reason` null, `delta` by the
  reader's rule — `delta_of` on a reader item, the adapter's `legacy_compare_delta` on a CompareResult), the reason
  leaves `meta.suppressed`, and `meta.suppressed["*"] = "before_epoch"` is dropped. 34 files:
  - screen cases (tape `kpi/compare` and output): `overview/fix-g-cards-02`, `-04`, `-06`, `fix-w-deferred-10`,
    `fix-w-deferred-admin-04`, `-05`, `-06`, `fix-w-summary-05`, `fix-w-summary-admin-02`, `-04`, `-05`, `-06` and
    `mention/fix-kpi-period-01` (13). The card / tile period chips get their Δ, the captions name the round counts
    (`window`) or the next suppressed result's reason (on the website fixtures the synthesized `citation_share`
    `no_data`, see 2026-10-29 R3); the `before_epoch` fixtures (`fix-g-cards-04`, `-06`, `fix-w-deferred-10`,
    `fix-w-summary-admin-04`, `fix-kpi-period-01`) now show their recorded period compare instead of none.
  - function cases (args and outputs of the calls that held one): `mention/rn-fn-favor-hero` (33 of 121 calls, 10
    outputs), `rn-fn-favor-hero-model` (33, 10), `rn-fn-rank` (33, 14), `rn-fn-rank-hero-model` (33, 14),
    `rn-fn-rate-hero` (66 of 242, 17), `rn-fn-rate-hero-model` (66, 17), `rn-fn-resolve-delta` (31 of 85, 5),
    `rn-fn-tab-deltas` (33 of 121, 30); `ov/fn-fetch-period-compare-api` (38 of 110, 26), `fn-fetch-period-compare-view`
    (38, 26), `fn-period-caption` (136 of 379, 136: the caption of what the Δ compares), `fn-to-period-delta-view`
    (79 of 200, 65) (12). No call whose args stayed changed its output.
  - removed with their functions (9): `ov/fn-applies-missing-share`, `fn-compare-suppression-of-outcome`,
    `fn-compute-compare-outcome`, `fn-grace-days-outcome`, `fn-judge-start-month`, `fn-judge-start-window-outcome`,
    `fn-missing-share`, `fn-missing-share-known`, `fn-period-compare-applies-outcome`.
  - kept as recorded (the reason does not reach their output): `mention/rn-fn-summary`, `ov/fn-to-compare-result`,
    `fn-to-compare-results` (generic `suppressed` → no Δ) and the tapes of `overview/fix-g-cards-10`, `-13`, `-14`
    (pending cards). No live case and no citation case changes (no recorded Website reach pairs a published answer
    with a live one).

## Format

Each file is `<family>/<case>.json.gz` (compact JSON, gzip). Two kinds:

- **Screen case** `{screen, query, tape, output}`: `screen` is built with `query`; every `/v1` read it
  makes is answered from `tape` (`[{path, query, status, body}]`, keyed by path + decoded query pairs);
  an unrecorded read fails the case. `output` is the expected payload. Tapes are either live answers
  recorded from the Gold API or fixtures (synthetic answers that cover what the live data does not:
  several rounds, gaps, ties, den-0 and null values, .x5 rounding boundaries, negative deltas,
  suppressed and failed reads, Korean and mixed-case names).
- **Function case** `{fn, calls: [{args, output}]}`: `fn` is `module:function`; each call's JSON `args`
  must give `output`. Hand cases from the old unit tests plus seeded random inputs.

Comparison (`golden_util.diff`): same keys (a missing key is not `null`), numbers by value (`1 == 1.0`),
lists in order.

## Families

| Folder | Cases | Covers |
|---|---|---|
| `shared` | 64 | URL → filters, filters → API query, filter-bar options and dates, project gate |
| `ov` | 118 | summary cards, trends, period compare and labels, competitor rows (library functions) |
| `overview` | 375 | `/dashboard`, `/website`, `/renewal/dashboard` screens |
| `mention` | 475 | mention analysis pages, drilldowns, renewal mention |
| `citation` | 68 | citation analysis pages, sub pages, domain routes, renewal citation |
| `acr` | 133 | ACR pages (standard, website/project, renewal) |
| `website-prompts` | 2 | `/website/prompts` query derivation and list key |

Run: `cd back && MSYS_NO_PATHCONV=1 docker run --rm -v "$(cygpath -w "$PWD"):/work/back:ro" -w /work/back hgh-gold-api:icu-test python -m unittest bff.tests.test_golden` (add `-e GOLDEN_ONLY=<family>[,<family>]` for some families).
