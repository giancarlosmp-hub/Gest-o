import type { AiChatRequest } from "./aiProvider.js";

// Filtro central do que vai para o provedor de IA externo (decisão de 18/10/2026): do cliente, só nome e
// cidade/UF, a situação da carteira, a data da última compra e textos operacionais. Nunca documento (CPF/CNPJ,
// IE, RG), telefone, celular, e-mail, endereço nem valores de títulos e crédito.
// Roda em toda chamada do AiService sobre o texto final: objetos JSON embutidos perdem os campos de nome
// proibido e os padrões são mascarados em qualquer texto livre. Um campo novo no contexto passa pelo mesmo filtro.

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

export const maskAiText = (text: string) => TEXT_RULES.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);

export const sanitizeAiValue = (value: unknown): unknown => {
  if (typeof value === "string") return maskAiText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeAiValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !isForbiddenAiKey(key))
        .map(([key, nested]) => [key, sanitizeAiValue(nested)])
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

const sanitizeEmbeddedJson = (text: string) => {
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
    output += text.slice(cursor, index) + JSON.stringify(sanitizeAiValue(parsed));
    cursor = end + 1;
    index = end;
  }
  return output + text.slice(cursor);
};

// JSON que não fecha (truncado): o valor do par "chave": valor de nome proibido vira "[removido]".
const JSON_PAIR_PATTERN = /"((?:[^"\\]|\\.){1,80})"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)/g;
const maskForbiddenJsonPairs = (text: string) =>
  text.replace(JSON_PAIR_PATTERN, (match, key: string, separator: string) => (isForbiddenAiKey(key) ? `"${key}"${separator}"[removido]"` : match));

export const sanitizeAiText = (text: string) => maskAiText(maskForbiddenJsonPairs(sanitizeEmbeddedJson(text)));

export const sanitizeAiPayload = <T extends AiChatRequest>(request: T): T => ({
  ...request,
  ...(request.system !== undefined ? { system: sanitizeAiText(request.system) } : {}),
  messages: request.messages.map((message) => ({ ...message, content: sanitizeAiText(message.content) }))
});
