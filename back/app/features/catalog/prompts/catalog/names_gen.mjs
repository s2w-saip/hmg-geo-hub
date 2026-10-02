// names_data.py 생성기(검증 m-2). 실행: node names_gen.mjs  (이 파일이 있는 디렉터리에서, 네트워크·의존성 없음)
//
// 현행 front 표시명 = Intl.DisplayNames(ICU CLDR) 결과(front/lib/geo-catalog/country-name.ts·language-name.ts).
// 백엔드에는 ICU 가 없어 같은 결과를 "표 + 조립 규칙"으로 옮긴다. 조립 규칙은 screen_export.language_name 과 한 벌이고,
// 이 생성기는 규칙으로 안 맞는 태그만 표(LANGUAGE_NAMES 의 조합 키)에 넣는다.
//   조립 규칙: 이름(언어) + '(' 한정어들 ', ' 연결 ')'  (ko '{0}({1})', en '{0} ({1})')
//              한정어 = 문자 체계 이름, 지역 이름(별칭 → 정규 지역). 한정어 안의 '(' ')' 는 '[' ']' 로 바꾼다(ICU 규칙).
//              모르는 언어 = 소문자 코드, 모르는 문자 체계 = 첫 글자 대문자 코드, 모르는 지역 = 대문자 코드.
// 전수 대조 범위(표에 반영): 언어(두 글자 aa..zz, 세 글자 aaa..zzz 중 Intl 이 이름을 주거나 별칭인 것)
//   × 지역(두 글자 AA..ZZ, 숫자 000..999 중 이름이 있거나 별칭인 것), 언어 × 문자 체계(이름이 있거나 별칭인 것).
// 언어-문자-지역 3단 태그는 규칙만 쓴다(전수는 수천만 조합). 표본 대조 결과를 끝에 출력한다.
// 산출: names_data.py, tests/names_intl_sample.json(표본 기대값: Node Intl 그대로, 회귀 테스트가 읽는다).
import { writeFileSync } from "node:fs";

const LOCALES = ["ko", "en"];
const A = "abcdefghijklmnopqrstuvwxyz";
const dn = Object.fromEntries(LOCALES.map((l) => [l, {
  language: new Intl.DisplayNames([l], { type: "language" }),
  region: new Intl.DisplayNames([l], { type: "region" }),
  script: new Intl.DisplayNames([l], { type: "script" }),
}]));
const safe = (f) => { try { return f(); } catch { return undefined; } };
const canon = (tag) => safe(() => Intl.getCanonicalLocales(tag)[0]);

// ── 기초 이름 표 ──
const regions2 = [];
for (const a of A) for (const b of A) regions2.push((a + b).toUpperCase());
const regions3 = [];
for (let i = 0; i < 1000; i++) regions3.push(String(i).padStart(3, "0"));
const scripts = [];
for (const a of A) for (const b of A) for (const c of A) for (const d of A) scripts.push(a.toUpperCase() + b + c + d);
const langs = [];
for (const a of A) for (const b of A) langs.push(a + b);
for (const a of A) for (const b of A) for (const c of A) langs.push(a + b + c);

const REGION = Object.fromEntries(LOCALES.map((l) => [l, {}]));
const SCRIPT = Object.fromEntries(LOCALES.map((l) => [l, {}]));
const LANG = Object.fromEntries(LOCALES.map((l) => [l, {}]));
const REGION_ALIAS = {};
const SCRIPT_ALIAS = {};

