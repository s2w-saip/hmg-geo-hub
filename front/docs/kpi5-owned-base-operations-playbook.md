## KPI ⑤ Owned Base Operations Playbook

### Purpose

This playbook defines how operators maintain the canonical owned-base inventory
used by KPI ⑤ `AI Citation Share` for:

- `Standard`
- `Website`

Project-scoped KPI ⑤ is managed separately through project-owned base settings.

### Source Of Truth

The effective owned-base inventory in code is built from these layers:

1. `lib/geo-catalog/_data/web-geo-final.json`
2. `lib/geo-catalog/index.ts`
3. `EXCLUDED_OWNED_DOMAINS`
4. `GEO_OWNED_BASES` / `GEO_OWNED_BASE_PREFIXES` derived exports

Operationally, the human-reviewed reference list is the validated HMG master
inventory such as `HMG_정본리스트_검증_20260522.xlsx`.

### Rule Set

1. KPI ⑤ uses canonical localized base URLs, not coarse domain ownership.
2. A shared host may yield multiple owned bases when market/language path splits
   are meaningful, such as `kia.com/it` and `kia.com/uk`.
3. A raw geo-catalog row is not automatically eligible for KPI ⑤.
4. Rows excluded by validated master review must remain excluded even if they
   still exist in the raw geo catalog.
5. Exclusions are currently applied at registrable-domain level in
   `EXCLUDED_OWNED_DOMAINS`.

### Update Flow

#### 1. Confirm the operator request type

- `Add`: a new owned site should count toward KPI ⑤.
- `Remove`: an existing site should no longer count toward KPI ⑤.
- `Correct`: existing row is right in principle but wrong in path, market split,
  or normalization.

#### 2. Check the validated inventory first

- If the site is present in the validated HMG list, it is a candidate for KPI ⑤.
- If the site is absent from the validated list, do not add it to KPI ⑤ only
  because it appears in raw geo-catalog data.

#### 3. Update geo-catalog data

- Add or correct the row in the upstream geo catalog source that generates
  `web-geo-final.json`.
- Keep the localized URL as the canonical site boundary.

Examples:

- `https://www.kia.com/it/it`
- `https://www.hyundai.com/kr/ko/e`
- `https://www.genesis.com/us/en`

#### 4. Update exclusion rules when needed

If a site exists in raw geo-catalog but must not count toward KPI ⑤, update:

- `lib/geo-catalog/index.ts`
- `EXCLUDED_OWNED_DOMAINS`

Use exclusions when:

- the site was explicitly removed by operator decision
- the site is not in the validated HMG master inventory
- the host is operational but outside KPI ⑤ ownership policy

#### 5. Rebuild and review derived owned-base outputs

The effective KPI ⑤ inventory is the derived result of:

- `GEO_OWNED_BASES`
- `GEO_OWNED_BASE_PREFIXES`
- `ownedBaseEntryForUrl()`

Review especially:

- shared-host path splits
- country/language lower path boundaries
- unintended whole-domain exclusions

### Verification Checklist

#### Local code verification

Run:

```bash
npx tsc --noEmit
npx vitest run lib/geo-catalog/index.test.ts lib/scope/url-match.test.ts lib/db/repositories/scope-aggregates.urlmatch.test.ts app/[locale]/(dash)/website/_data/live.test.ts
```

Check:

- owned base normalization still matches policy
- shared-host path boundaries still behave correctly
- website KPI ⑤ still rolls up from owned-base attribution

#### URL normalization verification

Run:

```bash
npm run verify:url-match
```

This confirms SQL and JS normalization stay aligned for:

- scheme stripping
- `www.` stripping
- query/fragment handling
- trailing slash handling
- path-prefix boundary matching

#### Live-domain verification

Code validation is not enough for this step. Operators should separately verify
that each newly added canonical site is actually live and intended for KPI ⑤.

Minimum checks:

1. Open the canonical URL in a browser.
2. Confirm it resolves without obvious parking/error behavior.
3. Confirm the market/language boundary is correct.
4. Confirm it belongs to the intended HMG brand/property.
5. Record the decision source if the site is excluded despite being live.

Important:

- A site can be live and still be excluded from KPI ⑤.
- A site should not be added only because DNS/HTTP resolves.

### Review Questions Before Merge

1. Does the change follow the validated HMG master inventory?
2. Is the canonical base at the right host/path boundary?
3. Will a shared host accidentally absorb a sibling market?
4. Is an exclusion needed because the raw catalog is broader than KPI policy?
5. Were live-domain checks performed outside the app and recorded?

### Common Failure Modes

- Adding a host-level row when KPI ⑤ needs a path-level localized base
- Forgetting to exclude a raw geo-catalog row that is not in the validated list
- Removing one market on a shared host by excluding the whole registrable domain
- Treating live reachability as ownership approval
- Updating policy docs but not `EXCLUDED_OWNED_DOMAINS`

### Current Code Anchors

- `lib/geo-catalog/index.ts`
- `docs/kpi5-base-url-attribution-policy.md`
- `docs/kpi6-domain-url-normalization-policy.md`
- `app/[locale]/(dash)/website/_data/live.ts`
- `lib/db/repositories/scope-aggregates.ts`
