/**
 * Seeds initial users (Supabase Auth) + their profiles (role/scope).
 * Requires live credentials — run with env loaded:
 *
 *   SEED_PASSWORD=... npx tsx --env-file=.env.local scripts/db/seed.ts
 *
 * Idempotent-ish: skips auth users that already exist and uses onConflictDoNothing
 * for profiles. 비밀번호는 코드에 두지 않는다 — SEED_PASSWORD(+계정별 override)로 주입한다.
 */
import { createClient } from "@supabase/supabase-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and } from "drizzle-orm";
import {
  profiles,
  projects,
  projectMembers,
  standardPrompts,
  standardKeywords,
  standardSources,
} from "../../lib/db/schema";
import type { Role, OperatorScope } from "../../lib/auth/types";
import {
  rhqRegionIdsForBrand,
  countriesForRhq,
} from "../../lib/rhq";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DATABASE_URL = process.env.DATABASE_URL!;

if (!SUPABASE_URL || !SERVICE_ROLE || !DATABASE_URL) {
  throw new Error(
    "Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL",
  );
}

// 시드 계정 비밀번호는 코드에 두지 않는다 — SEED_PASSWORD 로 주입한다.
// 계정별로 다른 값이 필요하면 SEED_PASSWORD_<이메일 로컬파트 대문자>(비영숫자는 _)로 덮어쓴다.
// 예: website-kr@hmg.test → SEED_PASSWORD_WEBSITE_KR
const SEED_PASSWORD = process.env.SEED_PASSWORD;
if (!SEED_PASSWORD) {
  throw new Error("Missing env: SEED_PASSWORD (시드 계정 비밀번호)");
}

function passwordFor(email: string): string {
  const key =
    "SEED_PASSWORD_" +
    email.split("@")[0].toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return process.env[key] ?? SEED_PASSWORD!;
}

type Seed = {
  email: string;
  role: Role;
  scopeAll: boolean;
  brands?: string[];
  regions?: string[];
  countries?: string[];
  // 메뉴 그룹 화이트리스트(좁히기 전용, 0039). 미지정=null(role 기본 메뉴 그대로).
  // 예: role hq + menuGroups ["project"] → 프로젝트 메뉴만 보이는 hq 계정.
  menuGroups?: ("standard" | "website" | "project" | "admin")[];
  // operator (cost-gate) — orthogonal to role (GGMD scenario 3-2). Default none.
  // In production the operating accounts are 이노션 본사(global)/법인(assigned);
  // here we map the demo HQ/region accounts to those operator levels so the
  // prompt-execute / intent-collect demo flows stay exercisable, while keeping
  // a country account at none to demonstrate the gate blocking a 그룹사 user.
  operator?: OperatorScope;
};

// Kia 권역/국가 풀이 — KIA HQ/EU 데모 계정의 scope를 RHQ 정본(lib/rhq)에서 풀어쓴다.
// 권역 값은 RHQ 권역 id(브랜드 프리픽스). Kia는 유럽을 서/동으로 분리 → Kia EU RHQ는
// 두 권역을 함께 보유.
const KIA_REGIONS = rhqRegionIdsForBrand("Kia");
const KIA_EU_REGIONS = ["kia-western-europe", "kia-eastern-europe"];
const KIA_EU_COUNTRIES = KIA_EU_REGIONS.flatMap((r) => countriesForRhq(r));
const KIA_GLOBAL_COUNTRIES = KIA_REGIONS.flatMap((r) => countriesForRhq(r));