for (const r of [...regions2, ...regions3]) {
  for (const l of LOCALES) {
    const n = safe(() => dn[l].region.of(r));
    if (n !== undefined && n !== r) REGION[l][r] = n;
  }
  const c = canon(`und-${r}`);
  const cr = c && c.split("-")[1];
  if (cr && cr !== r) REGION_ALIAS[r] = cr;
}
for (const s of scripts) {
  for (const l of LOCALES) {
    const n = safe(() => dn[l].script.of(s));
    if (n !== undefined && n !== s) SCRIPT[l][s] = n;
  }
  const c = canon(`und-${s}`);
  const cs = c && c.split("-")[1];
  if (cs && cs !== s && /^[A-Z][a-z]{3}$/.test(cs)) SCRIPT_ALIAS[s] = cs;
}
const comboLangs = [];
for (const x of langs) {
  let named = false;
  for (const l of LOCALES) {
    const n = safe(() => dn[l].language.of(x));
    if (n !== undefined && n !== x) { LANG[l][x] = n; named = true; }
  }
  const c = canon(x);
  if (named || (c && c !== x)) comboLangs.push(x);
}
// 언어+지역을 함께 바꾸는 별칭(CLDR languageAlias 'sgn_US' → ase 등 수화 코드): 언어만으로는 별칭이 아니라 따로 넣는다
for (const x of ["sgn"]) if (!comboLangs.includes(x)) comboLangs.push(x);
// 언어 별칭(Intl 이 태그를 정규화할 때 언어를 바꾸고 문자·지역을 보탠다: sh → sr-Latn, tnf → fa-AF, cnr → sr-ME)
const LANG_ALIAS = {};
for (const x of comboLangs) {
  const c = canon(x);
  if (c && c !== x && /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/.test(c)) LANG_ALIAS[x] = c;
}
// 언어마다 다른 지역 별칭(여러 나라로 갈라진 폐지 지역: SU·YU·CS·810 등은 언어의 대표 지역으로, hy-SU → AM)
const LANG_REGION_ALIAS = {};
for (const x of comboLangs.filter((y) => !LANG_ALIAS[y])) {
  for (const r of Object.keys(REGION_ALIAS)) {
    const c = canon(`${x}-${r}`);
    const cr = c && c.split("-").find((p, i) => i > 0 && /^([A-Z]{2}|\d{3})$/.test(p));
    if (cr && cr !== REGION_ALIAS[r]) LANG_REGION_ALIAS[`${x}-${r}`] = cr;
  }
}
// 언어+지역 별칭(sgn-US → ase): 'sgn-<정규 지역>' 키. 지역을 소비하고 언어를 바꾼다
for (const r of [...regions2, ...regions3]) {
  const c = canon(`sgn-${r}`);
  if (c && !c.startsWith("sgn") && /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/.test(c)) LANG_ALIAS[`sgn-${REGION_ALIAS[r] ?? r}`] = c;
}
const comboRegions = [...new Set([...Object.keys(REGION.ko), ...Object.keys(REGION.en), ...Object.keys(REGION_ALIAS)])].sort((a, b) => (/^\d/.test(a) - /^\d/.test(b)) || (a < b ? -1 : a > b ? 1 : 0));  // 두 글자 지역 먼저(숫자 별칭 조합이 정규 태그 방언을 재사용)
const comboScripts = [...new Set([...Object.keys(SCRIPT.ko), ...Object.keys(SCRIPT.en), ...Object.keys(SCRIPT_ALIAS)])].sort();

