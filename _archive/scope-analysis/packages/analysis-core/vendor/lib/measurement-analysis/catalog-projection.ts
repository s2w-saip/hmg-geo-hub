// 답변분석 프롬프트의 온톨로지 컨텍스트 투영 (change ontology-catalog-snapshot
// 4단계, 온톨로지 플랜 P1-1 수용기준 ②).
//
// **왜 별도 모듈인가.** 스냅샷(catalog-snapshot.ts)은 "원본과 전수 대조 차이 0건"이
// 계약이라 내용을 줄일 수 없다. 프롬프트에 넣는 것은 그 카탈로그의 **투영**이고,
// 투영은 의도적으로 줄인다. 두 관심사를 한 파일에 섞으면 "스냅샷이 원본과 다르다"가
// 정상 동작이 되어 대조 게이트가 죽는다(design §5).
//
// **줄이기 전의 상태** (llm.ts, 이 change 이전):
//
//   known_entities: catalog.slice(0, 500).map(e => ({
//     type, canonical_name, aliases: e.aliases.map(a => a.alias).slice(0, 20)
//   }))
//
// 산업 스코프드 카탈로그가 656 엔티티(store.ts:137 주석 실측)이므로 앞 500개가
// 통째로 들어가고, 엔티티마다 `{"type":"...","canonical_name":"...","aliases":[...]}`
// 의 **키·구두점 오버헤드가 본문보다 크다**. 요청당 12.4k 프롬프트 토큰이
// 답변분석 비용의 ~97%(일 $100~200)라는 실측의 본체가 여기다
// (scope-openrouter-gemini-byok-cost-analysis-2026-07-23).
//
// 세 가지를 동시에 건다. 순서가 중요하다 — ①이 없으면 ③이 정확도 회귀가 된다.
//
//  1. **관련도 우선 정렬.** 답변 본문(+ 리졸버의 경우 pending 표면)에 실제로
//     등장하는 엔티티를 앞으로 보낸다. 지금의 `slice(0, 500)` 은 스냅샷 도입 후
//     `(type, canonical_name, id)` 정렬이므로 **알파벳 뒤쪽 브랜드가 계통적으로
//     잘려나간다** — 자르는 총량을 줄이려면 무엇을 자르는지부터 고쳐야 한다.
//     (design §3 이 "정렬은 절단 경계를 바꾼다"로 예고한 부작용의 처분.)
//  2. **별칭 캡·중복 제거.** 20/30개 캡은 사실상 무제한이었다. 정규화 후 서로
//     같은 별칭과 canonical_name 과 같은 별칭을 버리고, 답변에 등장하는 별칭을
//     남은 자리에 우선 넣는다.
//  3. **압축 표기 + 토큰 예산.** JSON 객체 배열 → 탭 구분 1행/엔티티. 예산은
//     엔티티 **개수**가 아니라 추정 토큰으로 건다 — 개수 캡은 카탈로그 이름
//     길이가 바뀌면 조용히 예산을 넘긴다.
//
// **비가역적 손실이 아니다.** 투영은 프롬프트 입력에만 적용된다. 표면 → 엔티티
// 최종 해결은 store.ts 가 **전체 카탈로그**로 기계적으로 수행하므로, 투영에서
// 빠진 엔티티도 해결 대상에서 빠지지 않는다. LLM 에게 known_entities 는 "이 산업이
// 무엇인지"의 사전 정보(prior)이지 매칭 테이블이 아니다(llm.ts 시스템 프롬프트:
// "known_entities lists that industry's catalog").

import { estimateInputTokens } from "@/lib/llm/token-estimate";

import { compactSurface, normalizeSurface } from "./normalize";
import type { OntologyCatalogEntity } from "./schema";

/**
 * 타입 1글자 코드. 시스템 프롬프트에 범례를 두므로 매 요청 반복되는 것은
 * 1글자뿐이다(`"type":"ProductCategory"` = 6~7 토큰 → 1 토큰).
 */
