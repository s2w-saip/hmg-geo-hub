// Brands that are real companies (so scope's NER correctly tags them as a
// Brand entity) but are not automotive competitors — excluded from 경쟁 브랜드
// comparisons at read/aggregation time, not deleted from the scope_mentions
// mirror, so the raw data stays intact if this policy is reconsidered later
// (2026-07-06 decision — see also lib/scope/mirror/case-sensitive-brands.ts
// for the separate case-sensitivity/NER-noise correction, which stays a
// write-time mirror correction since that one is a factual NER error, not a
// policy call).
//
// Verified 2026-07-06: brand="Apple" was 4205 scope_mentions rows, 91% of
// which co-occurred with "Apple CarPlay" / "Apple Watch" / "Apple App Store"
// (a connectivity feature reference, not a competitor mention), and even the
// "standalone" remainder ("Tesla and Apple, both known for tight ecosystems")
// is a tech aside, not a competing-automaker signal.
// 2026-08-28 미러 전수 재조사(rollup 표기별 mention_count 상위 260) — 위 Apple 과
// 같은 부류가 대량으로 더 있었다. 자동차 경쟁사가 아닌 (a) 보통명사 NER 오탐
// (b) 국가·지역명 (c) 유통·미디어·부품·금융 브랜드 (d) 범주 서술어. AE/Genesis
// 슬라이스 실측에서 이런 행들이 언급의 ~9% 를 차지해(Genesis 자신 6.9%보다 큼)
// SoV 분모를 부풀리고 랭킹을 오염시켰다.
//
// 판단 기준: "그 답변에서 이 이름이 현대·기아·제네시스와 경쟁하는 자동차
// 브랜드로 읽히는가". 애매한 둘은 아래 각주 참고.
import { NAME_BOUNDARY_CLASS, POSIX_LEADING_TRIM } from "./text-trim";

