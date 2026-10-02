## KPI ⑤ Base-URL Attribution Policy

### Summary

KPI ⑤ `AI Citation Share` is defined on two separate axes:

- Answer attribution: the market where the answer was collected
- Citation attribution: the canonical HMG site base URL that the cited URL belongs to

This means an answer asked from Italy can remain an Italy answer even when it
quotes a UK page. The answer is attributed to Italy; the citation is attributed
to the UK base.

### Core Rule

KPI ⑤ numerator counts citations whose cited URL belongs to a predefined HMG
site base URL set.

The base URL set includes country/language path splits when they define the
localized site boundary, for example:

- `kia.com/it`
- `hyundai.com/kr/ko/e`
- `genesis.com/us/en`

KPI ⑤ denominator counts every citation found in the collected answers.

Formula:

`citations to predefined HMG site base URLs ÷ total source citations × 100`

### Attribution Model

1. Answers are grouped by the market where they were collected.
2. Citations inside those answers are matched against canonical HMG base URLs.
3. Citation ownership is determined from the cited URL, not from the asking market.
4. Region is always a roll-up of the answer's collected country.

Example:

- asked market: Italy
- cited URL: `https://www.kia.com/uk/...`

Result:

- answer attribution: Italy
- citation attribution: Kia UK base

### Context Rules

#### Standard

Use the predefined HMG site base URL set.

#### Website

Use the predefined HMG site base URL set.

#### Project

Use the project's owned base URL set.

- when `projects.domain` is set: use that explicit base
- otherwise: fall back to the geo-catalog entries for the project's brand and country

### Normalization

KPI ⑤ base matching ignores:

- scheme (`http/https`)
- leading `www.`
- query strings
- fragments
- trailing slashes

It preserves the meaningful site boundary defined by the base path.

Examples:

- `https://www.kia.com/it?utm=foo` → `kia.com/it`
- `https://kia.com/it/models/sportage` matches base `kia.com/it`
- `https://kia.com/uk` does not match base `kia.com/it`

### Notes

- KPI ⑤ uses base-URL attribution, not a coarse owned-domain heuristic.
- KPI ⑥ remains a separate KPI for tracked target URLs under a project-owned base.
- Operational maintenance for the Standard / Website owned-base inventory is
  documented in `docs/kpi5-owned-base-operations-playbook.md`.
