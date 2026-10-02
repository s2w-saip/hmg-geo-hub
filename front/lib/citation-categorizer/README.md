# citation-categorizer

인용(citation) 도메인 → 출처 카테고리 분류기. Citation Sources 카드/파이/뱃지/테이블의 `category` 값을 만든다.

## 왜 존재하나

`scope_citations.category`는 원래 scope 엔진의 domain-classifier를 미러링할 예정이었으나 **scope는 citation category를 보내지 않는 것으로 확정**(2026-07-02). 이 모듈이 유일한 분류 소스다. aeorank의 citation-categorizer 핸드오프(docs/handoffs/citation-categorizer-package-*.md)를 참고하되, 런타임 LLM·DB 의존을 제거하고 이 레포 환경에 맞게 재설계했다:

- **순수 함수** — `categorizeDomain(domain)`은 동기·결정론적. DB 테이블·마이그레이션·백필 없음. 양쪽 읽기 경로(live result-adapter + scope_* 미러)가 집계 시점에 같은 함수를 통과하므로 live·mirror 패리티가 구조적으로 보장된다.
- **LLM 없음** — 분류 근거가 전부 코드(규칙)와 커밋된 seed(JSON)라 재현·감사·코드리뷰 가능.

## 분류 우선순위

0. **공식 HMG 소셜 계정 그룹 키** → `Official (HMG)` ([official-social.ts](official-social.ts))
1. **geo-catalog owned-domain set** → `Official (HMG)` (검증된 정본 인벤토리)
2. **seed.json** — 큐레이션된 명시 분류. 규칙 오탐 교정도 여기서 (예: `hyundai.news`는 딜러 휴리스틱보다 먼저 Official로)
3. **generic rules** (rules.ts) — **소유권 판정(HMG 브랜드 라벨 / 경쟁 OEM 공식) → 위키 → 플랫폼 목록(커뮤니티/소셜/블로그) → gov 접미사 → 딜러 패턴** 순. 소유권이 딜러 휴리스틱보다 **먼저**인 것이 계약이다 (2026-08-24: `hyundaimotorgroup.com` 27,640행이 `CONTAINED_BRAND` 에 걸려 딜러로 나가던 결함).
4. `Other` (fallback — aeorank 핸드오프의 baseline 유지)

입력은 **거의 항상** registrable domain 이고, 접기 정본은 `lib/public-suffix` **하나뿐**이다
(하드코딩 접미사 목록 금지 — `lib/scope/mirror/domain-normalization.test.ts` 가 강제).

### 예외: 공식 HMG 소셜 계정은 입력이 `도메인+계정경로` 다 (2026-08-28)

고객(SCORE) 결함 보고 — 당사 공식 소셜 계정 콘텐츠
(`linkedin.com/posts/hyundai-motor-group_…`)가 `linkedin.com` 으로 접히고,
`linkedin.com` 은 rules.ts 의 `SOCIAL_VIDEO` 라 전량 `Social & Video` 로 떨어졌다.
도메인이 그룹 키인 한 `linkedin.com` 안에서 공식 계정만 떼어낼 수 없다.

**제품 결정(2026-08-28)**: 인용 롤업의 그룹 키를 **공식 소셜 계정에 한해**
`도메인` → `도메인+계정경로` 로 확장한다. 목록·정규화 정본은
[official-social.ts](official-social.ts) **하나**이고, SQL 쌍둥이
(`lib/db/repositories/citation-group-key.ts`)가 **같은 배열에서 CASE 식을 생성**한다 —
목록을 복제하면 live/mirror 패리티가 깨진다.

- **경계 앵커가 계약이다.** 고객 파일의 "URL 포함"(부분문자열) 매칭을 그대로 쓰면
  `instagram.com/hyundai` 가 192건·고유 핸들 37개를 쓸어간다(정확히 그 계정은 26건).
- **owned(자사) 판정·KPI ⑤ 는 건드리지 않는다** — 그쪽은 raw registrable domain 위의
  base-URL prefix 매칭이고, 이번 변경은 **분류(category)** 만 바꾼다.
- **UI 열 표기는 "도메인" 그대로**(제품 결정) — 같은 주석이 SQL 헬퍼·JS 헬퍼·
  `citation-domain-table.tsx` 세 곳에 있다.