// hq/region/country 값은 2026-07-06 QA 감사(QA-STD-016)에서 실제 DB profiles와
// 대조해 맞춘 것 — 이전 버전은 이 파일과 DB가 서로 다른 값을 가리키고 있어
// `db:seed` 재실행 시 hq 계정이 scopeAll:true(전체 무제한)로 리그레션될 위험이
// 있었다. hq는 scope-policy.ts가 문서화한 "HQ = Own Brand × 전 권역 × 전 국가"
// 계층과 정확히 일치하도록 수정. region/country는 실제 DB가 이미 다국적
// (Hyundai/Kia/Genesis 3사) 권역을 가진 상태였음 — 단일 브랜드로 좁힐지는
// 제품 확인 필요(이 파일은 현재 DB 상태를 그대로 반영해 재시드 시 회귀만 막음).
const SEED: Seed[] = [
  { email: "hq@hmg.test", role: "hq", scopeAll: false, brands: ["Hyundai"], operator: "global" },
  { email: "region@hmg.test", role: "region", scopeAll: false, regions: ["hyundai-europe", "kia-western-europe", "kia-eastern-europe", "genesis-europe"], operator: "assigned" },
  { email: "country@hmg.test", role: "country", scopeAll: false, regions: ["hyundai-asia-pacific", "kia-asia-pacific", "genesis-asia-pacific"], countries: ["KR"], operator: "none" },
  { email: "admin@hmg.test", role: "admin", scopeAll: true, operator: "global" },
  // Kia 운영자 데모 — P0(region/HQ rollup) 흐름 검증용. lib/geo-catalog
  // 카탈로그가 곧 scope라 권역/국가 list는 풀이된 값으로 박는다.
  //
  // kia-hq      : Kia 글로벌 — KPI #7 rollup + 모든 측정 시장 합산 (현재 IT만)
  // kia-eu      : Kia Europe RHQ — KPI #7 rollup + 권역 41국 커버리지
  // kia-it      : Kia Italy NSC — KPI #7 single 3.8%, 페이지표 라이브
  // kia-de      : Kia Germany NSC — 매핑 안 된 시장 → KPI null ("측정 대기")
  //                검증용. resolveProperty 분기 sanity check.
  {
    email: "kia-hq@kia.test",
    role: "hq",
    scopeAll: false,
    brands: ["Kia"],
    regions: KIA_REGIONS,
    countries: KIA_GLOBAL_COUNTRIES,
    operator: "global",
  },
  {
    email: "kia-eu@kia.test",
    role: "region",
    scopeAll: false,
    brands: ["Kia"],
    regions: KIA_EU_REGIONS,
    countries: KIA_EU_COUNTRIES,
    operator: "assigned",
  },
  {
    email: "kia-it@kia.test",
    role: "country",
    scopeAll: false,
    brands: ["Kia"],
    regions: ["kia-western-europe"],
    countries: ["IT"],
  },
  {
    email: "kia-de@kia.test",
    role: "country",
    scopeAll: false,
    brands: ["Kia"],
    regions: ["kia-western-europe"],
    countries: ["DE"],
  },
  // vendor demo users (v23 5-role model). Scope narrower than the matching
  // country user — vendor only sees what the HQ/region operator explicitly
  // assigned via the admin scope UI (Task J). Defaults below mirror the
  // common case: a Hyundai KR vendor and a Hyundai EU vendor.
  {
    email: "vendor-kr@hmg.test",
    role: "vendor",
    scopeAll: false,
    brands: ["Hyundai"],
    regions: ["hyundai-asia-pacific"],
    countries: ["KR"],
  },
  {
    email: "vendor-eu@hmg.test",
    role: "vendor",
    scopeAll: false,
    brands: ["Hyundai"],
    regions: ["hyundai-europe"],
    countries: ["DE", "FR"],
  },
  // website demo user (2026-07-22 6-role model: [글로벌X, 웹O, 프로젝트X]).
  // 본인 공식 사이트만 확인하는 계정 — GNB에 웹사이트 탭만 뜨고 랜딩도 /website.
  // 데이터 범위는 country 계정과 같은 방식(프로필 scope)으로 자국 사이트에 한정.
  {
    email: "website-kr@hmg.test",
    role: "website",
    scopeAll: false,
    brands: ["Hyundai"],
    regions: ["hyundai-asia-pacific"],
    countries: ["KR"],
    operator: "none",
  },
];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const sql = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(sql);

for (const s of SEED) {
  const { data, error } = await admin.auth.admin.createUser({
    email: s.email,
    password: passwordFor(s.email),
    email_confirm: true,
  });
  if (error || !data.user) {
    console.warn(`skip ${s.email}: ${error?.message ?? "no user"}`);
    continue;
  }
  await db
    .insert(profiles)
    .values({
      id: data.user.id,
      email: s.email,
      role: s.role,
      scopeAll: s.scopeAll,
      brands: s.brands ?? null,
      regions: s.regions ?? null,
      countries: s.countries ?? null,
      // vendor is operator-OFF permanently regardless of the seed value.
      operator: s.role === "vendor" ? "none" : s.operator ?? "none",
      // 메뉴 그룹 화이트리스트(좁히기 전용, 0039). 미지정 = null(제한 없음).
      menuGroups: s.menuGroups ?? null,
    })
    .onConflictDoNothing();
  console.log(`seeded ${s.email} (${s.role})`);
}

// Seed a single demo project owned by the hq user (member-management flow
// needs at least one Project to anchor invites on). Idempotent — looks up
// hq profile by email, checks for an existing project by name, and skips
// insert if both already exist.
const hq = await db
  .select()
  .from(profiles)
  .where(eq(profiles.email, "hq@hmg.test"))
  .limit(1);