const TYPE_CODE: Record<string, string> = {
  Brand: "B",
  Product: "P",
  ProductCategory: "C",
  Feature: "F",
  Industry: "I",
};

/** 시스템 프롬프트에 넣는 범례 — 정적이라 프롬프트 캐시에 들어간다. */
export const CATALOG_BLOCK_LEGEND =
  "known_entities is a TSV block, one entity per line: TYPE<TAB>canonical_name<TAB>alias1|alias2 " +
  "(aliases column may be empty). TYPE is one of B=Brand, P=Product, C=ProductCategory, F=Feature.";

/** id 를 포함하는 변형(리졸버용)의 범례. */
export const CATALOG_BLOCK_LEGEND_WITH_IDS =
  "known_entities is a TSV block, one entity per line: TYPE<TAB>id<TAB>canonical_name<TAB>alias1|alias2 " +
  "(aliases column may be empty). TYPE is one of B=Brand, P=Product, C=ProductCategory, F=Feature. " +
  "The id column is the only valid source for existing_entity_id.";

export interface CatalogProjectionOptions {
  /** 관련도 판정의 원문. 빈 문자열이면 관련도 가산 없이 입력 순서를 따른다. */
  answerText: string;
  /** 추가 관련도 신호 — 리졸버의 pending 표면 등. */
  extraSurfaces?: readonly string[];
  /** 추정 토큰 상한. 이 값을 넘기는 순간 더 넣지 않는다. */
  tokenBudget: number;
  /** 엔티티당 별칭 상한 (중복 제거 후). */
  maxAliasesPerEntity: number;
  /** 안전 상한 — 예산이 남아도 이 개수를 넘기지 않는다. */
  maxEntities: number;
  /** 리졸버처럼 LLM 이 entity id 를 돌려줘야 하는 경우 true. */
  includeIds?: boolean;
}

export interface CatalogProjection {
  /** 프롬프트에 그대로 넣는 블록. 엔티티가 없으면 빈 문자열. */
  text: string;
  /** 블록에 실린 엔티티 수. */
  entityCount: number;
  /** 블록에 실린 별칭 수. */
  aliasCount: number;
  /** `estimateInputTokens(text)` — 과대추정 쪽이라 예산 판정에 안전하다. */
  estimatedTokens: number;
  /** 답변/추가표면에 등장해 앞으로 당겨진 엔티티 수. */
  relevantCount: number;
  /** 그 중 실제로 블록에 실린 수 — 예산이 관련 엔티티를 자르면 여기서 보인다. */
  relevantIncluded: number;
  /** 예산·개수 상한으로 빠진 엔티티 수. */
  dropped: number;
}

/**
 * 표면 하나가 텍스트에 등장하는지. 정규화(NFKC+소문자) 형과 구두점 제거 형
 * 양쪽으로 본다 — store.ts 의 표면 매칭과 같은 두 축이다.
 *
 * 부분 문자열 판정이라 짧은 별칭(1~2자)은 오탐이 잦다. 오탐의 결과는 "관련
 * 없는 엔티티가 앞으로 온다"뿐이고 정확도 손실이 아니므로 허용하되, 1글자
 * 별칭은 거의 항상 걸리므로 제외한다.
 */
function occurs(
  haystackNorm: string,
  haystackCompact: string,
  surface: string,
): boolean {
  const norm = normalizeSurface(surface);
  if (norm.length >= 2 && haystackNorm.includes(norm)) return true;
  const compact = compactSurface(surface);
  return compact.length >= 2 && haystackCompact.includes(compact);
}