- 운영자 오버라이드(`citation_domain_overrides`)는 **도메인 키**라, 기존
  `linkedin.com` 오버라이드는 공식 계정 행에 더는 닿지 않는다(잔여 `linkedin.com`
  행에는 그대로 적용). 반대로 `linkedin.com/hyundai-motor-group` 을 직접 넣으면
  오버라이드가 공식 판정보다 우선한다(쓰기·읽기 정규화가 같아 동작한다).
  단 큐레이션 화면(`CITATION_DOMAIN_WEIGHT_SQL`)은 registrable domain 으로만
  집계하므로 이 키들이 목록에 뜨지 않는다.

### seed 출처 (2026-08-24) — 사람 사전 2종 + 판정 원장

`seed.json` **792**개는 사람이 전수 판정한 사전 두 개를 병합한 것이다.

| 사전 | 판정 대상 | 호스트 |
| --- | --- | ---: |
| 앤서 Quick-Win | 인용 6,801건 | 513 |
| 고객(이노션/HMG) GGMD | 인용 8,821건 | 593 |

두 사전은 **호스트** 단위(`newsroom.genesis.com`·`car.chosun.com`)인데 분류기 입력은
**registrable domain** 이다. 접기는 `lib/public-suffix` 하나만 쓰고
(`scripts/citations/merge-domain-dictionary.ts`), 한 도메인 아래 판정이 갈리면
**apex 호스트 우선 → 인용 건수 가중 다수결**로 정한 뒤 충돌을 전량 출력한다.

겹치는 252개 중 **40건이 불일치**했고, 교차하니 **양쪽 다 틀린 곳**이 드러났다. 그래서
사전 병합 위에 판정 원장 **`scripts/citations/dictionary-rulings.json`** 을 한 겹 더 둔다 —
어느 사전이 뭐라 했든 원장이 이긴다. `category: "Other"` 는 "seed 에 넣지 않는다"는 뜻이다
(Other 는 fallback 이라 명시 엔트리가 불필요). 원장은 **런타임에 로드되지 않는다** —
seed.json 이 유일한 런타임 소스이고, 원장은 그 값의 근거 기록이다.

```bash
# dry-run (아무것도 쓰지 않는다)
npx tsx scripts/citations/merge-domain-dictionary.ts <dict.csv|dict.json> \
  --rulings scripts/citations/dictionary-rulings.json
# 갱신
npx tsx scripts/citations/merge-domain-dictionary.ts <dict.csv|dict.json> \
  --rulings scripts/citations/dictionary-rulings.json --write
```

교차감사에서 반복해서 나온 오분류 패턴 둘 — 원장을 늘릴 때 먼저 의심할 것:

- **`.org`·권위기관을 정부·공공으로 보는 착시.** 기준은 **소유 주체가 정부·공공기관인가**다.
  J.D. Power·레드닷·IDSA·미쉐린 가이드·대학은 전부 민간이다. (양쪽 사전이 다 저질렀다 —
  고객은 jdpower/red-dot 을, 우리는 `adac.de` 를.)
- **이름의 단어에 속는 것.** `jejuforum.or.kr` 은 공공 국제포럼이지 커뮤니티가 아니고,
  `store.steampowered.com` 은 스토어지 커뮤니티가 아니다.

애매한 포털·다목적 도메인은 코드 seed 가 아니라 **운영자 오버라이드**
(`citation_domain_overrides` + 인용 출처 관리 화면)로 교정하는 것이 설계 의도다.

taxonomy는 taxonomy.ts의 단일 레벨 10종(subcategory 폐기, 마이그레이션 0016 참조). 값은 영문 표시명 그대로 — UI가 category 문자열을 raw 렌더링하는 기존 계약(scope raw 분류 가정)과 호환.

## seed 갱신 (리뷰 큐)

```bash
npx tsx --env-file=.env.local scripts/citations/seed-curation.ts [limit]
```

미러 기준 인용 가중치 상위의 미분류(Other) 도메인 목록 + 카테고리별 커버리지를 출력한다. 출력을 보고 seed.json에 항목을 추가 → 재실행으로 커버리지 확인. 2026-07-02 기준 커버리지(비-Other) **87.7%** (4,608 도메인 / 113,515 인용).

## 한계·후속

- 롱테일(인용 1~2회 도메인)은 Other — 주기적으로 위 스크립트로 리뷰.
- 카테고리 표시명 i18n(ko 라벨) 미적용 — UI가 raw 문자열을 쓰는 동안은 영문 고정. 도입 시 messages/{ko,en}.json 매핑 + 컴포넌트 3곳(badge/pie/table) 수정.
- LLM 분류가 필요해지면 seed 큐레이션 단계에만 붙인다(런타임 경로에는 넣지 않는다).