const NON_COMPETITOR_NOISE = [
  // 2026-08-31 2차 (GEO-2) — 실화면 검수에서 남아 있던 같은 부류.
  // Honda 롤업을 미러에서 뜯어보니 진짜 Honda(50,209)와 함께 소문자 오탐이
  // 붙어 있었다: pilot 7,693 · element 1,482 · fit 799. 1차 스캔이 언급 3,000
  // 임계였던 탓에 놓쳤다 — 2차는 임계를 400 으로 낮춰 전수로 훑었다.
  //
  // ⚠️ **당사 손실을 먼저 쟀고, 그게 후보를 잘랐다.** 같은 부류로 보였던
  // excel(3,444) · seven(2,612) · stellar(1,640) · click(1,482) 은 **전량
  // 당사 언급**이었다(Hyundai Excel/Stellar/Click). 총 9,178 건 — 넣었으면
  // 당사 지표를 그만큼 깎을 뻔했다. 후보를 볼 때 소문자 비중만 보지 말고
  // **rollup 이 당사인지** 반드시 함께 셀 것.
  "pilot", "falcon", "century", "element", "lightning", "punch", "one", "integra", "bolt", "fit",
  // 2026-08-31 (GEO-2) — **일반 영어 단어와 겹치는 차종·브랜드명.**
  // 아래는 전부 실제 자동차 이름이기도 하므로 **전량 배제하면 정탐을 죽인다.**
  // 그래서 BARE_ONLY_NON_COMPETITORS 에도 함께 넣어 bare 표기만 걸러내고
  // 이름붙은 제품("Focus ST"·"Golf GTI")은 되살린다.
  //
  // 선정 근거(미러 실측, surfaces 배열을 mention_count 로 가중):
  // 답변 속 실제 표기가 소문자인 비중 — focus 70.7% · legacy 68.8% ·
  // charger 77.3% · city 73.2% · edge 82.0% · is 85.5% · vision 58.3% ·
  // volt 77.2% · crown 85.2% · golf 57.6% · transit 67.4% · gravity 48.2% ·
  // fastback 43.8%. 실체는 "focus on" · "legacy system" · 충전기 · "city
  // driving" · "cutting edge" · be동사 is 등이다.
  //
  // ⚠️ 소문자 비중 **단독으로 판정하면 안 된다** — i30(91.0%)·i20(96.9%) 도
  // 소문자 전용이지만 정식 모델명이다. 일반 영어 단어인지를 함께 봐서 골랐다.
  //
  // ⚠️ 되살림 대상 전수 확인(2026-08-31): 이 14개로 되살아나는 행은 전부
  // 정당한 차종이었다 — Focus ST/Estate/Turnier · Charger Daytona · Golf GTI ·
  // IS 350 · Vision 74 · Transit Custom · Crown Toyota/Honda. 주석이 경고한
  // 비자동차 부활(Google Maps·Samsung Galaxy 계열)은 **0건**이다.
  //
  // ⚠️ 한계: 판정 시점이 집계(read-time)라 **행이 최소 단위**다. 한 mention
  // 행의 surfaces 에 대문자·소문자 표기가 섞여 있으면 쪼갤 수 없다(실측 혼재
  // 비중 legacy 37% · cruise 30% · transit 36% · golf 29%). 혼재 행은
  // **유지**한다 — 정탐 손실 0 을 택했다(2026-08-31 결정). 출현 단위로 자르려면
  // 미러 적재 시점(case-sensitive-brands.ts)이어야 하고 전량 재싱크가 든다.
  "focus", "legacy", "charger", "city", "edge", "is", "vision", "volt", "crown", "golf", "transit", "gravity", "fastback", "dual electronics",
  // 보통명사 NER 오탐 (전량 Brand 엔티티 1개, 하위 Product 없음)
  "across", "advanced", "clever", "contact", "dealership", "drift", "five",
  "flat", "guest", "impact", "index", "mass", "maximum", "miles", "modern",
  "motion", "option", "particular", "peak", "plus", "powerful", "race",
  "reach", "real", "record", "rise", "security", "sharp", "specialist",
  "specialized", "stack", "status", "torque", "urban", "victory", "wise",
  "/drive", "more than", "sure", "winners", "game", "silence", "alliance",
  // 국가·지역명
  "canada", "china", "usa", "germany", "australia", "españa",
  // 범주 서술어 (브랜드가 아니라 설명구)
  "automotive manufacturer", "automotive repair shop", "german automotive industry",
  "german luxury car brands", "italian automotive brands", "original equipment manufacturer",
  "third party", "local dealership", "credit union", "bank", "retailer",
  // 유통·미디어·평가기관·부품·금융 (자동차 브랜드 아님)
  "global pet foods", "jd power", "motor trend", "mobile.de", "point s",
  "dual electronics", "form lighting", "green filter", "event tires",
  "stance wheels", "kobalt", "target", "mark's", "a-premium", "digit insurance",
  "dollar rent a car", "app store", "amazon prime", "microsoft surface",
  "power performance", "wedge performance", "march performance", "evs tuning",
  "ethos car care", "western motorsports", "comp cams", "link ecu", "arka",
  "king george/kingsway dealership", "destination mazda", "pace american",
  "alcantara", "fila", "wahl", "reliance", "vanguard", "acsi", "ergo",
  // ── 한국어 NER 노이즈 (2026-08-29 비라틴 표기 전수 감사) ────────────────
  // 종전 확장은 라틴 표기만 훑어서, **같은 부류의 한국어 노이즈가 통째로 남아
  // 있었다**(PR #113 사후 검증이 목록으로만 남긴 항목). 판단 기준은 라틴 때와
  // 동일하다 — "그 답변에서 이 이름이 현대·기아·제네시스와 경쟁하는 자동차
  // 브랜드로 읽히는가". 감사 방법·전수 결과는 파일 하단 "비라틴 표기 감사" 절.
  // 괄호 안은 프로덕션 미러 전수 언급 수(2026-08-29).
  // 범주 서술어 (브랜드가 아니라 설명구 — 라틴 'german luxury car brands' 부류)
  "중고차 플랫폼", "일본 럭셔리 자동차 브랜드", "독일 자동차 브랜드",
  "프랑스 자동차 제조사", "국내 배터리 제조사", "대만 모터사이클 산업",
  "고가 브랜드", "저가 브랜드", "독3사",
  // 유통·정비·금융·기관·커뮤니티 (라틴 'local dealership'·'credit union' 부류)
  "캐피탈사", "자동차리콜센터", "국토교통부", "보배드림", "사설 정비소",
  "독립 정비소", "카센터", "온라인샵", "아우디 공식 딜러", "자동차 동호회",
  "차지비",
  // 부품·타이어·비자동차 기업 (라틴 'alcantara'·'event tires'·'apple' 부류)
  "순정부품", "삼성전자", "카카오", "레카로", "요코하마", "파파존스",
  // 보통명사 NER 오탐 — 둘 다 **부분문자열 오탐**이다(답변 원문 확인):
  //   테인  ← "인포**테인**먼트"      세나  ← "자동차**세나** 보험"·"시**세나** 감가"
  "테인", "세나",
  // 국가·지역명 (라틴 canada/china/usa/germany 부류)
  "말레이시아",
  // 오탐이지만 실제 자동차·모빌리티 브랜드와 이름이 겹치는 셋 — bare 엔티티만
  // 제외하고 하위 제품은 살린다. 근거·수치는 BARE_ONLY_NON_COMPETITORS 주석.
  "smart", "cruise", "international",
  // ⚠️ 아래 둘은 **알면서 감수하는 손실**이다 — 회계·기각한 대안은 바로 아래
  // "알면서 감수하는 부수 손실" 절.
  // 독일어 동사('운전하다')가 브랜드로 잡힌 것.
  "fahren",
  // 게임 타이틀 (Genesis X Gran Berlinetta Concept 의 협업 맥락에서 유입)
  "gran turismo",
];

