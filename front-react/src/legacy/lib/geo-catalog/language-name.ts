// `country-name.ts` 의 언어판 — 언어 코드를 로케일별 언어명으로 푼다.
// 카탈로그 `prompts.lang` 은 번역 시트 탭 코드(대문자 ISO 639-1: EN·KO·ZH…)라
// `Intl.DisplayNames({type:"language"})` 에 넘기기 전에 소문자로 정규화한다.
// 모르는 코드는 원문 그대로 — 렌더에서 절대 throw 하지 않는다.

const cache = new Map<string, Intl.DisplayNames>();

function formatter(locale: string): Intl.DisplayNames {
  let f = cache.get(locale);
  if (!f) {
    f = new Intl.DisplayNames([locale], { type: "language" });
    cache.set(locale, f);
  }
  return f;
}

/** Localized language name for an ISO 639-1 code, or the code if unknown. */
export function languageName(code: string | null | undefined, locale: string): string {
  if (!code) return "";
  const normalized = code.trim().toLowerCase();
  try {
    return formatter(locale).of(normalized) ?? code;
  } catch {
    return code;
  }
}
