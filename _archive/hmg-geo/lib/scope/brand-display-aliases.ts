// 브랜드 표시명 병합 사전 — scope 가 같은 브랜드를 표기(자국어·철자·대소문자)별로
// 별도 entity 로 만들어 랭킹 행이 갈라진다(2026-08-06 미러 전수조사). HMG 3사는
// entity_id 알리아스(hmg-brands)로 접지만, 경쟁사는 정본 entity_id 가 워크스페이스
// 데이터에 따라 달라 id 페어를 코드에 둘 수 없다 — 대신 "표시명"을 정본 표기로
// 번역하고, 집계가 정본 표기명으로 GROUP BY 해 같은 이름의 중복 entity(Toyota
// 2개 id 등)까지 함께 접는다. 미러는 보존, read-time 전용 (비경쟁 제외와 동일 원칙).
//
// 유지보수: 새 표기 변형은 미러 감사 쿼리(brand !~ '[A-Za-z]' 또는 같은 이름
// 다른 entity_id)로 발견해 여기에 추가한다. 사전에 없는 이름은 항등 — 비 HMG·
// 비등재 브랜드 동작은 변하지 않는다.
import { HMG_BRAND_NAME_ALIASES, resolveHmgBrandName } from "./hmg-brands";

// 경쟁사 표기 변형 → 정본 표기 (2026-08-06 실측 전수: 비알파벳 표기 + 철자 변형).
const COMPETITOR_DISPLAY_ALIASES: Readonly<Record<string, string>> = {
  폭스바겐: "Volkswagen",
  "메르세데스-벤츠": "Mercedes-Benz",
  // 방어적 음차 변형 — 미러 실측(2026-08-07)엔 '메르세데스-'뿐이지만 고객
  // 피드백 표기가 '메르세데즈-'라 새 변형 유입에 대비해 함께 등재.
  "메르세데즈-벤츠": "Mercedes-Benz",
  "메르세데스-AMG": "Mercedes-AMG",
  هوندا: "Honda",
  마쓰다: "Mazda",
  르노: "Renault",
  טויוטה: "Toyota",
  미니: "MINI",
  Mini: "MINI",
  링컨: "Lincoln",
  링크앤코: "Lynk & Co",
  대우: "Daewoo",
  Skoda: "Škoda",
  // ── 2026-08-29 비라틴 표기 전수 감사에서 발견된 **알리아스 누락** ──────────
  // 위 엔트리는 2026-08-06 조사로 들어왔지만 그 조사는 표기를 다 훑지 못했다.
  // 아래는 미러에 **라틴 정본 행이 이미 큰 규모로 존재하는데** 자국어 표기가
  // 별도 행으로 갈라져 있던 것들이다. 노이즈가 아니라 병합 대상이다 —
  // 제외 목록에 넣으면 진짜 경쟁사 언급이 사라진다(구분 기준은
  // non-competitor-brands.ts 의 "비라틴 표기 감사" 절).
  // 괄호 = 자국어 행 언급 → 병합될 라틴 정본 행 언급(미러 전수, 2026-08-29).
  테슬라: "Tesla", // 664 → 139,024
  루시드: "Lucid", // 43 → 38,159
  تويوتا: "Toyota", // 80 → 170,239 (히브리어 טויוטה 는 이미 등재돼 있었다)
  奔驰: "Mercedes-Benz", // 32 → 104,301
  宝马: "BMW", // 32 → 150,817
  نيسان: "Nissan", // 23 → 11,517
  "KG 모빌리티": "KG Mobility", // 20 → 46
  זיקר: "Zeekr", // 15 → 2,053
  מרצדס: "Mercedes-Benz", // 9 (하위: מרצדס ספרינטר)
  שברולט: "Chevrolet", // 7 → 31,611
  "ב.מ.וו": "BMW", // 6 (하위: ב.מ.וו סדרה 5)
  엑스펑: "XPeng", // 1 → 3,895
  피닌파리나: "Pininfarina", // 1 → 146
  // ── 2026-08-30 라틴 표기 변형 **전수** 감사 ────────────────────────────────
  // #123 은 비라틴 표기만 훑어서 "라틴끼리 표기만 다른 행"을 못 봤다. 미러 전수
  // (rollup 해석 후 표시명 기준, `regexp_replace(lower(...),'[^a-z0-9]','')` 로
  // 정규화해 GROUP BY)에서 **정규화 키가 겹치는 라틴 행은 아래 4개가 전부**다:
  //   · MINI [2,555] / Mini [14]        → 이미 등재됨 (아래 `Mini`)
  //   · Škoda [2,888] / Skoda [255]     → 이미 등재됨 (아래 `Skoda`)
  //   · XPeng [1,824] / Xpeng [2]       → **이번에 추가** ↓
  //   · Vivo [73] / vivo [30]           → 병합하지 않는다. 브랜드가 아니다 —
  //     답변 원문 확인 결과 이탈리아어·스페인어 `dal vivo`·`en vivo`(실시간/직접)
  //     구절과 중국어 스마트폰 열거(`华为、小米、OPPO、vivo` — NFC 디지털키 호환
  //     기종)에서 잘린 것이다. 자동차 경쟁사가 아니므로 **알리아스가 아니라
  //     non-competitor-brands 제외 후보**이고, 그 판단은 이 PR 범위 밖이라
  //     손대지 않았다(#123 (c) 보류와 같은 자세). 알리아스로 접으면 노이즈 두
  //     행이 한 행이 될 뿐이고, 나중에 제외할 때 되돌려야 한다.
  // 판정 기준은 #123 과 동일 — 그 rollup 밑에 그 브랜드의 제품이 매달려 있는가.
  // XPeng(96aae5d0…) 밑에는 XPENG G9 24 · P7+ 17 · G9 16 · XPeng P7 1 이 있고,
  // Xpeng(7926f7dc…)·Vivo·vivo 밑에는 제품이 하나도 없다.
  //
  // ⚠️ 대소문자만 다른 행을 일반 규칙(lower() 병합)으로 접지 않는 이유: 위 감사가
  // 보여주듯 그 부류에는 **진짜 브랜드(XPeng)와 노이즈(Vivo)가 섞여** 있다.
  // 일반 규칙은 노이즈까지 정본으로 승격시키므로 건별 등재를 유지한다.
  Xpeng: "XPeng", // 2 → 1,824 (같은 브랜드가 대소문자만 달라 랭킹 두 행으로 갈림)
};

// SQL CASE 생성용 전체 엔트리 (HMG 자국어 표기 포함 — id 접기가 이미 정본 행으로
// 모으지만, 표기명 계층에서도 같은 답이 나오도록 이중화).
export const BRAND_DISPLAY_ALIAS_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ...Object.entries(HMG_BRAND_NAME_ALIASES),
  ...Object.entries(COMPETITOR_DISPLAY_ALIASES),
];

// JS 롤업용 — 표기를 정본 표시명으로 해석 (HMG 우선, 경쟁 사전, 항등 폴백).
export function canonicalBrandDisplayName(name: string): string {
  const hmg = resolveHmgBrandName(name);
  if (hmg) return hmg;
  const trimmed = name.trim();
  return COMPETITOR_DISPLAY_ALIASES[trimmed] ?? name;
}
