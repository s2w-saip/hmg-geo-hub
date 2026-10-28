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

Deliberate changes (what the screen shows changed by decision):
- 2026-10-28 citation URL country (the user's decision: Gold, not the legacy hard-coded catalog). The domain
  detail URL country is Gold's — the reader sends `urls[].country` = dim_url.owner_key → dim_owned_base.geo_code
  (contract DetailUrl.country) and the screen passes it on; the front web-geo catalog port
  (`citation_geo.py`, `citation_geo_data.py`) and its `citation/fn-geo-country` case are gone.
  `citation/route-detail-live`: the tape's URLs carry the country Gold gives them today, the output the same.
  `citation/route-detail-fix`, `citation/fn-to-domain-drilldown`: the fixture URLs carry the code of the country
  the old case named ("not a url" none), the output the same.

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
| `ov` | 120 | summary cards, trends, period compare and labels, competitor rows (library functions) |
| `overview` | 375 | `/dashboard`, `/website`, `/renewal/dashboard` screens |
| `mention` | 475 | mention analysis pages, drilldowns, renewal mention |
| `citation` | 68 | citation analysis pages, sub pages, domain routes, renewal citation |
| `acr` | 133 | ACR pages (standard, website/project, renewal) |
| `website-prompts` | 2 | `/website/prompts` query derivation and list key |

Run: `cd back && MSYS_NO_PATHCONV=1 docker run --rm -v "$(cygpath -w "$PWD"):/work/back:ro" -w /work/back hgh-gold-api:icu-test python -m unittest bff.tests.test_golden` (add `-e GOLDEN_ONLY=<family>[,<family>]` for some families).
