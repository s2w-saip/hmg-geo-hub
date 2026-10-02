import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import u11ko from "@/messages/units/u11.ko.json";
import u11en from "@/messages/units/u11.en.json";
import { deepMergeMessages } from "@/i18n/request";

// Render check of the U11 component changes with the real dictionaries (base + unit u11): the
// api-source additions render and every key they use exists in both locales (a missing key
// throws here instead of showing the raw key). The legacy source renders as before.

vi.mock("../_actions", () => ({ createUser: vi.fn(), updateUserProfile: vi.fn(), deleteUser: vi.fn() }));
vi.mock("../standards/entities/_actions", () => ({ setEntityRole: vi.fn() }));
vi.mock("../standards/citation-sources/_actions", () => ({
  setCitationDomainCategory: vi.fn(),
  clearCitationDomainOverride: vi.fn(),
}));
vi.mock("../ga4/_actions", () => ({
  upsertGa4Mapping: vi.fn(),
  verifyGa4Mapping: vi.fn(),
  removeGa4Mapping: vi.fn(),
  importLegacyMapping: vi.fn(),
}));
vi.mock("@/components/dash/ga4-events-dialog", () => ({ Ga4EventsDialog: () => null }));

const { CreateUserForm } = await import("./create-user-form");
const { UserListClient } = await import("./user-list-client");
const { EntityCatalog } = await import("../standards/entities/_components/entity-catalog");
const { DomainList } = await import("../standards/citation-sources/_components/domain-list");
const { Ga4RegistryClient } = await import("../ga4/_components/ga4-registry-client");

const MESSAGES = { ko: deepMergeMessages(ko, u11ko), en: deepMergeMessages(en, u11en) };
// Expected labels come from the unit dictionary (no copy literals in this file).
const SUSPENDED = u11ko.admin.list.status.suspended;
const SOCIAL = u11ko.adminCitationSources.list.source.social;

function render(node: ReactNode, locale: "ko" | "en" = "ko"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={MESSAGES[locale]}
      timeZone="Asia/Seoul"
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const user = (over: Record<string, unknown> = {}) => ({
  id: "u1", email: "a@t.test", role: "country" as const, scopeAll: false, brands: ["Kia"], regions: null, countries: ["KR"],
  operator: "none" as const, createdAt: "2026-06-01", lastSignInAt: null, ...over,
});

describe("U11 component changes render in both locales", () => {
  it("create form: email only on legacy, role + operator + scope on api (D10)", () => {
    for (const locale of ["ko", "en"] as const) {
      const legacy = render(<CreateUserForm />, locale);
      const api = render(<CreateUserForm withRoleScope />, locale);
      expect(legacy).not.toContain('role="combobox"');
      expect(api.match(/role="combobox"/g)?.length).toBe(2);
      expect(api).toContain(locale === "ko" ? "전체 범위 허용" : (en as { admin: { edit: { scope: { all: string } } } }).admin.edit.scope.all);
    }
  });

  it("user list: suspended badge only for suspended api rows", () => {
    const html = render(<UserListClient users={[user({ status: "suspended", rowVersion: 3 }), user({ id: "u2", email: "b@t.test" })]} selfId="x" />);
    expect(html.split(`>${SUSPENDED}<`).length - 1).toBe(2); // mobile card + desktop row
    expect(render(<UserListClient users={[user()]} selfId="x" />)).not.toContain(`>${SUSPENDED}<`);
  });

  it("entity catalog: period note on api only", () => {
    const rows = [{ entityId: "e1", name: "Kia", mentions: 3, answers: 2, role: "competitor" as const, brandCode: "Kia" }];
    expect(render(<EntityCatalog rows={rows} source="api" />)).toContain("최신 노출 회차");
    expect(render(<EntityCatalog rows={rows} />)).not.toContain("최신 노출 회차");
    expect(render(<EntityCatalog rows={rows} source="api" />, "en")).toContain("latest published cycle");
  });

  it("domain list: social source badge and the api hint", () => {
    const row = {
      domain: "youtube.com", citations: 2, category: "Social & Video" as const, source: "social" as const, shadowsOwned: false,
      overrideNote: null, overrideUpdatedBy: null, overrideUpdatedAt: null,
    };
    const html = render(<DomainList rows={[row]} limit={500} source="api" />);
    expect(html).toContain(`>${SOCIAL}<`);
    expect(html).toContain("최신 노출 회차(글로벌 표면)");
    expect(render(<DomainList rows={[row]} limit={500} source="api" />, "en")).toContain(">Social<");
  });

  it("GA4: an unmapped property row reads as 'no market mapping', a property-less market keeps the legacy label", () => {
    const html = render(
      <Ga4RegistryClient
        rows={[
          { id: "p:1", brand: "", countryCode: "", propertyId: "1", status: "unmapped", verifiedAt: null },
          { id: "m:Kia:US", brand: "Kia", countryCode: "US", propertyId: null, status: "unmapped", verifiedAt: null },
        ]}
        legacy={[]}
        overrides={[]}
      />,
    );
    expect(html).toContain("시장 매핑 없음");
    expect(html).toContain("속성ID 미정");
  });
});
