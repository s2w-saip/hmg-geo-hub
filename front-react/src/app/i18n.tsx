import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { useParams } from "react-router-dom";

type Messages = { [key: string]: unknown };
function merge(base: Messages, overlay: Messages): Messages {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const before = out[key];
    out[key] = value && before && typeof value === "object" && typeof before === "object" && !Array.isArray(value) && !Array.isArray(before)
      ? merge(before as Messages, value as Messages) : value;
  }
  return out;
}
const dictionaries = import.meta.glob<{ default: Messages }>("../messages/**/*.json");
const cache = new Map<string, Messages>();
async function loadMessages(locale: string): Promise<Messages> {
  const cached = cache.get(locale);
  if (cached) return cached;
  const [base, overlays] = await Promise.all([
    dictionaries[`../messages/${locale}.json`](),
    Promise.all(Array.from({ length: 12 }, (_, i) => dictionaries[`../messages/units/u${i + 1}.${locale}.json`]?.())),
  ]);
  let result = base.default;
  for (const overlay of overlays) if (overlay) result = merge(result, overlay.default);
  cache.set(locale, result);
  return result;
}
export function LocaleProvider({ children }: { children: ReactNode }) {
  const { locale } = useParams();
  const selected = locale === "en" ? "en" : "ko";
  const [loaded, setLoaded] = useState<{ locale: string; messages: Messages } | null>(null);
  const [failed, setFailed] = useState(false);
  const now = useMemo(() => new Date(), []);
  useEffect(() => { document.documentElement.lang = selected; }, [selected]);
  useEffect(() => {
    let active = true;
    setFailed(false);
    loadMessages(selected).then(messages => { if (active) setLoaded({ locale: selected, messages }); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [selected]);
  if (failed) return <main role="alert" className="p-8">언어 파일을 불러오지 못했습니다. 페이지를 새로고침해 주세요.</main>;
  if (loaded?.locale !== selected) return <div role="status" className="p-8 text-sm text-gray-500">{selected === "en" ? "Loading…" : "불러오는 중…"}</div>;
  return <IntlProvider locale={selected} messages={loaded.messages as never} timeZone="Asia/Seoul" now={now}>{children}</IntlProvider>;
}