/**
 * 역방향 포함 — **표면이 엔티티 이름 안에** 들어 있는 경우.
 *
 * `occurs` 만으로는 리졸버에서 놓치는 축이 있다. pending 표면이 `싼타페` 인데
 * 카탈로그 canonical 이 `현대 싼타페` 면, 엔티티 이름은 답변/표면 어디에도 부분
 * 문자열로 나타나지 않는다(별칭이 마침 `싼타페` 로 있어야만 걸린다). 리졸버는
 * "known_entities 가 유일한 identity authority" 라는 계약이라, 정답 엔티티가
 * 블록에서 빠지면 해결 가능한 언급이 `keep_pending` 으로 떨어진다 — 토큰을 아끼려다
 * 해결률을 깎는 정확도 회귀다.
 *
 * 그래서 **추가 표면(extraSurfaces)에 한해** 역방향도 본다. 답변 본문 전체로
 * 역방향을 보면 거의 모든 엔티티가 걸려 의미가 없으므로 적용하지 않는다.
 */
function surfaceInsideEntity(
  entityNames: readonly string[],
  surfaceNorms: readonly string[],
): boolean {
  if (surfaceNorms.length === 0) return false;
  for (const name of entityNames) {
    const norm = normalizeSurface(name);
    const compact = compactSurface(name);
    for (const s of surfaceNorms) {
      if (s.length >= 2 && (norm.includes(s) || compact.includes(s))) return true;
    }
  }
  return false;
}

/**
 * 별칭을 정리한다: canonical 과 같은 것 제거 → 정규화 기준 중복 제거 →
 * 답변에 등장하는 것 우선 → 캡.
 *
 * 정렬은 **안정**이다. 같은 입력이면 같은 출력이어야 프롬프트가 결정적이고,
 * 그래야 프롬프트 캐시가 걸리고 회귀 비교가 성립한다.
 */
function selectAliases(
  entity: OntologyCatalogEntity,
  haystackNorm: string,
  haystackCompact: string,
  cap: number,
): string[] {
  const canonicalNorm = normalizeSurface(entity.canonicalName);
  const seen = new Set<string>([canonicalNorm]);
  const hits: string[] = [];
  const rest: string[] = [];
  for (const a of entity.aliases) {
    const alias = a.alias.trim();
    if (!alias) continue;
    // 탭·개행은 TSV 자체를 깨뜨린다. 별칭에 들어 있을 이유가 없지만 방어한다.
    if (/[\t\n\r|]/.test(alias)) continue;
    const norm = normalizeSurface(alias);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (occurs(haystackNorm, haystackCompact, alias)) hits.push(alias);
    else rest.push(alias);
  }
  return [...hits, ...rest].slice(0, cap);
}

function renderLine(
  entity: OntologyCatalogEntity,
  aliases: string[],
  includeIds: boolean,
): string {
  const code = TYPE_CODE[entity.type] ?? entity.type;
  const name = entity.canonicalName.replace(/[\t\n\r]/g, " ").trim();
  const cols = includeIds
    ? [code, entity.id, name, aliases.join("|")]
    : [code, name, aliases.join("|")];
  return cols.join("\t");
}

/**
 * 카탈로그를 프롬프트용 TSV 블록으로 투영한다.
 *
 * 결정적이다 — 같은 (카탈로그, 답변, 옵션)이면 같은 문자열. 카탈로그 입력 순서는
 * 스냅샷 경로에서 `(type, canonical_name, id)` 로 정렬돼 오므로, 관련도 동률
 * 구간의 순서도 회차마다 흔들리지 않는다.
 */
