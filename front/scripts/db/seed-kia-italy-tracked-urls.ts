/**
 * Kia Italy 프로젝트에 추적 URL 일괄 등록 (KPI ⑥ AI 타겟 URL 인용률 측정).
 *
 *   npx tsx --env-file=.env.local scripts/db/seed-kia-italy-tracked-urls.ts
 *
 * Idempotent — (project_id, url) unique 인덱스라 같은 URL은 ON CONFLICT
 * DO NOTHING. Owner = hq@hmg.test (seed의 Kia Italy 생성자).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) throw new Error("Missing env DATABASE_URL");

const URLS = [
  "https://www.kia.com/it/brochure/",
  "https://www.kia.com/it/contactless-testdrive/",
  "https://www.kia.com/it/guestbooking/new-appointment/",
  "https://www.kia.com/it/test-drive/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/ev3-contributo-prezzo/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/ev3-k-lease/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/ev3-kia-flex/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/ev3/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/ev4-contributo-prezzo/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/ev4/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/ev5/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/ev6/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/ev9/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/gamma-picanto/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/gamma-sorento/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/gamma-xceed/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/kia-niro-hev/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/kia-sportage-benzina/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/niro-ev/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/niro-gpl/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/niro-phev/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/picanto-gpl/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/picanto-pe/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/pv5-cargo-kia-flex/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/pv5-cargo/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/pv5-passanger-kia-flex/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/pv5-passenger-k-lease/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/pv5-passenger/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/scegli_kia_sportage/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/scegli-ev3/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/scegli-ev4/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/scegli-pv5-cargo/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/scegli-pv5-passenger/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/scegli-sportage/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/sorento-diesel%20/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/sorento-hev/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/sorento-phev/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/sportage-gpl/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/sportage-hev/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/sportage-mhev/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/sportage-phev-test/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/sportage-phev/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/stonic-gpl/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/stonic/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/vieni-in-concessionaria/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/xceed/",
  "https://www.kia.com/it/guida-all-acquisto/promozioni/xceed2/",
  "https://www.kia.com/it/it/PBV/Kia-PV5-Cargo",
  "https://www.kia.com/it/it/PBV/Kia-PV5-Passenger",
  "https://www.kia.com/it/modelli/cd-cuv/accessori/",
  "https://www.kia.com/it/modelli/cd-cuv/informazioni/",
  "https://www.kia.com/it/modelli/cd-cuv/specifiche/",
  "https://www.kia.com/it/modelli/ev-gt-lineup/",
  "https://www.kia.com/it/modelli/ev3/informazioni/",
  "https://www.kia.com/it/modelli/ev3/specifications/",
  "https://www.kia.com/it/modelli/ev4/discover/",
  "https://www.kia.com/it/modelli/ev4/specs/",
  "https://www.kia.com/it/modelli/ev5/discover/",
  "https://www.kia.com/it/modelli/ev6-gt/accessori/",
  "https://www.kia.com/it/modelli/ev6-gt/digital-discover/",
  "https://www.kia.com/it/modelli/ev6-gt/informazioni/",
  "https://www.kia.com/it/modelli/ev6-gt/specifiche/",
  "https://www.kia.com/it/modelli/ev6/accessori/",
  "https://www.kia.com/it/modelli/ev6/digital-discover/",
  "https://www.kia.com/it/modelli/ev6/ricaricare-ev6/",
  "https://www.kia.com/it/modelli/ev6/specifiche/",
  "https://www.kia.com/it/modelli/ev9-gt/discover/",
  "https://www.kia.com/it/modelli/ev9-gt/specifications/",
  "https://www.kia.com/it/modelli/ev9/accessori/",
  "https://www.kia.com/it/modelli/ev9/form/",
  "https://www.kia.com/it/modelli/ev9/informazioni/",
  "https://www.kia.com/it/modelli/ev9/specifiche/",
  "https://www.kia.com/it/modelli/niro-sg2-phev/informazioni/",
  "https://www.kia.com/it/modelli/niro-sg2/accessori/",
  "https://www.kia.com/it/modelli/niro-sg2/informazioni/",
  "https://www.kia.com/it/modelli/picanto/20-anni-picanto/",
  "https://www.kia.com/it/modelli/picanto/accessori/",
  "https://www.kia.com/it/modelli/picanto/informazioni/",
  "https://www.kia.com/it/modelli/seltos/premiere/",
  "https://www.kia.com/it/modelli/sorento-mq4/accessori/",
  "https://www.kia.com/it/modelli/sorento-mq4/informazioni/",
  "https://www.kia.com/it/modelli/sportage-nq5/digital-discover/",
  "https://www.kia.com/it/modelli/ybcuv-stonic/discover/",
  "https://www.kia.com/it/modelli/ybcuv-stonic/specs/",
  "https://www.kia.com/it/electric-mobility/charge/",
  "https://www.kia.com/it/electric-mobility/charge/charging-map/",
  "https://www.kia.com/it/electric-mobility/charge/fast-charging/",
  "https://www.kia.com/it/electric-mobility/charge/home-charging/",
  "https://www.kia.com/it/electric-mobility/charge/urban-charging/",
  "https://www.kia.com/it/electric-mobility/connect/",
  "https://www.kia.com/it/electric-mobility/drive/",
  "https://www.kia.com/it/electric-mobility/drive/full-electric/",
  "https://www.kia.com/it/electric-mobility/drive/hybrid/",
  "https://www.kia.com/it/electric-mobility/drive/plug-in-hybrid/",
  "https://www.kia.com/it/electric-mobility/home/",
];

const conn = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(conn);

// 1. Kia Italy 프로젝트 + hq owner lookup — raw SQL 로 schema 의존 회피
//    (prod 가 0013 operator 마이그레이션을 아직 안 받았을 수 있어서).
const projectRows = (await db.execute(sql`
  SELECT id FROM projects WHERE name = 'Kia Italy' LIMIT 1
`)) as unknown as Array<{ id: string }>;
const projectId = projectRows[0]?.id;
if (!projectId) {
  console.error("✗ 'Kia Italy' 프로젝트가 없습니다.");
  await conn.end();
  process.exit(1);
}
console.log(`✓ project: Kia Italy (id=${projectId})`);

const ownerRows = (await db.execute(sql`
  SELECT id FROM profiles WHERE email = 'hq@hmg.test' LIMIT 1
`)) as unknown as Array<{ id: string }>;
const ownerId = ownerRows[0]?.id;
if (!ownerId) {
  console.error("✗ hq@hmg.test profile 없음.");
  await conn.end();
  process.exit(1);
}
console.log(`✓ created_by: hq@hmg.test (id=${ownerId})`);

// 2. project_tracked_urls 테이블 존재 확인 (0015 마이그레이션 적용 여부).
const tableExists = (await db.execute(sql`
  SELECT to_regclass('public.project_tracked_urls') AS t
`)) as unknown as Array<{ t: string | null }>;
if (!tableExists[0]?.t) {
  console.error(
    "✗ project_tracked_urls 테이블이 없습니다. 0015 마이그레이션 먼저 적용하세요.",
  );
  await conn.end();
  process.exit(1);
}

// 3. Dedupe + INSERT
const unique = Array.from(new Set(URLS));
console.log(`\n등록 시도: ${URLS.length} URL (중복 제거 후 ${unique.length})`);

const before = (await db.execute(sql`
  SELECT count(*)::int AS c FROM project_tracked_urls WHERE project_id = ${projectId}
`)) as unknown as Array<{ c: number }>;
console.log(`Before: ${before[0]?.c ?? 0} rows`);

// VALUES 다중 행 INSERT — (project_id, url, label, created_by) 튜플 풀어쓰기.
const values = sql.join(
  unique.map(
    (u) => sql`(${projectId}::uuid, ${u}, NULL, ${ownerId}::uuid)`,
  ),
  sql`, `,
);
await db.execute(sql`
  INSERT INTO project_tracked_urls (project_id, url, label, created_by)
  VALUES ${values}
  ON CONFLICT (project_id, url) DO NOTHING
`);

const after = (await db.execute(sql`
  SELECT count(*)::int AS c FROM project_tracked_urls WHERE project_id = ${projectId}
`)) as unknown as Array<{ c: number }>;
const afterCount = after[0]?.c ?? 0;
const beforeCount = before[0]?.c ?? 0;
console.log(`After:  ${afterCount} rows  (+${afterCount - beforeCount} 신규)`);

await conn.end();
console.log("\ndone.");
