// Engine: canonical value = scope target token (lowercase); display = proper
// product name. Locale-independent proper nouns (like the geography Intl path),
// so a static map rather than an i18n key. Mirrors result-adapter's TARGET_LABEL.
// A plain module (2026-10-31), so server components can read it too: the filter panel re-exports it.
export const ENGINE_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  claude: "Claude",
  "claude-web": "Claude",
  "claude-sonnet": "Claude",
  "claude-opus": "Claude",
};
