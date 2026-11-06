// One-time source import. The imported files are independent, editable React source.
// Do not run over local edits: use check:source to inspect upstream drift instead.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ts from "../../front/node_modules/typescript/lib/typescript.js";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(app, "../front");
const target = path.join(app, "src/legacy");
if (fs.existsSync(target)) throw new Error("Source snapshot already exists; refusing to replace edited React files.");
const prefix = "app/[locale]/(renewal)/renewal/";
const entries = [
  "dashboard/_components/overview-body.tsx",
  "standard/answer-analysis/mention/_components/mention-body.tsx",
  "standard/answer-analysis/mention/_components/mention-tabs.tsx",
  "standard/answer-analysis/citation/_components/citation-body.tsx",
  "standard/answer-analysis/citation/_components/citation-subpages.tsx",
  "standard/prompts/_components/prompts-view.tsx",
  "website/_overview/website-overview-body.tsx",
  "website/answer-analysis/mention/_components/website-mention-body.tsx",
  "website/prompts/_components/website-prompts-view.tsx",
  "standard/ai-funnel/acr/_components/acr-body.tsx",
  "projects/_components/project-dashboard.tsx",
  "projects/_components/project-list.tsx",
  "projects/_components/project-prompts.tsx",
  "projects/_components/project-settings.tsx",
  "admin/_components/hub-accounts-manager.tsx",
  "admin/ga4/_components/ga4-registry-manager.tsx",
  "admin/standards/prompts/_components/hub-prompts-manager.tsx",
  "admin/standards/citation-sources/_components/source-overrides-manager.tsx",
  "admin/standards/citation-sources/_components/source-seeds-manager.tsx",
  "admin/standards/citation-sources/_components/source-socials-manager.tsx",
  "admin/standards/citation-sources/_components/source-codes-manager.tsx",
  "admin/standards/citation-sources/_components/source-tabs.tsx",
  "admin/standards/customer-interest/_components/interest-sources-manager.tsx",
  "admin/standards/customer-interest/_components/interest-keywords-manager.tsx",
  "admin/standards/customer-interest/_components/interest-tabs.tsx",
  "admin/standards/entities/_components/entity-roles-manager.tsx",
].map(p => prefix + p).concat([
  "lib/auth/route-policy.ts", "lib/auth/scope-policy.ts", "lib/rhq/index.ts",
  "app/[locale]/(renewal)/_shell/renewal-pages.ts",
]);
const runtime = new Set(), all = new Set();
function resolve(spec, from) {
  const base = spec.startsWith("@/") ? path.join(source, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  return base && ["", ".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.tsx"].map(ext => base + ext).find(f => fs.existsSync(f) && fs.statSync(f).isFile());
}
function visit(file, value) {
  if (value ? runtime.has(file) : all.has(file)) return;
  all.add(file);
  if (value) runtime.add(file);
  if (!/\.[cm]?[jt]sx?$/.test(file)) return;
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function walk(n) {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      let typeOnly = !!n.isTypeOnly || !!n.importClause?.isTypeOnly;
      const bindings = n.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings) && bindings.elements.every(e => e.isTypeOnly) && !n.importClause.name) typeOnly = true;
      const next = resolve(n.moduleSpecifier.text, file);
      if (next) visit(next, value && !typeOnly);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      const next = resolve(n.arguments[0].text, file);
      if (next) visit(next, value);
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      const next = resolve(n.argument.literal.text, file);
      if (next) visit(next, false);
    }
    ts.forEachChild(n, walk);
  }
  walk(sf);
}
for (const p of entries) visit(path.join(source, p), true);
const configFile = ts.readConfigFile(path.join(source, "tsconfig.json"), ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, source);
const program = ts.createProgram([...all].filter(p => /\.[jt]sx?$/.test(p)), {
  ...config.options, noEmit: false, declaration: true, emitDeclarationOnly: true,
  noEmitOnError: false, incremental: false, outDir: path.join(app, ".declarations"),
});
function write(rel, contents) {
  const p = path.join(target, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}
function transform(text) {
  if (text.includes("window.history.replaceState(")) {
    text = 'import { replaceUiHistory } from "~/app/navigation";\n' + text.replaceAll("window.history.replaceState(", "replaceUiHistory(");
  }
  return text
    .replace(/(["'])next-intl\1/g, '$1use-intl$1')
    .replace(/(["'])next\/navigation\1/g, '$1~/app/navigation$1')
    .replace(/(["'])next\/link\1/g, '$1~/app/link$1');
}
const manifest = [];
for (const file of [...all].sort()) {
  const rel = path.relative(source, file);
  const raw = fs.readFileSync(file);
  manifest.push({ source: rel, sha256: crypto.createHash("sha256").update(raw).digest("hex"), kind: runtime.has(file) ? "source" : "types" });
  if (runtime.has(file) || file.endsWith(".json")) write(rel, file.endsWith(".json") ? raw : transform(raw.toString()));
  else if (/\.[jt]sx?$/.test(file)) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`Missing declaration source: ${rel}`);
    program.emit(sf, (name, text) => {
      if (name.endsWith(".d.ts")) write(rel.replace(/\.[jt]sx?$/, ".d.ts"), "// Type-only snapshot; no database or server implementation is included.\n" + transform(text));
    }, undefined, true);
  }
}
// Replace the remaining framework-specific edges with normal React hooks/lazy.
write("i18n/routing.ts", 'export const routing = { locales: ["ko", "en"] as const, defaultLocale: "ko" as const };\nexport type Locale = "ko" | "en";\n');
write("i18n/navigation.ts", 'export { default as Link } from "~/app/locale-link";\nexport { useRouter, usePathname, redirect } from "~/app/navigation";\n');
const settingsRel = prefix + "projects/_components/project-settings.tsx";
write(settingsRel, transform(fs.readFileSync(path.join(source, settingsRel), "utf8"))
  .replace('import { getLocale, getTranslations } from "next-intl/server";', 'import { useLocale, useTranslations } from "use-intl";')
  .replaceAll("export async function", "export function")
  .replaceAll("await getTranslations(", "useTranslations(").replaceAll("await getLocale()", "useLocale()"));
write("app/[locale]/(dash)/dashboard/_components/geo-map-lazy.tsx", `import { lazy, Suspense, type ComponentProps } from "react";
const GeoMap = lazy(() => import("./geo-map").then(m => ({ default: m.GeoMap })));
export function GeoMapLazy(props: ComponentProps<typeof GeoMap>) {
  return <Suspense fallback={<div aria-hidden className="aspect-[720/400] animate-pulse rounded bg-bg-soft" />}><GeoMap {...props} /></Suspense>;
}
`);
for (const rel of ["app/globals.css", "app/renewal-theme.css"]) write(rel, fs.readFileSync(path.join(source, rel)));
fs.cpSync(path.join(source, "messages"), path.join(app, "src/messages"), { recursive: true });
fs.cpSync(path.join(source, "public"), path.join(app, "public"), { recursive: true });
fs.writeFileSync(path.join(app, "source-manifest.json"), JSON.stringify({ importedOn: "2026-11-06", entries, files: manifest }, null, 2) + "\n");
console.log(JSON.stringify({ runtimeFiles: runtime.size, typeOnlyFiles: all.size - runtime.size, total: all.size }));
