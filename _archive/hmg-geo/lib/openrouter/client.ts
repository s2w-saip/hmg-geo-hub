import "server-only";

/**
 * OpenRouter chat client — server-only.
 * Ported from aeorank (lib/openrouter-client.ts), trimmed to what hmg-geo needs:
 * the cost-logging hooks (@/lib/llm-cost-logger, @/lib/cost-calculation) are
 * dropped — they don't exist here and are optional. Retry/backoff, structured
 * (json_schema) output, and the truncated-JSON repair fallback are kept intact.
 *
 * The OpenRouter key is server-only (never NEXT_PUBLIC_); this module imports
 * "server-only" so a client bundle that pulls it in fails the build loudly.
 */

const DEFAULT_OPENROUTER_API_URL =
  "https://openrouter.ai/api/v1/chat/completions";

// Base URL is env-overridable (OPENROUTER_BASE_URL, e.g. a customer-specific
// OpenAI-compatible gateway) so the provider can be swapped without code
// changes — the model is already OPENROUTER_MODEL, the key OPENROUTER_API_KEY.
// A non-OpenAI-compatible customer API would need its own adapter, not just
// this URL (the request/response shape below assumes the OpenAI schema).
function apiUrl(): string {
  const base = process.env.OPENROUTER_BASE_URL;
  return base
    ? `${base.replace(/\/+$/, "")}/chat/completions`
    : DEFAULT_OPENROUTER_API_URL;
}

// Default model for keyword→prompt + prompt→keyword extraction. Overridable via
// OPENROUTER_MODEL. aeorank used a Gemini Flash tier; 2.5-flash is the current,
// cheap, multilingual, structured-output-capable equivalent.
export const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash";

export function defaultModel(): string {
  return process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
}

/**
 * Resolve a short name to an OpenRouter model id:
 *  - already contains "/" → use as-is (e.g. "openai/gpt-4o-mini").
 *  - bare "gemini-…" / "gemma-…" → prefix "google/".
 *  - otherwise → pass through unchanged.
 */
function resolveModel(model: string): string {
  if (model.includes("/")) return model;
  if (model.startsWith("gemini-") || model.startsWith("gemma-")) {
    return `google/${model}`;
  }
  return model;
}

export interface OpenRouterGenerateOptions {
  model?: string;
  systemInstruction?: string;
  temperature?: number;
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface OpenRouterResponse<T = string> {
  data: T;
  raw: unknown;
  usage?: {
    promptTokens?: number;
    candidatesTokens?: number;
    totalTokens?: number;
  };
}

type OpenRouterMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

function isRateLimitError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return (
    status === 429 ||
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("too many requests")
  );
}

function isRetryableError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === "PARSE_ERROR" ||
    status === "ETIMEDOUT" ||
    message.includes("parse failed") ||
    message.includes("unavailable") ||
    message.includes("internal") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("timed out") ||
    message.includes("socket hang up")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOnce<T>(
  messages: OpenRouterMessage[],
  modelName: string,
  options: {
    systemInstruction?: string;
    temperature?: number;
    maxOutputTokens?: number;
    responseSchema?: Record<string, unknown>;
  },
): Promise<OpenRouterResponse<T>> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const resolvedModel = resolveModel(modelName);

  const fullMessages: OpenRouterMessage[] = options.systemInstruction
    ? [{ role: "system", content: options.systemInstruction }, ...messages]
    : messages;

  const body: Record<string, unknown> = {
    model: resolvedModel,
    messages: fullMessages,
    temperature: options.temperature ?? 1.0,
  };
  if (options.maxOutputTokens) body.max_tokens = options.maxOutputTokens;
  if (options.responseSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "output", strict: true, schema: options.responseSchema },
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180_000); // 3 min

  let response: Response;
  try {
    response = await fetch(apiUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Optional attribution headers OpenRouter recommends.
        "X-Title": "hmg-geo keyword-tools",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw Object.assign(new Error("OpenRouter request timed out (180s)"), {
        status: "ETIMEDOUT",
      });
    }
    throw error;
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw Object.assign(
      new Error(`OpenRouter ${response.status}: ${errorText.slice(0, 300)}`),
      { status: response.status },
    );
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const textContent = json.choices?.[0]?.message?.content ?? "";

  let data: unknown = textContent;
  if (options.responseSchema && textContent) {
    try {
      data = JSON.parse(textContent) as T;
    } catch {
      // Basic repair for truncated JSON (close dangling braces/brackets).
      try {
        let repaired = textContent;
        repaired = repaired.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"{}[\]]*$/g, "");
        repaired = repaired.replace(/,\s*\{[^}]*$/g, "");
        const opens = repaired.match(/[[{]/g) ?? [];
        const closes = repaired.match(/[\]}]/g) ?? [];
        const openBrackets =
          opens.filter((c) => c === "[").length -
          closes.filter((c) => c === "]").length;
        const openBraces =
          opens.filter((c) => c === "{").length -
          closes.filter((c) => c === "}").length;
        for (let i = 0; i < openBraces; i++) repaired += "}";
        for (let i = 0; i < openBrackets; i++) repaired += "]";
        data = JSON.parse(repaired) as T;
        console.warn("[OpenRouter] Repaired truncated JSON (some data may be missing)");
      } catch {
        throw Object.assign(
          new Error(`Structured output parse failed (model: ${resolvedModel})`),
          { status: "PARSE_ERROR" },
        );
      }
    }
  }

  return {
    data: data as T,
    raw: json,
    usage: {
      promptTokens: json.usage?.prompt_tokens,
      candidatesTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens,
    },
  };
}

const MAX_RETRIES = 3;

async function callWithRetry<T>(
  messages: OpenRouterMessage[],
  modelName: string,
  options: {
    systemInstruction?: string;
    temperature?: number;
    maxOutputTokens?: number;
    responseSchema?: Record<string, unknown>;
  },
): Promise<OpenRouterResponse<T>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(2000 * 2 ** (attempt - 1), 16000);
      await sleep(backoffMs);
    }
    try {
      return await callOnce<T>(messages, modelName, options);
    } catch (error) {
      lastError = error;
      if (isRateLimitError(error)) continue;
      if (isRetryableError(error) && attempt < MAX_RETRIES) continue;
      throw error;
    }
  }
  throw lastError;
}

/**
 * Single-shot completion. With `responseSchema`, the parsed JSON object is
 * returned in `.data`; without it, `.data` is the raw text.
 */
export async function callOpenRouter<T = string>(
  prompt: string,
  options: OpenRouterGenerateOptions = {},
): Promise<OpenRouterResponse<T>> {
  const {
    model = defaultModel(),
    systemInstruction,
    temperature,
    responseSchema,
    maxOutputTokens,
  } = options;

  return callWithRetry<T>([{ role: "user", content: prompt }], model, {
    systemInstruction,
    temperature,
    maxOutputTokens,
    responseSchema,
  });
}
