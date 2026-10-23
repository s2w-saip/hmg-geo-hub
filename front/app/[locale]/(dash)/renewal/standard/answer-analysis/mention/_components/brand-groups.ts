// Brand → parent group for the renewal Mention treemap (product decision 2026-10-21: a static
// front-end table; the data has no such mapping — app.brand.parent covers the own brands only).
//
// Built from the production top-100 brand names (admin, no filter, round 2026-10-19) plus the
// common makers around them. Rules:
//   · majority ownership → the parent's group (Maybach → Mercedes-Benz, Range Rover → Tata,
//     Daihatsu → Toyota, Maruti → Suzuki, Lotus → Geely, Wuling → SAIC, Bugatti → Rimac)
//   · minority stake, alliance or 50:50 JV → independent (Aston Martin, Mitsubishi, Leapmotor,
//     Subaru, Mazda, Proton, Smart)
//   · a parent's own name used as a brand (General Motors, Stellantis, SAIC, Daimler) → that group
//   · entities that are not car makers (assistants, platforms, sport, fashion) → NON_AUTO
//   · a name missing here → its own single-brand group (it still shows, just not grouped)
// Names match after folding case, accents and punctuation (Škoda = Skoda, MINI = Mini).

export const NON_AUTO_GROUP = "__nonAuto";

/** [group label, ISO country of the parent, member brand names] */
const GROUPS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["HMG", "KR", ["Hyundai", "Kia", "Genesis", "Mobis", "Hyundai Mobis"]],
  ["Toyota", "JP", ["Toyota", "Lexus", "Daihatsu", "Hino"]],
  ["VW", "DE", ["Volkswagen", "VW", "Audi", "Porsche", "Skoda", "SEAT", "CUPRA", "Bentley", "Lamborghini", "Ducati", "Scout"]],
  ["Stellantis", "NL", ["Stellantis", "Peugeot", "Citroen", "DS Automobiles", "DS", "Opel", "Vauxhall", "Fiat", "Abarth", "Lancia", "Jeep", "Alfa Romeo", "Maserati", "Dodge", "Ram", "Chrysler"]],
  ["GM", "US", ["General Motors", "GM", "Chevrolet", "Cadillac", "GMC", "Buick", "BrightDrop", "Holden"]],
  ["Ford", "US", ["Ford", "Lincoln"]],
  ["BMW", "DE", ["BMW", "MINI", "Rolls-Royce", "BMW Motorrad"]],
  ["Mercedes-Benz", "DE", ["Mercedes-Benz", "Mercedes", "Maybach", "Mercedes-Maybach", "Mercedes-AMG", "AMG", "Daimler"]],
  ["Geely", "CN", ["Geely", "Volvo", "Polestar", "Zeekr", "Lotus", "Lynk & Co"]],
  ["BYD", "CN", ["BYD", "Denza", "Yangwang", "Fangchengbao"]],
  ["Tesla", "US", ["Tesla"]],
  ["Honda", "JP", ["Honda", "Acura"]],
  ["Renault", "FR", ["Renault", "Dacia", "Alpine"]],
  ["Nissan", "JP", ["Nissan", "Infiniti", "Datsun"]],
  ["Tata", "IN", ["Tata", "Tata Motors", "Jaguar", "Land Rover", "Range Rover", "Jaguar Land Rover", "JLR"]],
  ["SAIC", "CN", ["SAIC", "MG", "Wuling", "Baojun", "Maxus", "Roewe", "IM Motors"]],
  ["Great Wall", "CN", ["Great Wall", "Great Wall Motor", "GWM", "Haval", "Ora", "Tank", "Wey"]],
  ["Suzuki", "JP", ["Suzuki", "Maruti", "Maruti Suzuki"]],
  ["Rimac", "HR", ["Rimac", "Bugatti", "Bugatti Rimac"]],
  ["Seres", "CN", ["Seres", "Aito"]],
  ["Changan", "CN", ["Changan", "Deepal", "Avatr"]],
  ["GAC", "CN", ["GAC", "Aion", "Trumpchi"]],
  ["Chery", "CN", ["Chery", "Omoda", "Jaecoo", "Exeed"]],
  ["Mazda", "JP", ["Mazda"]],
  ["Subaru", "JP", ["Subaru"]],
  ["Mitsubishi", "JP", ["Mitsubishi"]],
  ["Isuzu", "JP", ["Isuzu"]],
  ["Ferrari", "IT", ["Ferrari"]],
  ["McLaren", "GB", ["McLaren"]],
  ["Aston Martin", "GB", ["Aston Martin"]],
  ["Rivian", "US", ["Rivian"]],
  ["Lucid", "US", ["Lucid"]],
  ["NIO", "CN", ["NIO"]],
  ["XPeng", "CN", ["XPeng"]],
  ["Li Auto", "CN", ["Li Auto"]],
  ["Xiaomi", "CN", ["Xiaomi"]],
  ["Leapmotor", "CN", ["Leapmotor"]],
  ["Smart", "CN", ["Smart"]],
  ["VinFast", "VN", ["VinFast"]],
  ["Mahindra", "IN", ["Mahindra"]],
  ["Togg", "TR", ["Togg"]],
  ["Proton", "MY", ["Proton"]],
  ["Perodua", "MY", ["Perodua"]],
  // not car makers: AI assistants, map apps, tech platforms, sport, fashion (they appear in answers as brands)
  [NON_AUTO_GROUP, "", ["Alexa", "Waze", "Alphabet", "Google", "Huawei", "Apple", "Amazon", "Formula 1", "Giorgio Armani", "G2", "Apollo"]],
];

/** Fold case, accents and punctuation: "Škoda" → "skoda", "Rolls-Royce" → "rollsroyce". */
export function brandFoldKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9&]/g, "");
}

const GROUP_BY_KEY = new Map<string, string>(GROUPS.flatMap(([g, , members]) => members.map((m) => [brandFoldKey(m), g] as const)));
const COUNTRY_OF = new Map<string, string>(GROUPS.map(([g, cc]) => [g, cc]));

/** The parent group of a brand; a brand outside the table is its own group (its own name). */
export function parentGroupOf(brand: string): string {
  return GROUP_BY_KEY.get(brandFoldKey(brand)) ?? brand;
}

/** True when the brand is in the table (its group is known, not the single-brand fallback). */
export function isMappedBrand(brand: string): boolean {
  return GROUP_BY_KEY.has(brandFoldKey(brand));
}

/** ISO country of a group's parent ("" for the non-automaker fold and unknown groups). */
export function groupCountry(group: string): string {
  return COUNTRY_OF.get(group) ?? "";
}
