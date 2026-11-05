// The service palette (2026-11-05, the user's final palette). Charts need colours as strings (recharts, inline
// styles, color-mix, the label-contrast check), so the hex values live here; app/renewal-theme.css holds the same
// values as rn-* tokens for the classes. A colour follows its role, never the series' rank:
//   당사 = Chart - Own (the base; tiers run down the ramp), compare brands and other hued series = the
//   Chart - Other bases, a series that is only context = the light grey, good · warn · bad = System.
// System green and yellow do not read as text or small icons on white: those use rn-up-ink · rn-warn-ink (the
// tokens; the same hue mixed with the text black to 4.5:1).

/** Chart - Own, dark to light; [3] is the base (= Point). */
export const RN_OWN_RAMP = ["#0b1458", "#111f8a", "#172abc", "#1e38fa", "#6274fc", "#a5affd", "#d2d7fe"] as const;
export const RN_OWN = RN_OWN_RAMP[3];
/** 당사 on the ink tooltips and legends (the base is 2.7:1 there). */
export const RN_OWN_ON_DARK = RN_OWN_RAMP[4];

/** Chart - Other, four hue families, each dark to light. */
export const RN_OTHER = {
  yellow: ["#ffbe42", "#ffce71", "#ffdfa0", "#ffebc6"],
  orange: ["#ff7651", "#ff9174", "#ffb49f", "#ffd6cb"],
  pink: ["#ff0082", "#ff59ae", "#ff99cd", "#ffbfe0"],
  purple: ["#c00ced", "#d355f3", "#ecb6fa", "#f2cefb"],
} as const;
/** The hued series beside 당사, in this order (the compare brands, the engines after the first). Purple sits
 * closest to the own blue, yellow is the faintest line on white: each comes after the other two. */
export const RN_SERIES = [RN_OTHER.orange[0], RN_OTHER.pink[0], RN_OTHER.purple[0]] as const;

/** A series left as context (brands not picked, 그 외). */
export const RN_CONTEXT = "#d5d5d6";
/** A grey series that is read (SEO traffic, all sessions beside AI). */
export const RN_GREY = "#6c6d70";
/** Quiet fills: 기타 · absent · zero, and the light stripe of a no-data hatch. */
export const RN_QUIET = "#e5e6e9";
export const RN_QUIET_2 = "#f8f8f9";

/** System: good · warn · bad, for fills and tints. */
export const RN_SYSTEM = { good: "#3df134", warn: "#faf600", bad: "#fa1e2a" } as const;

export const RN_INK = "#101012";
/** Text 5: text on dark fills. */
export const RN_ON_DARK = "#f7f7f7";
