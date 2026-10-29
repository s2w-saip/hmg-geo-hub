// 경쟁사 공식 도메인 → 브랜드 표시명(2026-09-02 피그마 1:1, Overview 인용 점유율 경쟁사 값).
//
// rules.ts 의 공식(경쟁사) 판정은 "어느 브랜드인가"를 말하지 않는다 — 카테고리만 낸다.
// 여기서는 등록 가능 도메인의 첫 라벨(bmw.co.kr → bmw, mbusa.com → mbusa)을 아는 토큰에
// 대응시킨다. 토큰은 접두 매칭(bmwusa → bmw, toyotabharat → toyota, 긴 토큰 우선)이라
// 지역 사이트가 모브랜드로 접힌다. 모르는 토큰은 null — 값을 지어내지 않는다.

const TOKEN_TO_BRAND: Record<string, string> = {
  toyota: "Toyota", lexus: "Lexus", daihatsu: "Daihatsu", honda: "Honda", acura: "Acura",
  nissan: "Nissan", infiniti: "Infiniti", mazda: "Mazda", subaru: "Subaru", mitsubishi: "Mitsubishi",
  suzuki: "Suzuki", isuzu: "Isuzu", bmw: "BMW", mini: "MINI", "mercedes-benz": "Mercedes-Benz",
  mercedes: "Mercedes-Benz", mbusa: "Mercedes-Benz", maybach: "Mercedes-Benz", audi: "Audi",
  volkswagen: "Volkswagen", vw: "Volkswagen", porsche: "Porsche", tesla: "Tesla", ford: "Ford",
  lincoln: "Lincoln", chevrolet: "Chevrolet", chevy: "Chevrolet", gmc: "GMC", cadillac: "Cadillac",
  buick: "Buick", jeep: "Jeep", dodge: "Dodge", ram: "Ram", chrysler: "Chrysler", volvo: "Volvo",
  polestar: "Polestar", byd: "BYD", geely: "Geely", chery: "Chery", mg: "MG", skoda: "Škoda",
  seat: "SEAT", cupra: "CUPRA", renault: "Renault", dacia: "Dacia", peugeot: "Peugeot",
  citroen: "Citroën", opel: "Opel", fiat: "Fiat", "alfa-romeo": "Alfa Romeo", alfaromeo: "Alfa Romeo",
  ferrari: "Ferrari", lamborghini: "Lamborghini", maserati: "Maserati", bentley: "Bentley",
  "rolls-royce": "Rolls-Royce", rollsroyce: "Rolls-Royce", "land-rover": "Land Rover",
  landrover: "Land Rover", jaguar: "Jaguar", "aston-martin": "Aston Martin", astonmartin: "Aston Martin",
  lucid: "Lucid", rivian: "Rivian", tata: "Tata", mahindra: "Mahindra", vinfast: "VinFast",
  nio: "NIO", xpeng: "XPeng", zeekr: "Zeekr", lynkco: "Lynk & Co", smart: "smart",
};
const TOKENS = Object.keys(TOKEN_TO_BRAND).sort((a, b) => b.length - a.length);
const AMBIGUOUS_PREFIX = new Set(["mg", "ram", "nio", "byd", "seat", "mini", "smart", "tata", "ford"]);

/** 도메인의 첫 라벨(www 제거). */
export function domainFirstLabel(domain: string): string {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return d.split(".")[0] ?? d;
}

/** 공식(경쟁사) 도메인 → 브랜드 표시명. 모르면 null. */
export function competitorBrandOfDomain(domain: string): string | null {
  const label = domainFirstLabel(domain);
  if (TOKEN_TO_BRAND[label]) return TOKEN_TO_BRAND[label];
  // 접두 매칭 — 2자 이하·일반 단어와 겹치는 토큰(mg·ram·nio·byd·seat·mini·smart·tata)은
  // 오탐이 커서 정확 일치만. bmw(bmwusa)·gmc 처럼 고유한 3자 토큰은 접두 매칭한다.
  for (const tok of TOKENS) {
    if (tok.length <= 2 || AMBIGUOUS_PREFIX.has(tok)) continue;
    if (label.startsWith(tok)) return TOKEN_TO_BRAND[tok];
  }
  return null;
}
