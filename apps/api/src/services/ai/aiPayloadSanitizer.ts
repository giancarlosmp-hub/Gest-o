import { randomUUID } from "node:crypto";
import type { AiChatRequest } from "./aiProvider.js";

// Filtro central do que vai para o provedor de IA externo (decisão de 18/10/2026): do cliente, só nome e
// cidade/UF, a situação da carteira, a data da última compra e textos operacionais. Nunca documento (CPF/CNPJ,
// IE, RG), telefone, celular, e-mail, endereço nem valores de títulos e crédito.
// Roda em toda chamada do AiService sobre o texto final: objetos JSON embutidos perdem os campos de nome
// proibido e os padrões são mascarados em qualquer texto livre. Um campo novo no contexto passa pelo mesmo filtro.
// Exceção (decisão de 20/10/2026): o trecho da Base de Conhecimento traz conteúdo técnico (registro MAPA/RNC, lote,
// EAN, linhas de crédito rural, rodovias) e passa só pelo filtro leve: CPF/CNPJ formatados, e-mail e telefone.

const normalizeKey = (key: string) => key.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

const FORBIDDEN_NORMALIZED_KEY_PATTERNS = [
  // Documentos.
  /cpf|cnpj|document|inscricao|inscest|stateregistration|identidade|nascimento|birth/,
  /^(rg|ie|numrg|numie|rgnumber|ienumber)$/,
  // Contato.
  /phone|fone|telefone|celular|mobile|whatsapp|email|mail$/,
  // Endereço.
  /endereco|address|logradouro|street|^rua$|bairro|neighborhood|district|complemento|complement|^cep$|cep$|zipcode|postalcode/,
  // Títulos, crédito e faturamento do ERP.
  /titulos|titles|credit|credito|limite|financial|financeiro|saldo|debito|divida|inadimpl|lastpurchasevalue|valorultimacompra|ultimafatura/
];
// RG e IE em camelCase ou com separador: clientRg, rgCliente, NUM_RG, ie_cliente.
const FORBIDDEN_RAW_KEY_PATTERN = /(^|[_-])(rg|ie)([_-]|$)|^(rg|ie)[A-Z]|[a-z](Rg|RG|Ie|IE)$/;

export const isForbiddenAiKey = (key: string) => {
  const normalized = normalizeKey(key);
  return FORBIDDEN_RAW_KEY_PATTERN.test(key) || FORBIDDEN_NORMALIZED_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
};

const DOCUMENT_MASK = "[documento removido]";
const PHONE_MASK = "[telefone removido]";
const EMAIL_MASK = "[e-mail removido]";
const ADDRESS_MASK = "[endereço removido]";
const VALUE_MASK = "[valor removido]";
const NUMBER_MASK = "[número removido]";

// Ordem importa: e-mail e documentos antes dos telefones e da sequência longa de dígitos.
const TEXT_RULES: Array<[RegExp, string]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, EMAIL_MASK],
  [/\b(cpf|cnpj|rg|ie|inscri[cç][aã]o\s+estadual|insc\.?\s*est\.?)(\s*(?:n[º°o.]*)?\s*[:\-]?\s*)\d[\d.\/\-]{3,}[\dXx]?/gi, `$1$2${DOCUMENT_MASK}`],
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, DOCUMENT_MASK],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, DOCUMENT_MASK],
  [/\b\d{1,2}\.\d{3}\.\d{3}-?[\dXx]\b/g, DOCUMENT_MASK],
  [/\+?\b55\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, PHONE_MASK],
  [/\(\d{2}\)\s?9?\d{4}[-\s]?\d{4}\b/g, PHONE_MASK],
  [/\b\d{2}[\s.-]?9\d{4}[\s.-]?\d{4}\b/g, PHONE_MASK],
  [/\b\d{2}\s[2-5]\d{3}-\d{4}\b/g, PHONE_MASK],
  [/\b9\d{4}-\d{4}\b/g, PHONE_MASK],
  [/\b\d{10,14}\b/g, NUMBER_MASK],
  [/\bcep\s*:?\s*\d{5}-?\d{3}\b/gi, ADDRESS_MASK],
  [/\b\d{5}-\d{3}\b/g, ADDRESS_MASK],
  [/\bendere[cç]o\s*:\s*[^\n;".]{3,80}/gi, ADDRESS_MASK],
  [/\b(rua|r\.|avenida|av\.|travessa|tv\.|rodovia|rod\.|estrada|alameda|al\.|pra[cç]a)\s+[^,;\n"]{2,60}?(?:,\s*|\s+)(?:n[º°o]?\.?\s*)?\d{1,5}\b/gi, ADDRESS_MASK],
  [/\b(t[ií]tulos?|cr[eé]dito|limite|saldo|d[ií]vida|inadimpl\w*|em aberto|vencid[oa]s?)([^.\n"]{0,40}?)R\$\s?\d[\d.,]*/gi, `$1$2${VALUE_MASK}`],
  [/R\$\s?\d[\d.,]*(\s+(?:em|de)\s+(?:t[ií]tulos?|cr[eé]dito))/gi, `${VALUE_MASK}$1`],
  // O motivo do score usa overdueTitlesTotal (soma em R$) como quantidade: "Cliente com 1111.11 títulos vencidos".
  [/\b\d[\d.,]*(\s+t[ií]tulos?\b)/gi, `${VALUE_MASK}$1`]
];

// Filtro leve da Base de Conhecimento: só formatos inequívocos. Números longos, R$, rodovias e "títulos" ficam.
const KNOWLEDGE_TEXT_RULES: Array<[RegExp, string]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, EMAIL_MASK],
  [/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, DOCUMENT_MASK],
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, DOCUMENT_MASK],
  [/\+55\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, PHONE_MASK],
  [/\(\d{2}\)\s?9?\d{4}[-\s]?\d{4}\b/g, PHONE_MASK],
  [/\b\d{2}[\s.-](?:9\d{4}|[2-5]\d{3})[\s-]\d{4}\b/g, PHONE_MASK],
  [/\b9\d{4}-\d{4}\b/g, PHONE_MASK]
];

type TextMask = (text: string) => string;
const applyRules = (rules: Array<[RegExp, string]>, text: string) => rules.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);

export const maskAiText: TextMask = (text) => applyRules(TEXT_RULES, text);
export const maskKnowledgeText: TextMask = (text) => applyRules(KNOWLEDGE_TEXT_RULES, text);

export const sanitizeAiValue = (value: unknown, mask: TextMask = maskAiText): unknown => {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeAiValue(item, mask));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !isForbiddenAiKey(key))
        .map(([key, nested]) => [key, sanitizeAiValue(nested, mask)])
    );
  }
  return value;
};