const hqProfile = hq[0];
if (!hqProfile) {
  console.warn("skip demo project: hq profile not found");
} else {
  const existing = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.name, "Sample project"),
        eq(projects.createdBy, hqProfile.id),
      ),
    )
    .limit(1);
  if (existing[0]) {
    console.log(`demo project already exists (id=${existing[0].id})`);
  } else {
    const [created] = await db
      .insert(projects)
      .values({
        name: "Sample project",
        description: "Demo project for member-management testing",
        domain: "example.com",
        brand: "Hyundai",
        country: "KR",
        language: "ko",
        createdBy: hqProfile.id,
      })
      .returning();
    await db.insert(projectMembers).values({
      projectId: created.id,
      userId: hqProfile.id,
      role: "owner",
      status: "active",
      invitedBy: hqProfile.id,
      acceptedAt: new Date(),
    });
    // Candidate pool intentionally starts empty — per v22 user flow,
    // prompt_candidates only accumulate via Intent (Google Keyword +
    // Social Scraping) runs. Seeding fake candidates here would create
    // a misleading "out of the box" state.
    console.log(
      `seeded demo project (id=${created.id}) + Owner=${hqProfile.email}`,
    );
  }
}

// Kia Italy — first real PoC project (2026-06-04 decision). kia.com/it/it
// has GA4 read access via geo-ops@example.com, so this project is the
// one where trafficConversion KPI can actually be measured (others remain
// sample). Owned by hq for now; can be transferred to a Kia-scoped user
// later. Idempotent: skip if a project with the same name + creator pair
// already exists.
if (hqProfile) {
  // Find-or-create the Kia Italy project, then ensure memberships SEPARATELY so
  // re-running the seed on a DB that already has the project still repairs the
  // membership list (the earlier "skip if exists" left kia-it@ unable to see it).
  const kiaIt = (
    await db
      .select()
      .from(profiles)
      .where(eq(profiles.email, "kia-it@kia.test"))
      .limit(1)
  )[0];

  let kiaProject = (
    await db
      .select()
      .from(projects)
      .where(
        and(eq(projects.name, "Kia Italy"), eq(projects.createdBy, hqProfile.id)),
      )
      .limit(1)
  )[0];

  if (!kiaProject) {
    [kiaProject] = await db
      .insert(projects)
      .values({
        name: "Kia Italy",
        description:
          "First real PoC — GA4 reachable via geo-ops@example.com; trafficConversion KPI measurable for this project",
        domain: "kia.com/it/it",
        brand: "Kia",
        country: "IT",
        language: "it",
        // ga4_property_id left NULL on purpose — (Kia, IT) resolves via the
        // central catalog (lib/ga4/property-map). To exercise the per-project
        // GA4 binding, set it in project 설정 (overrides the catalog).
        createdBy: hqProfile.id,
      })
      .returning();
    console.log(`seeded Kia Italy project (id=${kiaProject.id})`);
  } else {
    console.log(`Kia Italy project already exists (id=${kiaProject.id})`);
  }

  // hq (creator) + kia-it (Italy NSC) both own it — idempotent via the
  // (project_id, user_id) unique index, so it's repaired on re-seed. kia-it@
  // as owner lets the Kia-scoped account view AND edit settings (e.g. set the
  // per-project ga4PropertyId) — the account the QA flow actually uses.
  const owners = [hqProfile.id, kiaIt?.id].filter((v): v is string => !!v);
  for (const userId of owners) {
    await db
      .insert(projectMembers)
      .values({
        projectId: kiaProject.id,
        userId,
        role: "owner",
        status: "active",
        invitedBy: hqProfile.id,
        acceptedAt: new Date(),
      })
      .onConflictDoNothing();
  }
  console.log(
    `ensured Kia Italy owners: hq@${kiaIt ? " + kia-it@" : ""} (id=${kiaProject.id})`,
  );
}

// ─── Standards seed (Task R4) ────────────────────────────────────────────
//
// admin@hmg.test가 등록한 것으로 표시한다. Idempotent — 이미 1개 이상 row
// 가 있는 테이블은 건너뛰어서 운영자가 수동 등록한 row를 덮어쓰지 않는다.
const adminRows = await db
  .select()
  .from(profiles)
  .where(eq(profiles.email, "admin@hmg.test"))
  .limit(1);
const adminProfile = adminRows[0];