// ── 조립 규칙(screen_export.language_name 과 한 벌) ──
const brk = (s) => s.replace(/\(/g, "[").replace(/\)/g, "]");
// 1) 언어 별칭 펼치기(태그에 있는 문자·지역이 우선) 2) 지역·문자 별칭 3) 한정어 1개면 정규 태그의 규칙 밖 이름(방언 등) 4) 조립
function expand(lang, script, region) {
  const a = LANG_ALIAS[lang];
  if (a) {
    const [al, ...rest] = a.split("-");
    lang = al;
    for (const p of rest) {
      if (/^[A-Z][a-z]{3}$/.test(p)) script = script ?? p; else region = region ?? p;
    }
  }
  if (script) script = SCRIPT_ALIAS[script] ?? script;
  if (region) region = LANG_REGION_ALIAS[`${lang}-${region}`] ?? REGION_ALIAS[region] ?? region;
  const lr = region && LANG_ALIAS[`${lang}-${region}`];
  if (lr) {
    const [nl, ...rest] = lr.split("-");
    lang = nl; region = undefined;
    for (const p of rest) {
      if (/^[A-Z][a-z]{3}$/.test(p)) script = script ?? p; else region = region ?? p;
    }
  }
  return [lang, script, region];
}
function rule(loc, lang0, script0, region0) {
  const [lang, script, region] = expand(lang0, script0, region0);
  const one = script && !region ? `${lang}-${script.toLowerCase()}` : region && !script ? `${lang}-${region.toLowerCase()}` : null;
  if (one && DIFF[loc][one] !== undefined) return DIFF[loc][one];
  const base = LANG[loc][lang] ?? lang;
  const q = [];
  if (script) q.push(SCRIPT[loc][script] ?? script);
  if (region) q.push(REGION[loc][region] ?? region);
  if (!q.length) return base;
  const inner = q.map(brk).join(", ");
  return loc === "ko" ? `${base}(${inner})` : `${base} (${inner})`;
}
const DIFF = Object.fromEntries(LOCALES.map((l) => [l, {}]));
const intlLang = (loc, tag) => safe(() => dn[loc].language.of(tag));

// ── 규칙 밖 조합(표에 넣는다). 별칭 아닌 언어를 먼저 돌려 정규 태그의 방언 이름이 먼저 표에 들어가게 한다 ──
let checked = 0;
const ordered = [...comboLangs.filter((x) => !LANG_ALIAS[x]), ...comboLangs.filter((x) => LANG_ALIAS[x])];
for (const lang of ordered) {
  for (const r of comboRegions) {
    const tag = `${lang}-${r.toLowerCase()}`;
    for (const l of LOCALES) {
      const got = intlLang(l, tag);
      if (got === undefined) continue;
      checked++;
      if (got !== rule(l, lang, null, r)) DIFF[l][tag] = got;
    }
  }
  for (const s of comboScripts) {
    const tag = `${lang}-${s.toLowerCase()}`;
    for (const l of LOCALES) {
      const got = intlLang(l, tag);
      if (got === undefined) continue;
      checked++;
      if (got !== rule(l, lang, s, null)) DIFF[l][tag] = got;
    }
  }
}

// ── 3단 태그 표본 대조(규칙만) ──
const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rnd = mulberry(20260928);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
let tri = 0; let triBad = 0; const triBadEx = [];
const commonScripts = ["Latn", "Cyrl", "Arab", "Hans", "Hant", "Deva", "Jpan", "Kore", "Grek", "Hebr", "Thai", "Mong", "Beng", "Ethi"];
for (let i = 0; i < 200000; i++) {
  const lang = pick(comboLangs); const s = rnd() < 0.7 ? pick(commonScripts) : pick(comboScripts); const r = pick(comboRegions);
  const tag = `${lang}-${s.toLowerCase()}-${r.toLowerCase()}`;
  for (const l of LOCALES) {
    const got = intlLang(l, tag);
    if (got === undefined) continue;
    tri++;
    if (got !== rule(l, lang, s, r)) { triBad++; if (triBadEx.length < 10) triBadEx.push(`${l} ${tag}: ${got} / ${rule(l, lang, s, r)}`); }
  }
}

