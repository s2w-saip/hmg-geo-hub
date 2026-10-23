// Test helper — reads the filter structure out of server-rendered markup of the app's
// DimensionFilterPanel (facet chips + menus) and of the renewal panel (sections + rows),
// so a parity test can compare section rows, axis order, option labels, checked /
// disabled state, search boxes and time presets. Same reader as
// overview-filter-model.parity.test.tsx, shared by the later renewal parity tests.

import ko from "@/messages/ko.json";

export type El = { tag: string; attrs: Record<string, string>; children: El[]; text?: string; parent?: El };
export type Axis = { label: string; search?: boolean; groups?: { header: string; items: [string, string][] }[]; presets?: [string, string, boolean][] };

const VOID = new Set(["input", "hr", "br", "img", "meta", "link", "area", "col", "source", "wbr"]);
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Minimal parser for react-dom/server markup (quoted attributes, void tags). */
export function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let cur = root;
  for (const m of html.matchAll(re)) {
    if (m[1]) {
      let n: El | undefined = cur;
      while (n && n.tag !== m[1].toLowerCase()) n = n.parent;
      if (n?.parent) cur = n.parent;
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? "");
      const el: El = { tag: m[2].toLowerCase(), attrs, children: [], parent: cur };
      cur.children.push(el);
      if (!m[4] && !VOID.has(el.tag)) cur = el;
    } else if (m[5]) cur.children.push({ tag: "#text", attrs: {}, children: [], text: decode(m[5]), parent: cur });
  }
  return root;
}
export const all = (n: El, pred: (e: El) => boolean, out: El[] = []): El[] => {
  for (const c of n.children) {
    if (c.tag !== "#text" && pred(c)) out.push(c);
    all(c, pred, out);
  }
  return out;
};
export const text = (n: El): string => (n.tag === "#text" ? n.text ?? "" : n.children.map(text).join("")).replace(/\s+/g, " ").trim();
const hasClass = (e: El, c: string) => (e.attrs.class ?? "").split(/\s+/).includes(c);
const ownText = (n: El) => n.children.filter((c) => c.tag === "#text").map((c) => c.text).join("").trim();

/** The app panel: section labels + one entry per facet chip with its menu contents. */
export function appStructure(html: string): { sections: string[]; axes: Axis[] } {
  const root = parse(html);
  const sections = all(root, (e) => "data-section-label" in e.attrs).map(text);
  const axes: Axis[] = [];
  for (const btn of all(root, (e) => e.tag === "button" && hasClass(e, "facet-chip"))) {
    const label = text(all(btn, (e) => hasClass(e, "truncate"))[0]);
    const content = all(btn.parent!.parent!, (e) => e.attrs["data-testid"] === "menu-content")[0];
    if (label === ko.dashboard.filters.group.time) {
      axes.push({
        label,
        presets: all(content, (e) => "data-preset" in e.attrs).map((e) => [text(e), e.attrs["aria-checked"], e.attrs["aria-disabled"] === "true"]),
      });
      continue;
    }
    const groups: { header: string; items: [string, string][] }[] = [{ header: "", items: [] }];
    for (const e of all(content, (x) => x.tag === "button" || x.attrs.role === "menuitemcheckbox")) {
      if (e.tag === "button") groups.push({ header: text(e), items: [] });
      else groups[groups.length - 1].items.push([text(e), e.attrs["aria-checked"]]);
    }
    axes.push({ label, search: all(content, (e) => e.tag === "input" && e.attrs.type === "text").length > 0, groups: groups.filter((g) => g.header || g.items.length) });
  }
  return { sections, axes };
}

/** The renewal panel: section rows (data-rn-section) + one entry per axis section. */
export function renewalStructure(html: string): { sections: string[]; axes: Axis[] } {
  const root = parse(html);
  const blocks = all(root, (e) => "data-rn-section" in e.attrs);
  const sections = blocks.map((b) => text(b.children[0]));
  const axes: Axis[] = [];
  for (const sec of blocks.flatMap((b) => b.children.filter((c) => c.tag === "section"))) {
    const head = sec.children[0];
    const label = text(head.children.filter((c) => c.tag === "span")[0]);
    const rows = all(sec, (e) => e.attrs.role === "checkbox");
    const rowLabel = (r: El) => text(r.children.filter((c) => c.tag === "span")[1]);
    if (label === ko.dashboard.filters.group.time) {
      axes.push({ label, presets: rows.map((r) => [rowLabel(r), r.attrs["aria-checked"], r.attrs["aria-disabled"] === "true"]) });
      continue;
    }
    const groups: { header: string; items: [string, string][] }[] = [{ header: "", items: [] }];
    for (const e of all(sec, (x) => (x.tag === "button" && "aria-pressed" in x.attrs) || x.attrs.role === "checkbox")) {
      if (e.tag === "button") groups.push({ header: ownText(e) || text(e), items: [] });
      else groups[groups.length - 1].items.push([rowLabel(e), e.attrs["aria-checked"]]);
    }
    axes.push({ label, search: all(sec, (e) => e.tag === "input" && e.attrs.type !== "date").length > 0, groups: groups.filter((g) => g.header || g.items.length) });
  }
  return { sections, axes };
}