// ── 알면서 감수하는 부수 손실 (2026-08-29 정정) ──────────────────────────────
// 종전 주석은 `fahren` 에 대해 "하위에 Dacia/Volvo 제품이 잘못 매달려 있으나, 그
// 오귀속은 canonRollupSql 표기 접두 교정이 담당한다"고 적었다. **사실이 아니다.**
// 접두 교정은 표기가 Hyundai/Kia/Genesis 로 **시작하는 것만** 구제한다 —
// `Dacia Spring Essential` 은 `Fahren` 으로도 `Hyundai` 로도 시작하지 않는다.
//
// 프로덕션 미러 전수(2026-08-29, rollup 그룹 단위 · bare = 자기 표기가 rollup 표기와
// 같은 행):
//   rollup          bare(노이즈)   하위 Product 언급
//   Fahren            177          1,208  ← 비율이 smart/cruise 와 **반대**
//   Gran Turismo      962            150
//   Dual Electronics 2,918            20
//   Torque           2,770            23
//   Peak               453            27
//   Alliance           112             6
// Fahren 하위 1,208 의 내역: Dacia Spring Essential 835 · Autogas 144 ·
// Volvo Amazon 102 · Fahrwerk 37 · Wagen 33 · BMW ConnectedRide Cradle 21 ·
// Michelin Road 5 GT 14 · 그 외 독일어 보통명사 22. 즉 **진짜 경쟁 브랜드 제품
// 974 · 독일어 명사 오탐 234**.
// Gran Turismo 하위 150 = `X Gran Berlinetta Concept`(당사 콘셉트카).
//
// 그럼에도 목록을 그대로 두는 근거 — **대안이 전부 더 나쁘다**:
//  (a) 이름을 목록에서 뺀다 → 경쟁 랭킹에 "Fahren" 1,385 · "Gran Turismo" 1,112
//      이라는 존재하지 않는 브랜드 행이 고객 화면에 뜬다. 지금은 안 보이는 손실이
//      보이는 오류가 된다.
//  (b) BARE_ONLY 메커니즘 확장 → 안 통한다. 하위 제품이 rollup 이름을 확장하지
//      않는다(`Dacia Spring Essential` 은 `Fahren` 으로 시작하지 않는다).
//  (c) 접두 규칙을 HMG 3사가 아니라 **미러의 Brand 표기 사전 전체**로 일반화 →
//      실측으로 기각. 표기 사전 1,235개에 대한 접두 lateral 조인은 이름당 29ms
//      (프로덕션 EXPLAIN ANALYZE: 5,000행 샘플 12.9초, Memoize 442 miss).
//      Product 표기가 3,198개이므로 **집계 쿼리 1개당 +93초** — statement timeout
//      (2분)에 붙고, 대시보드 1회 로드는 이런 쿼리를 여러 개 돈다. 종전
//      ROLLUP_NAMES 최적화가 733ms→14.8ms 를 벌어온 파일에서 3~4 자릿수 회귀다.
//      되찾을 수 있는 것은 경쟁사 제품 974 언급(전체 분모 4,224,977 의 0.023%)뿐이고
//      당사 언급은 하나도 못 되찾는다 — `X Gran Berlinetta Concept` 는 어떤 브랜드
//      표기로도 시작하지 않는다.
//
// 남는 결함 두 개는 여기가 아니라 **위(scope rollup)** 에서 고쳐야 한다:
//  · `X Gran Berlinetta Concept` 150 이 Gran Turismo 로 롤업된 것은 scope 의
//    오귀속이다. 같은 제품이 Genesis 롤업으로 247, Hyundai 롤업으로 36 이미
//    올바르게 붙어 있다(전체의 26% 만 어긋났다). 제외 목록을 어떻게 바꿔도 이 150
//    은 당사 tracked 로 돌아오지 않는다 — tracked 판정은 제외 목록을 보지 않는다.
//  · Dacia/Volvo/BMW 제품이 Fahren 으로 롤업된 것도 같은 성격의 상류 오귀속이다.
//
// 반대로 **구제되는 것은 확인했다**(SQL 경로 실측, non-competitor-parity.test 가 고정):
// `Peak` 밑 `Hyundai Aura` 25 · `Torque` 밑 `Kia Carens Clavis EV` 10 ·
// `Dual Electronics` 밑 `Hyundai Creta SX (O)` 1 · `Hyundai Creta N Line N8` 1 은
// canonRollupSql 접두 교정이 rollup 을 Hyundai/Kia 로 바꾸므로 `n.brand` 가
// 'Hyundai'/'Kia' 로 풀려 제외 목록에 걸리지 않는다.

