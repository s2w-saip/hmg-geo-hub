/**
 * Live smoke test for the keyword tools (ported from aeorank). Hits the real
 * APIs with the exact request shapes lib/keyword/* sends, so it validates the
 * credentials + endpoints + model without going through the session gate or
 * Next's bundler (which is what `import "server-only"` needs). Mirrors
 * scripts/scope/verify-public-api.ts.
 *
 *   1. DataForSEO search volume  (DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD)
 *   2. OpenRouter keyword→prompt (OPENROUTER_API_KEY [+ OPENROUTER_MODEL])
 *
 * Run:  npm run verify:keyword
 */

const SAMPLE = ["현대 아이오닉 6", "제네시스 GV80"];
const KR = { location_code: 2410, language_code: "ko" };
const MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";

async function checkDataForSeo(): Promise<boolean> {
  console.log(`\n[1/2] DataForSEO search volume — KR (${KR.location_code}/${KR.language_code})`);
  const login = process.env.DATAFORSEO_LOGIN!;
  const password = process.env.DATAFORSEO_PASSWORD!;
  const credentials = Buffer.from(`${login}:${password}`).toString("base64");
  const res = await fetch(
    "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        { keywords: SAMPLE, ...KR, sort_by: "search_volume" },
      ]),
    },
  );
  if (!res.ok) {
    console.error(`  ✗ HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return false;
  }
  const data = await res.json();
  if (data.status_code !== 20000) {
    console.error(`  ✗ status ${data.status_code}: ${data.status_message}`);
    return false;
  }
  const result = data.tasks?.[0]?.result ?? [];
  for (const v of result) {
    console.log(
      `  • ${String(v.keyword).padEnd(18)} vol=${String(v.search_volume).padStart(8)}  comp=${v.competition}  cpc=${v.cpc}  months=${v.monthly_searches?.length ?? 0}`,
    );
  }
  console.log(`  ✓ DataForSEO OK (cost=$${data.cost}, ${result.length} rows)`);
  return true;
}

async function checkOpenRouter(): Promise<boolean> {
  console.log(`\n[2/2] OpenRouter keyword→prompt — model=${MODEL}`);
  const prompt = `Convert these ${SAMPLE.length} keywords into natural questions people would ask an AI chatbot. Keep them in the same language. Items:\n${SAMPLE.map((k, i) => `${i + 1}. ${k}`).join("\n")}`;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
      max_tokens: 2000,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "output",
          strict: true,
          schema: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    originalInput: { type: "string" },
                    question: { type: "string" },
                    searchIntent: {
                      type: "string",
                      enum: ["informational", "navigational", "transactional", "commercial"],
                    },
                  },
                  required: ["originalInput", "question", "searchIntent"],
                  additionalProperties: false,
                },
              },
            },
            required: ["questions"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!res.ok) {
    console.error(`  ✗ HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return false;
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    console.error(`  ✗ no content: ${JSON.stringify(data).slice(0, 300)}`);
    return false;
  }
  const parsed = JSON.parse(content);
  for (const q of parsed.questions ?? []) {
    console.log(`  • [${q.searchIntent}] ${q.originalInput} → ${q.question}`);
  }
  console.log(`  ✓ OpenRouter OK (${parsed.questions?.length ?? 0} questions)`);
  return true;
}

async function main() {
  const missing = [
    !process.env.DATAFORSEO_LOGIN && "DATAFORSEO_LOGIN",
    !process.env.DATAFORSEO_PASSWORD && "DATAFORSEO_PASSWORD",
    !process.env.OPENROUTER_API_KEY && "OPENROUTER_API_KEY",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`✗ Missing env in .env.local: ${missing.join(", ")}`);
    process.exit(2);
  }

  let ok = true;
  try {
    ok = (await checkDataForSeo()) && ok;
  } catch (e) {
    ok = false;
    console.error("  ✗ DataForSEO threw:", e instanceof Error ? e.message : e);
  }
  try {
    ok = (await checkOpenRouter()) && ok;
  } catch (e) {
    ok = false;
    console.error("  ✗ OpenRouter threw:", e instanceof Error ? e.message : e);
  }

  console.log(ok ? "\n✓ All keyword integrations live." : "\n✗ Smoke test had failures.");
  process.exit(ok ? 0 : 1);
}

main();