export function projectCatalogForPrompt(
  catalog: readonly OntologyCatalogEntity[],
  opts: CatalogProjectionOptions,
): CatalogProjection {
  const includeIds = opts.includeIds ?? false;
  const extraSurfaces = opts.extraSurfaces ?? [];
  const haystackRaw = [opts.answerText, ...extraSurfaces].join("\n");
  const haystackNorm = normalizeSurface(haystackRaw);
  const haystackCompact = compactSurface(haystackRaw);
  const extraNorms = [
    ...new Set(
      extraSurfaces.map((s) => normalizeSurface(s)).filter((s) => s.length >= 2),
    ),
  ];

  // 1단계 — 관련도 판정 + 별칭 선별. 입력 순서를 인덱스로 보존해 안정 정렬한다.
  const prepared = catalog.map((entity, index) => {
    const aliases = selectAliases(
      entity,
      haystackNorm,
      haystackCompact,
      opts.maxAliasesPerEntity,
    );
    const relevant =
      (haystackNorm.length > 0 &&
        (occurs(haystackNorm, haystackCompact, entity.canonicalName) ||
          entity.aliases.some((a) =>
            occurs(haystackNorm, haystackCompact, a.alias),
          ))) ||
      surfaceInsideEntity(
        [entity.canonicalName, ...entity.aliases.map((a) => a.alias)],
        extraNorms,
      );
    return { entity, aliases, relevant, index };
  });
  const relevantCount = prepared.filter((p) => p.relevant).length;

  // 2단계 — 관련 엔티티 우선, 그 안에서는 입력 순서 유지(안정).
  const ordered = [...prepared].sort(
    (a, b) => Number(b.relevant) - Number(a.relevant) || a.index - b.index,
  );

  // 3단계 — 토큰 예산까지 채운다. 개수가 아니라 추정 토큰이 기준이다.
  const lines: string[] = [];
  let tokens = 0;
  let aliasCount = 0;
  let relevantIncluded = 0;
  let taken = 0;
  for (const p of ordered) {
    if (taken >= opts.maxEntities) break;
    const line = renderLine(p.entity, p.aliases, includeIds);
    // +1 = 줄바꿈. 첫 줄도 같은 값으로 세어 예산이 과소평가되지 않게 한다.
    const cost = estimateInputTokens(line) + 1;
    if (tokens + cost > opts.tokenBudget) {
      // 관련 엔티티는 예산을 이유로 조용히 버려지면 안 된다 — 계측에 남기고
      // (relevantIncluded < relevantCount) 계속 순회하지 않고 여기서 끊는다.
      // 순서가 관련도 내림차순이므로 뒤에는 덜 중요한 것만 남는다.
      break;
    }
    lines.push(line);
    tokens += cost;
    aliasCount += p.aliases.length;
    if (p.relevant) relevantIncluded += 1;
    taken += 1;
  }

  return {
    text: lines.join("\n"),
    entityCount: lines.length,
    aliasCount,
    estimatedTokens: lines.length > 0 ? estimateInputTokens(lines.join("\n")) : 0,
    relevantCount,
    relevantIncluded,
    dropped: catalog.length - lines.length,
  };
}

/**
 * 이 change 이전의 투영 — **측정 기준선 전용**이다. 프로덕션 경로는 이 함수를
 * 부르지 않으며, `scripts/ontology/catalog-prompt-tokens.ts` 와 회귀 테스트가
 * "12.4k → ?" 를 같은 자로 재기 위해 쓴다.
 *
 * 기준선을 코드로 박아 두는 이유: 문서에 적힌 12.4k 는 프로덕션 실측치이고,
 * 리포에서 재현할 수 있어야 후속 변경이 기준선을 조용히 움직이지 못한다.
 */
export function legacyKnownEntitiesPayload(
  catalog: readonly OntologyCatalogEntity[],
  opts: { entityCap: number; aliasCap: number; includeIds: boolean },
): string {
  return JSON.stringify(
    catalog.slice(0, opts.entityCap).map((entity) => ({
      ...(opts.includeIds ? { id: entity.id } : {}),
      type: entity.type,
      canonical_name: entity.canonicalName,
      aliases: entity.aliases.map((a) => a.alias).slice(0, opts.aliasCap),
    })),
  );
}

// ---------------------------------------------------------------------------
// 예산 상수 — env 로 흔들 수 있게 두되, 기본값이 수용 기준이다
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 추출(extract) lane 의 온톨로지 컨텍스트 예산. 플랜 P1-1 수용 기준이
 * "12.4k → ≤4k" 이고, 이 lane 이 **상시 도는 쪽**(비용의 본체)이라 여기에 4k 를
 * 그대로 건다.
 */