// Fim do objeto/array JSON que começa em `start`, respeitando strings; -1 quando não fecha.
const findJsonEnd = (text: string, start: number) => {
  const stack: string[] = [];
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
};

const sanitizeEmbeddedJson = (text: string, mask: TextMask) => {
  let output = "";
  let cursor = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "{" && char !== "[") continue;
    const end = findJsonEnd(text, index);
    if (end === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(index, end + 1));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    output += text.slice(cursor, index) + JSON.stringify(sanitizeAiValue(parsed, mask));
    cursor = end + 1;
    index = end;
  }
  return output + text.slice(cursor);
};

// JSON que não fecha (truncado): o valor do par "chave": valor de nome proibido vira "[removido]".
const JSON_PAIR_PATTERN = /"((?:[^"\\]|\\.){1,80})"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)/g;
const maskForbiddenJsonPairs = (text: string) =>
  text.replace(JSON_PAIR_PATTERN, (match, key: string, separator: string) => (isForbiddenAiKey(key) ? `"${key}"${separator}"[removido]"` : match));

const sanitizeSegment = (text: string, mask: TextMask) => mask(maskForbiddenJsonPairs(sanitizeEmbeddedJson(text, mask)));

// Marcação estrutural do trecho da Base de Conhecimento, feita por resolveKnowledgeContextForAi antes de o trecho
// entrar na mensagem. O token é aleatório por processo e os delimitadores nunca chegam ao provedor, então um texto
// de cliente não consegue abrir nem fechar o trecho. Trecho sem fechamento (cortado) volta ao filtro completo.
const KNOWLEDGE_TOKEN = randomUUID();
const KNOWLEDGE_START = `[[base-conhecimento:${KNOWLEDGE_TOKEN}]]`;
const KNOWLEDGE_END = `[[/base-conhecimento:${KNOWLEDGE_TOKEN}]]`;
const stripKnowledgeMarkers = (text: string) => text.split(KNOWLEDGE_START).join("").split(KNOWLEDGE_END).join("");

export const markKnowledgeContextForAi = (text: string) => (text ? `${KNOWLEDGE_START}${text}${KNOWLEDGE_END}` : text);

export const sanitizeAiText = (text: string) => {
  let output = "";
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(KNOWLEDGE_START, cursor);
    const end = start === -1 ? -1 : text.indexOf(KNOWLEDGE_END, start + KNOWLEDGE_START.length);
    if (end === -1) break;
    output += sanitizeSegment(stripKnowledgeMarkers(text.slice(cursor, start)), maskAiText);
    output += sanitizeSegment(stripKnowledgeMarkers(text.slice(start + KNOWLEDGE_START.length, end)), maskKnowledgeText);
    cursor = end + KNOWLEDGE_END.length;
  }
  return output + sanitizeSegment(stripKnowledgeMarkers(text.slice(cursor)), maskAiText);
};

export const sanitizeAiPayload = <T extends AiChatRequest>(request: T): T => ({
  ...request,
  ...(request.system !== undefined ? { system: sanitizeAiText(request.system) } : {}),
  messages: request.messages.map((message) => ({ ...message, content: sanitizeAiText(message.content) }))
});