// ── 비라틴 표기 감사 (2026-08-29) ───────────────────────────────────────────
// 감사 방법(재현 가능): 미러의 rollup 표기 사전(ROLLUP_NAMES 재귀 CTE, 1,246개)
// 에서 **라틴 문자를 하나도 안 가진 표기 72개**를 뽑고, 각각을 canonRollupSql
// 접두 교정을 적용한 뒤의 언급 수로 집계했다(HMG 접두에 걸리는 6개는 당사로
// 흡수돼 목록에서 사라진다 — 정상). 라틴·비라틴 혼합 표기 5개와, rollup 에
// Brand 행이 없어 자기 표기로 폴백하는 7개(합 39 언급)도 함께 훑었다.
//
// 결과는 세 갈래였고 **갈래마다 처리가 다르다**:
//
//  (a) 비브랜드 노이즈 → 이 파일의 제외 목록 (위 "한국어 NER 노이즈" 절, 29개
//      · 766 언급). 전부 한국어였다.
//  (b) **진짜 브랜드의 자국어 표기가 알리아스 사전에 없어 갈라진 것** → 제외가
//      아니라 lib/scope/brand-display-aliases.ts 에 추가(13개 · 933 언급).
//      아랍어·히브리어·중국어 표기는 **전수가 이 갈래**였다(노이즈 0). 예:
//      테슬라 664→Tesla · تويوتا 80→Toyota · 奔驰 32→Mercedes-Benz.
//      ⚠️ 두 갈래를 헷갈리면 진짜 경쟁사 언급을 통째로 지운다. 구분 기준은
//      "그 rollup 밑에 그 브랜드의 제품이 매달려 있는가" — 테슬라 밑에는
//      `테슬라 모델 Y` 34·`테슬라 모델 3` 31 이 있었다(브랜드), 삼성전자 밑에는
//      Galaxy·비스포크·SmartThings 뿐이었다(비자동차 → 제외가 옳다).
//  (c) 판단 보류(손대지 않음) — 근거는 PR 본문. 요약: 상위 오귀속이거나
//      HMG 계열 표기가 경계 규칙을 못 넘은 것이라 **제외·알리아스 어느 쪽도
//      정답이 아니다**.
//        · `벤츠/BMW` 102 — 두 경쟁사를 한 엔티티로 묶은 복합 표기(존재하지 않는
//          브랜드 행이지만, 지우면 진짜 경쟁 신호 102 가 사라진다).
//        · `아우디코리아` 18 · `폭스바겐 그룹` 20 · `토요타 GR` 16 ·
//          `메르세데스-벤츠 코리아` 3 · `BMW코리아` 2 — 경쟁사의 현지법인·
//          서브브랜드. 기존 사전이 `메르세데스-AMG` 를 Mercedes-Benz 로 접지
//          **않는** 것과 같은 이유로 부모에 병합하지 않았다.
//        · `기아커넥트` 12 · `기아렌터카` 1 · `현대오토에버` 2 · `현대트랜시스` 1 ·
//          `튜익스` 2 — HMG 계열인데 접두 뒤가 영숫자라 경계 규칙에 안 걸린다
//          (`기아`+`커넥트`). 제외 목록이 아니라 **귀속 규칙**에서 다룰 문제다.
//        · `红旗` 47 — 진짜 브랜드(Hongqi)지만 미러에 라틴 정본 행이 없어 병합할
//          상대가 없다. 노이즈가 아니므로 그대로 둔다.
//
// bare/하위 계층 판별(BARE_ONLY, 아래) 은 **한 건도 필요 없었다** — (a) 29개 중
// 하위 Product 를 가진 것은 `삼성전자` 하나뿐이고 그 하위는 전부 비자동차라
// 제외가 옳다. 나머지 28개는 하위 Product 가 0 이다(미러 전수 대조).
//
// 전후 실측(KR 슬라이스 · 미러 전수, 2026-08-29):
//   · 분모 697,515 → 697,140 (−375, −0.054%). 미러 전체로는 4,263,535 → −766.
//   · **상위 25위 실브랜드의 순위 변동 0.** 바뀐 것은 알리아스 병합으로 늘어난
//     언급 수뿐: Tesla 27,577→28,236 · Lucid 6,303→6,346 · Zeekr 355→358(51→49위)
//     · KG Mobility 46→66(90→82위) · XPeng 689→690 · Pininfarina 29→30.
//     병합 증가분이 사라진 자국어 행의 언급과 **정확히 일치**한다(누락 0).
//   · 랭킹에서 사라진 행 21개는 전부 (a) 노이즈다 — 실브랜드 소실 0.

