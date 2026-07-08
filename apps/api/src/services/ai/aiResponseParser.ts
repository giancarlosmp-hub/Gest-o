export type AiTextResponseParseMode = "plain_text" | "direct_json" | "fenced_json" | "embedded_json";

export type AiTextResponseParseResult = {
  text: string;
  mode: AiTextResponseParseMode;
};

const stripMarkdownFence = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : trimmed;
};

const looksLikeJson = (value: string) => /^[\[{]/.test(value.trim());

const extractFirstJsonObject = (value: string) => {
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  return value.slice(firstBrace, lastBrace + 1);
};

export const parseAiJsonObject = (content: string): { parsed: unknown; mode: Exclude<AiTextResponseParseMode, "plain_text"> } | null => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const withoutFence = stripMarkdownFence(trimmed);
  const fenced = withoutFence !== trimmed;

  try {
    return { parsed: JSON.parse(withoutFence) as unknown, mode: fenced ? "fenced_json" : "direct_json" };
  } catch {
    const embedded = extractFirstJsonObject(withoutFence);
    if (!embedded) return null;
    try {
      return { parsed: JSON.parse(embedded) as unknown, mode: "embedded_json" };
    } catch {
      return null;
    }
  }
};

export const parseAiTextResponse = (content: string, fieldName = "message"): AiTextResponseParseResult | null => {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const json = parseAiJsonObject(trimmed);
  if (json) {
    if (!json.parsed || typeof json.parsed !== "object") return null;
    const value = (json.parsed as Record<string, unknown>)[fieldName];
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text ? { text, mode: json.mode } : null;
  }

  const withoutFence = stripMarkdownFence(trimmed);
  if (looksLikeJson(withoutFence) || withoutFence.includes("```") || extractFirstJsonObject(withoutFence)) return null;
  return { text: withoutFence, mode: "plain_text" };
};