if (!adminProfile) {
  console.warn("skip standards seed: admin profile not found");
} else {
  const existingPrompts = await db.select().from(standardPrompts).limit(1);
  if (existingPrompts.length === 0) {
    // 12 prompts covering 3 funnel stages × HMG brands × competitors.
    // 분포: awareness 4 / consideration 5 / purchase 3.
    await db.insert(standardPrompts).values([
      // awareness — brand/segment 인지 단계
      { text: "가족용 SUV 추천해줘", promptType: "recommendation", category: "차종/awareness", brand: null, createdBy: adminProfile.id },
      { text: "2026년 인기 전기차 비교해줘", promptType: "comparison", category: "차종/awareness", brand: null, createdBy: adminProfile.id },
      { text: "한국에서 가장 잘 팔리는 SUV는?", promptType: "information", category: "시장/awareness", brand: null, createdBy: adminProfile.id },
      { text: "유럽에서 인기 있는 한국 자동차 브랜드는?", promptType: "information", category: "시장/awareness", brand: null, createdBy: adminProfile.id },
      // consideration — 모델 비교 / 스펙 확인
      { text: "Ioniq 5 가격과 주행거리는?", promptType: "information", category: "Hyundai/consideration", brand: "Hyundai", createdBy: adminProfile.id },
      { text: "Kia EV9과 Tesla Model Y 중 패밀리카로는?", promptType: "comparison", category: "경쟁비교/consideration", brand: "Kia", createdBy: adminProfile.id },
      { text: "Genesis GV80와 BMW X5 가격대비 만족도는?", promptType: "comparison", category: "경쟁비교/consideration", brand: "Genesis", createdBy: adminProfile.id },
      { text: "Palisade 9인승 모델 단점 알려줘", promptType: "other", category: "Hyundai/consideration", brand: "Hyundai", createdBy: adminProfile.id },
      { text: "Kia Sportage HEV vs Toyota RAV4 Hybrid 연비 비교", promptType: "comparison", category: "경쟁비교/consideration", brand: "Kia", createdBy: adminProfile.id },
      // purchase — 구매 결정 단계
      { text: "현대차 보증기간 비교해줘", promptType: "information", category: "Hyundai/purchase", brand: "Hyundai", createdBy: adminProfile.id },
      { text: "Kia Italy 딜러쉽 위치 어디?", promptType: "information", category: "Kia/purchase", brand: "Kia", createdBy: adminProfile.id },
      { text: "이번 분기 EV 보조금 받을 수 있는 차종은?", promptType: "information", category: "정책/purchase", brand: null, createdBy: adminProfile.id },
    ]);
    console.log("seeded standard_prompts (12 rows)");
  } else {
    console.log("standard_prompts already populated — skip");
  }

  const existingKeywords = await db.select().from(standardKeywords).limit(1);
  if (existingKeywords.length === 0) {
    // 20 keywords — google_keyword 12 + community_voc 8.
    // Brand 분포: Hyundai 5 / Kia 4 / Genesis 2 / 무브랜드 9.
    await db.insert(standardKeywords).values([
      // google_keyword (검색 트래픽 기반)
      { term: "패밀리 SUV", sourceType: "google_keyword", brand: null, createdBy: adminProfile.id },
      { term: "전기 SUV 추천", sourceType: "google_keyword", brand: null, createdBy: adminProfile.id },
      { term: "Ioniq 5 시승기", sourceType: "google_keyword", brand: "Hyundai", createdBy: adminProfile.id },
      { term: "EV9 가격", sourceType: "google_keyword", brand: "Kia", createdBy: adminProfile.id },
      { term: "GV80 옵션", sourceType: "google_keyword", brand: "Genesis", createdBy: adminProfile.id },
      { term: "Palisade 9인승", sourceType: "google_keyword", brand: "Hyundai", createdBy: adminProfile.id },
      { term: "Kia Sportage HEV 연비", sourceType: "google_keyword", brand: "Kia", createdBy: adminProfile.id },
      { term: "Genesis G80 신형", sourceType: "google_keyword", brand: "Genesis", createdBy: adminProfile.id },
      { term: "전기차 보조금 신청", sourceType: "google_keyword", brand: null, createdBy: adminProfile.id },
      { term: "수소차 충전소 위치", sourceType: "google_keyword", brand: null, createdBy: adminProfile.id },
      { term: "Tesla vs 현대차 전기차", sourceType: "google_keyword", brand: null, notes: "경쟁사 키워드 — 자사 노출 모니터링", createdBy: adminProfile.id },
      { term: "Kia Italia listino prezzi", sourceType: "google_keyword", brand: "Kia", notes: "이탈리아 시장 — Kia Italy 프로젝트용", createdBy: adminProfile.id },
      // community_voc (감성/이슈 기반)
      { term: "전기차 충전 인프라", sourceType: "community_voc", brand: null, notes: "사용자 페인 포인트", createdBy: adminProfile.id },
      { term: "현대차 결함 리콜", sourceType: "community_voc", brand: "Hyundai", notes: "부정 감성 모니터링", createdBy: adminProfile.id },
      { term: "EV 보조금", sourceType: "community_voc", brand: null, createdBy: adminProfile.id },
      { term: "차박 SUV", sourceType: "community_voc", brand: null, createdBy: adminProfile.id },
      { term: "Kia 보증 서비스 후기", sourceType: "community_voc", brand: "Kia", createdBy: adminProfile.id },
      { term: "Genesis 정비센터 만족도", sourceType: "community_voc", brand: "Genesis", createdBy: adminProfile.id },
      { term: "현대차 OTA 업데이트", sourceType: "community_voc", brand: "Hyundai", notes: "SW-defined vehicle 관심사", createdBy: adminProfile.id },
      { term: "EV 잔존가치", sourceType: "community_voc", brand: null, notes: "중고차 시장 트렌드", createdBy: adminProfile.id },
    ]);
    console.log("seeded standard_keywords (20 rows)");
  } else {
    console.log("standard_keywords already populated — skip");
  }

  const existingSources = await db.select().from(standardSources).limit(1);
  if (existingSources.length === 0) {
    // 20 source URLs — channel 균등 분포 (news 6 / pr 5 / social 4 / community 5).
    // 시장: 국내 12 / 글로벌 8 (이탈리아·미국 등).
    await db.insert(standardSources).values([
      // news
      { url: "carblog.kr", channel: "news", brand: null, notes: "국내 자동차 전문 미디어", createdBy: adminProfile.id },
      { url: "motorgraph.com", channel: "news", brand: null, createdBy: adminProfile.id },
      { url: "auto.danawa.com", channel: "news", brand: null, createdBy: adminProfile.id },
      { url: "etnews.com/automobile", channel: "news", brand: null, createdBy: adminProfile.id },
      { url: "autocar.co.uk", channel: "news", brand: null, notes: "유럽 자동차 매체", createdBy: adminProfile.id },
      { url: "quattroruote.it", channel: "news", brand: null, notes: "이탈리아 자동차 매체 — Kia Italy", createdBy: adminProfile.id },
      // pr (자사 채널 — 자체 인용 모니터링)
      { url: "hyundai.com/kr/ko/newsroom", channel: "pr", brand: "Hyundai", createdBy: adminProfile.id },
      { url: "press.kia.com", channel: "pr", brand: "Kia", createdBy: adminProfile.id },
      { url: "genesis.com/worldwide/en/newsroom", channel: "pr", brand: "Genesis", createdBy: adminProfile.id },
      { url: "kia.com/it/it/scopri/news", channel: "pr", brand: "Kia", notes: "Kia Italy 공식 PR", createdBy: adminProfile.id },
      { url: "hyundainews.com", channel: "pr", brand: "Hyundai", notes: "미국 시장", createdBy: adminProfile.id },
      // social
      { url: "twitter.com/Hyundai", channel: "social", brand: "Hyundai", createdBy: adminProfile.id },
      { url: "youtube.com/@HyundaiKorea", channel: "social", brand: "Hyundai", createdBy: adminProfile.id },
      { url: "instagram.com/kia.worldwide", channel: "social", brand: "Kia", createdBy: adminProfile.id },
      { url: "linkedin.com/company/genesis-motor", channel: "social", brand: "Genesis", createdBy: adminProfile.id },
      // community
      { url: "bobaedream.co.kr", channel: "community", brand: null, notes: "국내 최대 자동차 커뮤니티", createdBy: adminProfile.id },
      { url: "clien.net/service/board/cm_car", channel: "community", brand: null, createdBy: adminProfile.id },
      { url: "reddit.com/r/Hyundai", channel: "community", brand: "Hyundai", createdBy: adminProfile.id },
      { url: "reddit.com/r/Kia", channel: "community", brand: "Kia", createdBy: adminProfile.id },
      { url: "ruoteclassiche.it/forum", channel: "community", brand: null, notes: "이탈리아 자동차 포럼 — Kia Italy", createdBy: adminProfile.id },
    ]);
    console.log("seeded standard_sources (20 rows)");
  } else {
    console.log("standard_sources already populated — skip");
  }
}

await sql.end();
console.log("done.");