export const NON_COMPETITOR_BRANDS = new Set([
  "apple",
  "google",
  "samsung",
  ...NON_COMPETITOR_NOISE,
]);

export function isNonCompetitorBrand(brand: string | null | undefined): boolean {
  if (!brand) return false;
  return NON_COMPETITOR_BRANDS.has(brand.trim().toLowerCase());
}

// ── bare-only 제외 (2026-08-29) ──────────────────────────────────────────────
// 위 목록은 **rollup 표기**로 판정하므로, 이름 하나를 넣으면 그 rollup 에 매달린
// 하위 Product 언급까지 함께 사라진다. 셋은 그 대가가 실제로 컸다 — 이름이
// 보통명사이면서 **진짜 자동차·모빌리티 브랜드**이기도 해서다.
//
// 프로덕션 미러 전수 실측(2026-08-29, rollup 그룹 단위):
//   rollup      bare 엔티티(=노이즈)   이름을 확장한 하위 Product(=진짜 브랜드)
//   Smart       41,438 언급 (99.6%)    Smart Fortwo 148 · Fortwo EQ 8 · EQ Fortwo 5 = 161
//   Cruise      17,502 언급            Cruise Origin 5
//   International 7,803 언급           (없음 — 하위는 Mission Raceway Park 109, 오귀속)
//
// 즉 **entity_id 로는 갈라지지 않는다**: bare 표기의 노이즈와 진짜 브랜드 언급은
// 하나의 Brand entity_id 안에 섞여 있어(Smart=5397b503…, Cruise=ec1bd770…,
// International=e5c77be8…) id 목록으로는 분리할 수 없다. 갈라지는 것은 **계층**이다
// — 하위 Product 는 별도 entity_id 를 갖고, 그 표기가 브랜드명을 확장한다.
// 그래서 id 를 코드에 박지 않고(brand-display-aliases 주석의 경고: entity_id 는
// 워크스페이스 데이터 종속 UUID) **구조적 판별**을 쓴다:
//
//   제외 대상 rollup 이라도, 언급 자기 표기가 "<rollup 표기> + 비영숫자 경계"로
//   시작하면(= 그 브랜드의 이름붙은 제품) 살린다.
//
// 이 규칙을 전체 목록에 걸지 않고 아래 셋으로 한정한 이유도 실측이다 — 같은
// 규칙을 전 목록에 적용하면 Google Maps(372)·Samsung Galaxy 계열·Apple iPhone
// 계열이 함께 되살아나는데, 그것들은 자동차 경쟁사가 아니다(정책상 제외가 옳다).
// 반대로 오귀속 하위(Smart 밑 Charge point·Fiat Avventura, International 밑
// Mission Raceway Park, Cruise 밑 '2nd gen')는 이름을 확장하지 않으므로 규칙이
// 자동으로 걸러낸다 — 전수 대조에서 오탐·미탐 0.
//
// 판정 시점은 read-time 이다(NON_COMPETITOR_BRANDS 와 동일 원칙). 미러 데이터는
// 틀리지 않았다 — "Smart Fortwo 는 Smart 의 제품"은 사실이고, 틀린 것은 우리
// 제외 규칙의 입도였다. 사실 오류를 고치는 write-time 경로
// (lib/scope/mirror/case-sensitive-brands.ts)와 구분된다.
const BARE_ONLY_NON_COMPETITORS = [
  "smart", "cruise", "international",
  // 2026-08-31 2차 — 위 NOISE 2차 블록과 한 세트.
  "pilot", "falcon", "century", "element", "lightning", "punch", "one", "integra", "bolt", "fit",
  // 2026-08-31 (GEO-2) — 위 NON_COMPETITOR_NOISE 의 같은 블록과 한 세트다.
  // 여기 없으면 "Focus ST"·"Golf GTI" 같은 정탐까지 함께 사라진다.
  "focus", "legacy", "charger", "city", "edge", "is", "vision", "volt", "crown", "golf", "transit", "gravity", "fastback", "dual electronics",
] as const;

