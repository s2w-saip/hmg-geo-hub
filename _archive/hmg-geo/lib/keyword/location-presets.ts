/**
 * DataForSEO location_code / language_code presets, grouped by region.
 * Ported verbatim from aeorank (lib/data-for-seo/location-language-presets.ts).
 *
 * `name` (Korean) / `nameEn` are option labels rendered in the keyword-tools
 * picker. They are plain data (not JSX literals), so they live here rather than
 * in messages/*.json — the dictionary covers chrome, not the 30-country table.
 */

export type LocationLanguagePreset = {
  id: string;
  name: string;
  nameEn: string;
  location_code: number;
  language_code: string;
  flag: string; // country flag emoji
  region: string; // North America / Asia / Europe / …
};

export const LOCATION_LANGUAGE_PRESETS: LocationLanguagePreset[] = [
  // North America
  { id: "us", name: "미국", nameEn: "United States", location_code: 2840, language_code: "en", flag: "🇺🇸", region: "North America" },
  { id: "ca", name: "캐나다", nameEn: "Canada", location_code: 2124, language_code: "en", flag: "🇨🇦", region: "North America" },
  { id: "mx", name: "멕시코", nameEn: "Mexico", location_code: 2484, language_code: "es", flag: "🇲🇽", region: "North America" },

  // Asia
  { id: "kr", name: "한국", nameEn: "South Korea", location_code: 2410, language_code: "ko", flag: "🇰🇷", region: "Asia" },
  { id: "jp", name: "일본", nameEn: "Japan", location_code: 2392, language_code: "ja", flag: "🇯🇵", region: "Asia" },
  { id: "cn", name: "중국", nameEn: "China", location_code: 2156, language_code: "zh-CN", flag: "🇨🇳", region: "Asia" },
  { id: "sg", name: "싱가포르", nameEn: "Singapore", location_code: 2702, language_code: "en", flag: "🇸🇬", region: "Asia" },
  { id: "hk", name: "홍콩", nameEn: "Hong Kong", location_code: 2344, language_code: "zh-HK", flag: "🇭🇰", region: "Asia" },
  { id: "tw", name: "대만", nameEn: "Taiwan", location_code: 2158, language_code: "zh-TW", flag: "🇹🇼", region: "Asia" },
  { id: "th", name: "태국", nameEn: "Thailand", location_code: 2764, language_code: "th", flag: "🇹🇭", region: "Asia" },
  { id: "vn", name: "베트남", nameEn: "Vietnam", location_code: 2704, language_code: "vi", flag: "🇻🇳", region: "Asia" },
  { id: "in", name: "인도", nameEn: "India", location_code: 2356, language_code: "en", flag: "🇮🇳", region: "Asia" },

  // Europe
  { id: "gb", name: "영국", nameEn: "United Kingdom", location_code: 2826, language_code: "en", flag: "🇬🇧", region: "Europe" },
  { id: "de", name: "독일", nameEn: "Germany", location_code: 2276, language_code: "de", flag: "🇩🇪", region: "Europe" },
  { id: "fr", name: "프랑스", nameEn: "France", location_code: 2250, language_code: "fr", flag: "🇫🇷", region: "Europe" },
  { id: "it", name: "이탈리아", nameEn: "Italy", location_code: 2380, language_code: "it", flag: "🇮🇹", region: "Europe" },
  { id: "es", name: "스페인", nameEn: "Spain", location_code: 2724, language_code: "es", flag: "🇪🇸", region: "Europe" },
  { id: "nl", name: "네덜란드", nameEn: "Netherlands", location_code: 2528, language_code: "nl", flag: "🇳🇱", region: "Europe" },
  { id: "se", name: "스웨덴", nameEn: "Sweden", location_code: 2752, language_code: "sv", flag: "🇸🇪", region: "Europe" },
  { id: "no", name: "노르웨이", nameEn: "Norway", location_code: 2578, language_code: "no", flag: "🇳🇴", region: "Europe" },
  { id: "dk", name: "덴마크", nameEn: "Denmark", location_code: 2208, language_code: "da", flag: "🇩🇰", region: "Europe" },
  { id: "fi", name: "핀란드", nameEn: "Finland", location_code: 2246, language_code: "fi", flag: "🇫🇮", region: "Europe" },

  // Oceania
  { id: "au", name: "호주", nameEn: "Australia", location_code: 2036, language_code: "en", flag: "🇦🇺", region: "Oceania" },
  { id: "nz", name: "뉴질랜드", nameEn: "New Zealand", location_code: 2554, language_code: "en", flag: "🇳🇿", region: "Oceania" },

  // South America
  { id: "br", name: "브라질", nameEn: "Brazil", location_code: 2076, language_code: "pt", flag: "🇧🇷", region: "South America" },
  { id: "ar", name: "아르헨티나", nameEn: "Argentina", location_code: 2032, language_code: "es", flag: "🇦🇷", region: "South America" },

  // Middle East / Africa
  { id: "ae", name: "아랍에미리트", nameEn: "United Arab Emirates", location_code: 2784, language_code: "ar", flag: "🇦🇪", region: "Middle East" },
  { id: "sa", name: "사우디아라비아", nameEn: "Saudi Arabia", location_code: 2682, language_code: "ar", flag: "🇸🇦", region: "Middle East" },
  { id: "za", name: "남아프리카공화국", nameEn: "South Africa", location_code: 2710, language_code: "en", flag: "🇿🇦", region: "Africa" },
];

// Presets grouped by region (drives the optgroup-style picker).
export const PRESETS_BY_REGION = LOCATION_LANGUAGE_PRESETS.reduce(
  (acc, preset) => {
    (acc[preset.region] ??= []).push(preset);
    return acc;
  },
  {} as Record<string, LocationLanguagePreset[]>,
);

export function getPresetById(id: string): LocationLanguagePreset | undefined {
  return LOCATION_LANGUAGE_PRESETS.find((p) => p.id === id);
}

export function getPresetByLocationCode(
  locationCode: number,
): LocationLanguagePreset | undefined {
  return LOCATION_LANGUAGE_PRESETS.find((p) => p.location_code === locationCode);
}

// HMG is a Korean group → default the picker to Korea (aeorank defaulted to US).
export const DEFAULT_PRESET_ID = "kr";
export const KR_PRESET = getPresetById("kr")!;
export const US_PRESET = getPresetById("us")!;