// ── names_data.py 쓰기 ──
const py = (s) => JSON.stringify(s);
function dictBlock(name, byLoc, keyNote) {
  let out = `${name}: dict[str, dict[str, str]] = {  # ${keyNote}\n`;
  for (const l of LOCALES) {
    const ks = Object.keys(byLoc[l]).sort();
    out += `    ${py(l)}: {\n`;
    let line = "       ";
    for (const k of ks) {
      const item = ` ${py(k)}: ${py(byLoc[l][k])},`;
      if (line.length + item.length > 150) { out += line + "\n"; line = "       "; }
      line += item;
    }
    if (line.trim()) out += line + "\n";
    out += "    },\n";
  }
  return out + "}\n";
}
function flatBlock(name, obj, note) {
  const ks = Object.keys(obj).sort();
  let out = `${name}: dict[str, str] = {  # ${note}\n`;
  let line = "   ";
  for (const k of ks) {
    const item = ` ${py(k)}: ${py(obj[k])},`;
    if (line.length + item.length > 150) { out += line + "\n"; line = "   "; }
    line += item;
  }
  if (line.trim()) out += line + "\n";
  return out + "}\n";
}
const langTable = Object.fromEntries(LOCALES.map((l) => [l, { ...LANG[l], ...DIFF[l] }]));
const icu = process.versions.icu;
const counts = LOCALES.map((l) => `${l}: 언어 ${Object.keys(LANG[l]).length}·조합 ${Object.keys(DIFF[l]).length}·지역 ${Object.keys(REGION[l]).length}·문자 ${Object.keys(SCRIPT[l]).length}`).join(" / ");
const header = `"""국가·언어 표시명 표(생성물: 손으로 고치지 않는다. 생성기 names_gen.mjs). catalog.prompts.catalog 화면 모양 내보내기(columns=screen)가 쓴다.

현행 front 는 표시명을 브라우저·Node 의 Intl.DisplayNames(ICU CLDR)로 만든다(front/lib/geo-catalog/country-name.ts·language-name.ts).
백엔드에는 ICU 가 없어(표준 라이브러리만, pip 금지) 같은 Intl 결과를 "표 + 조립 규칙"(screen_export.language_name)으로 옮겼다.
생성: Node ${process.versions.node}(ICU ${icu}). ${counts}
재생성(ICU 버전이 바뀌면): cd back/app/features/catalog/prompts/catalog && node names_gen.mjs
  입력 파일 없음: 코드 공간 전수(언어 aa..zzz·지역 AA..ZZ·000..999·문자 Aaaa..Zzzz)를 Node Intl.DisplayNames 로 조회한다(네트워크·의존성 없음,
  web-geo-final.json 태그 149개는 이 전수의 부분집합). 산출 = 이 파일 + tests/names_intl_sample.json(시드 고정 표본, 회귀 테스트 기대값).
- REGION_NAMES: 지역 코드 AA..ZZ·000..999 중 Intl region 이 이름을 준 코드(대문자 키, 숫자 지역 419·150·001 등 포함).
- REGION_ALIASES·SCRIPT_ALIASES·LANGUAGE_ALIASES: 언어 태그 안에서 Intl 이 정규화하는 별칭(예 840 → US, UK → GB, SU → RU, sh → sr-Latn).
  언어마다 다른 지역 별칭(hy-SU → AM)은 LANGUAGE_REGION_ALIASES.
- SCRIPT_NAMES: 문자 체계 코드(첫 글자 대문자 4글자) 중 Intl script 가 이름을 준 코드.
- LANGUAGE_NAMES: 언어 코드(두 글자·세 글자, 소문자 키) 이름 + 조립 규칙으로 안 맞는 조합 태그(방언 이름 de-ch '고지 독일어(스위스)'·
  언어별 별칭 등, '언어-지역'·'언어-문자' 전수 대조로 찾은 것) 전부.
"""
# ruff: noqa: E501
from __future__ import annotations

`;
const body = [
  dictBlock("REGION_NAMES", REGION, "Intl region 표시명(대문자 키)"),
  flatBlock("REGION_ALIASES", REGION_ALIAS, "태그 안 지역 별칭 → 정규 지역"),
  dictBlock("SCRIPT_NAMES", SCRIPT, "Intl script 표시명(첫 글자 대문자 키)"),
  flatBlock("SCRIPT_ALIASES", SCRIPT_ALIAS, "태그 안 문자 체계 별칭 → 정규 문자 체계"),
  flatBlock("LANGUAGE_REGION_ALIASES", LANG_REGION_ALIAS, "언어마다 다른 지역 별칭('정규 언어-지역' 키 → 정규 지역, REGION_ALIASES 보다 먼저)"),
  flatBlock("LANGUAGE_ALIASES", LANG_ALIAS, "태그 안 언어 별칭 → 정규 태그(언어[-문자][-지역], 태그에 있는 문자·지역이 우선). 'sgn-<지역>' 키 = 언어+지역 별칭(지역을 소비)"),
  dictBlock("LANGUAGE_NAMES", langTable, "언어 이름 + 규칙 밖 조합 태그(소문자 키)"),
].join("\n\n");
writeFileSync(new URL("./names_data.py", import.meta.url), header + body);