function escapeRegexLiteral(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// SQL 쌍둥이(lib/db/repositories/scope-aggregates.ts)가 쓰는 POSIX 패턴 목록.
// `[^[:alnum:]]` ↔ JS `[^\p{L}\p{Nd}]` 가 1:1 대응한다(등가 근거는 text-trim.ts
// ::NAME_BOUNDARY_CLASS — PG 실측). 경계 문자를 **요구**하므로 bare 표기 자신
// ("Smart")과 접두 부분일치("Smartphone")는 매치되지 않는다.
// 선행 트림 클래스는 JS 쪽 `.trim()` 의 쌍둥이 — POSIX_LEADING_TRIM 주석 참조.
export const BARE_ONLY_NON_COMPETITOR_PATTERNS: ReadonlyArray<
  readonly [name: string, posixPattern: string]
> = BARE_ONLY_NON_COMPETITORS.map(
  (n) =>
    [n, `^${POSIX_LEADING_TRIM}${escapeRegexLiteral(n)}[^[:alnum:]]`] as const,
);

const BARE_ONLY_JS_PATTERNS = new Map<string, RegExp>(
  BARE_ONLY_NON_COMPETITORS.map((n) => [
    n,
    new RegExp(`^${escapeRegexLiteral(n)}[^${NAME_BOUNDARY_CLASS}]`, "u"),
  ]),
);

// 언급 단위 비경쟁 판정 — SQL 경로 excludeNonCompetitorBrandsSql 의 JS 쌍둥이.
// rollupName = 집계가 GROUP BY 하는 정본 표시명(canonicalBrandDisplayName 적용 후),
// ownName = 그 언급 자신의 표기(Product 면 모델명). ownName 을 안 주면 bare 판정과
// 동일하게 동작한다(하위 호환).
export function isNonCompetitorMention(
  rollupName: string | null | undefined,
  ownName?: string | null,
): boolean {
  if (!rollupName) return false;
  const bare = rollupName.trim().toLowerCase();
  if (!NON_COMPETITOR_BRANDS.has(bare)) return false;
  const re = BARE_ONLY_JS_PATTERNS.get(bare);
  if (!re || !ownName) return true;
  // 이름을 확장한 하위 제품이면 진짜 브랜드 언급 → 제외하지 않는다.
  return !re.test(ownName.trim().toLowerCase());
}