export const EXTRACT_CATALOG_TOKEN_BUDGET = envInt(
  "MEASUREMENT_ANALYSIS_EXTRACT_CATALOG_TOKENS",
  4_000,
);

/**
 * 리졸버(resolve_pending) lane 의 예산 — **추출 lane 과 일부러 다르다**.
 *
 * 두 lane 은 known_entities 를 다르게 쓴다. 추출은 "이 산업이 무엇인지"의 사전
 * 정보로 쓰고(빠진 엔티티도 표면만 태깅되면 하류에서 전체 카탈로그로 해결된다),
 * 리졸버는 시스템 프롬프트가 명시하듯 **"the only identity authority"** 로 쓴다 —
 * 정답 엔티티가 블록에 없으면 해결 가능한 언급이 `keep_pending` 으로 떨어진다.
 * 즉 리졸버에서 예산 초과 절단은 비용 절감이 아니라 **해결률 회귀**다.
 *
 * ⚠️ **관련도 정렬이 이 lane 의 절단을 안전하게 만들어 주지 않는다.** 관련도
 * 판정(`occurs` · `surfaceInsideEntity`)은 정규화 부분문자열 = **어휘적**이다.
 * 그런데 리졸버에 오는 모집단은 결정적 매처가 이미 못 푼 표면들 — 로마자 표기,
 * 번역 표기, 별칭 없는 교차언어 표면처럼 **어휘적으로 안 겹치는 것들**이다.
 * 그래서 `relevant_included == relevant_count` 가 초록이어도 정답 엔티티는
 * 잘려 있을 수 있다. 추출 lane 에서 통하는 논리가 여기서는 통하지 않는다.
 *
 * 그래서 예산은 "실측 형상 한 벌이 **통째로** 들어가는" 크기로 잡는다.
 * `pnpm catalog:tokens` 실측(656 엔티티 × uuid + 별칭 4개, 전량 포함 시):
 *   lean 형상 20,706 · rich 형상 29,546 추정 토큰
 * → 32,000. rich 상한 위로 여유를 두되, 병적으로 큰 카탈로그에 대해서는 여전히
 * 하드 캡으로 동작한다(그 경우에만 관련도 순으로 잘린다).
 *
 * 초기 구현은 12,000 이었고 주석에 "전량이 들어가고도 남는다"고 적혀 있었다.
 * **같은 리포의 측정 스크립트가 그 주장을 반증했다** — 실제로는 656개 중
 * 295~408개만 들어가 38~55%가 잘렸다(적대적 검증 2026-08-02). 근거 없는 면제가
 * 무가드로 남아 있던 자리이므로, `catalog-projection.test.ts` 가 이제 실측 형상
 * 전량 포함을 단언한다.
 *
 * 4k 로 맞춰 절단하는 쪽이 "12.4k → 4k" 숫자는 예뻐지지만, 그건 수용 기준을
 * 정확도로 사는 것이다. 플랜 P1-1 의 수용 기준은 **추출 lane** 의 온톨로지
 * 컨텍스트이고, 비용의 본체도 상시 도는 그쪽이다.
 */
export const RESOLVE_CATALOG_TOKEN_BUDGET = envInt(
  "MEASUREMENT_ANALYSIS_RESOLVE_CATALOG_TOKENS",
  32_000,
);

export const EXTRACT_CATALOG_ALIAS_CAP = envInt(
  "MEASUREMENT_ANALYSIS_EXTRACT_ALIAS_CAP",
  4,
);
export const RESOLVE_CATALOG_ALIAS_CAP = envInt(
  "MEASUREMENT_ANALYSIS_RESOLVE_ALIAS_CAP",
  4,
);

/** 예산이 남아도 넘지 않는 안전 상한 — 기존 500/700 캡을 그대로 유지한다. */
export const EXTRACT_CATALOG_ENTITY_CAP = 500;
export const RESOLVE_CATALOG_ENTITY_CAP = 700;
