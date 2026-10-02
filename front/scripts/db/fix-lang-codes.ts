import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { websitePrompts } from "../../lib/db/schema.js";

const client = postgres(process.env.DATABASE_URL!, { prepare: false });
const db = drizzle(client);

async function main() {
  const updates = [
    { fileSeq: 79, langCode: "lv" }, // kia.lv_ru → 라트비아어
    { fileSeq: 82, langCode: "lt" }, // kia.lt_ru → 리투아니아어
    { fileSeq: 90, langCode: "hy" }, // kia.am_ru → 아르메니아어
    { fileSeq: 91, langCode: "et" }, // kia.ee_ru → 에스토니아어
  ];

  for (const { fileSeq, langCode } of updates) {
    const result = await db
      .update(websitePrompts)
      .set({ langCode, updatedAt: new Date() })
      .where(eq(websitePrompts.fileSeq, fileSeq))
      .returning({ id: websitePrompts.id });
    console.log(`fileSeq=${fileSeq} lang=${langCode} → ${result.length}행 업데이트`);
  }

  await client.end();
}

main().catch(console.error);
