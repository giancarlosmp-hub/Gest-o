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

// Raciocínio que alguns modelos escrevem no próprio content. Bloco aberto sem fechamento é só raciocínio
// (resposta cortada): sai até o fim. Fechamento sem abertura: sai tudo antes dele.
const stripReasoningBlocks = (value: string) => {
  let text = value.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const orphanClose = text.toLowerCase().lastIndexOf("</think>");
  if (orphanClose >= 0) text = text.slice(orphanClose + "</think>".length);
  const unclosedOpen = text.toLowerCase().indexOf("<think>");
  if (unclosedOpen >= 0) text = text.slice(0, unclosedOpen);
  return text.trim();
};

const looksLikeJson = (value: string) => /^[\[{]/.test(value.trim());

const hasBracePair = (value: string) => {
  const firstBrace = value.indexOf("{");
  return firstBrace >= 0 && value.lastIndexOf("}") > firstBrace;
};

const tryParseJson = (value: string): { value: unknown } | null => {
  try {
    return { value: JSON.parse(value) as unknown };
  } catch {
    return null;
  }
};

// Primeiro objeto JSON válido no texto: fecha as chaves respeitando strings e tenta cada "{" em ordem.
const extractFirstJsonObject = (value: string): { value: unknown } | null => {
  for (let start = value.indexOf("{"); start >= 0; start = value.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseJson(value.slice(start, index + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }
  return null;
};

export const parseAiJsonObject = (content: string): { parsed: unknown; mode: Exclude<AiTextResponseParseMode, "plain_text"> } | null => {
  const trimmed = stripReasoningBlocks(content);
  if (!trimmed) return null;
  const withoutFence = stripMarkdownFence(trimmed);
  const fenced = withoutFence !== trimmed;

  const direct = tryParseJson(withoutFence);
  if (direct) return { parsed: direct.value, mode: fenced ? "fenced_json" : "direct_json" };

  // Cerca ```json no meio do texto.
  const innerFence = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  const fencedJson = innerFence ? tryParseJson(innerFence[1].trim()) : null;
  if (fencedJson) return { parsed: fencedJson.value, mode: "fenced_json" };

  const embedded = extractFirstJsonObject(withoutFence);
  return embedded ? { parsed: embedded.value, mode: "embedded_json" } : null;
};

export const parseAiTextResponse = (content: string, fieldName = "message"): AiTextResponseParseResult | null => {
  const trimmed = stripReasoningBlocks(content);
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
  if (looksLikeJson(withoutFence) || withoutFence.includes("```") || hasBracePair(withoutFence)) return null;
  return { text: withoutFence, mode: "plain_text" };
};