// ── 회귀 표본(front 함수 그대로의 기대값) ──
const frontLanguage = (code, loc) => { if (!code) return ""; const n = code.trim().toLowerCase(); try { return dn[loc].language.of(n) ?? code; } catch { return code; } };
const PSEUDO = new Set(["SA-Dammam", "SA-Jeddah", "SA-Riyadh", "CN-BJ"]);
const frontCountry = (code, loc) => { if (!code) return ""; if (PSEUDO.has(code.trim())) return null; const n = code.trim().toUpperCase(); try { return dn[loc].region.of(n) ?? code; } catch { return code; } };
const sampleLang = new Set([
  "de-ch", "nl-be", "fa-af", "ro-md", "de-at", "zh-hk", "yue-hk", "fil", "fil-ph", "haw", "ckb-iq", "sr-latn", "sr-cyrl-rs", "zh-hans-cn",
  "zh-Hant-TW", "en-419", "es-419", "de-150", "en-001", "en-840", "hy-su", "ru-su", "en-su", "en-uk", "sh-rs", "sgn-us", "iw-il", "in",
  "XX", "xx-zz", "qq-us", "qqq-us", "en-qq", "en-qaaa", "en-qaaa-us", "en-999", "en_us", "en-us-posix", "und", "und-us", "zh-yue",
  "pt-BR", "EN", "zh_TW", "fr-CA", " ko-kr ", "my-mm", "nb-no", "mn-mong-cn", "ja-jpan-jp",
]);
for (let i = 0; i < 1500; i++) sampleLang.add(`${pick(comboLangs)}-${pick(comboRegions).toLowerCase()}`);
for (let i = 0; i < 400; i++) sampleLang.add(`${pick(comboLangs)}-${pick(comboScripts).toLowerCase()}`);
for (let i = 0; i < 400; i++) sampleLang.add(`${pick(comboLangs)}-${pick(commonScripts).toLowerCase()}-${pick(comboRegions).toLowerCase()}`);
for (let i = 0; i < 300; i++) sampleLang.add(pick(comboLangs));
const sampleCountry = new Set(["DE", "de", " us ", "419", "150", "001", "840", "999", "QQ", "qq", "USA", "x:EU", "worldwide", "SU", "UK", "HK", "MM", "BU"]);
for (let i = 0; i < 300; i++) sampleCountry.add(pick([...regions2, ...regions3]));
const sample = {
  _note: `Node ${process.versions.node}(ICU ${icu}) Intl.DisplayNames 를 front languageName·countryName 과 같은 방식으로 부른 기대값(names_gen.mjs 생성)`,
  language: Object.fromEntries(LOCALES.map((l) => [l, Object.fromEntries([...sampleLang].map((t) => [t, frontLanguage(t, l)]))])),
  country: Object.fromEntries(LOCALES.map((l) => [l, Object.fromEntries([...sampleCountry].map((t) => [t, frontCountry(t, l)]).filter(([, v]) => v !== null))])),
};
writeFileSync(new URL("./tests/names_intl_sample.json", import.meta.url), JSON.stringify(sample, null, 1) + "\n");

console.log(`ICU ${icu} · 조합 대조 ${checked}건 · 표에 넣은 조합 ko ${Object.keys(DIFF.ko).length} en ${Object.keys(DIFF.en).length}`);
console.log(`3단 태그 표본 ${tri}건 중 규칙 불일치 ${triBad}건`, triBadEx);
console.log(`표본 language ${sampleLang.size}·country ${sampleCountry.size}`);
