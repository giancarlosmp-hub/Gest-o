import { shiftDayKey } from "../utils/dateRange.js";

// Leitura da frase ditada para o rascunho de oportunidade (Assistente Comercial), só com regras fixas e sem banco.
// Ordem livre; palavras-chave: cliente, cidade, etapa, tabela, produto, preço, valor, observação. Quilos/kg e sacas
// ficam dentro do trecho do produto. Tudo depois de "observação" é texto livre (notas da oportunidade).

export type DraftStage = "prospeccao" | "negociacao" | "proposta";
export type RefusedStage = "ganho" | "perdido";
export type DraftPriceTable = "1" | "2";
export type SpokenPrice = { mode: "registered" } | { mode: "informed"; amount: number };
export type SpokenItem = { spokenName: string; words: string[]; kg: number | null; quantity: number | null; price: SpokenPrice };
export type ObservationDate = { kind: "date"; date: string } | { kind: "past"; date: string };

export type ParsedDraftText = {
  clientName: string | null;
  clientCity: string | null;
  stage: DraftStage | null;
  refusedStage: RefusedStage | null;
  stageUnrecognized: boolean;
  priceTable: DraftPriceTable | null;
  priceTableUnrecognized: boolean;
  items: SpokenItem[];
  value: number | null;
  // A frase fala de sacas, quilos ou dinheiro (mesmo sem produto ou valor lidos pelas regras): sinal de frase fora do padrão.
  productOrValueHint: boolean;
  notes: string | null;
  observationDate: ObservationDate | null;
  observationHasDateHint: boolean;
};

// Um caractere por caractere (sem acento, minúsculo), para os índices do texto dobrado valerem no original.
const foldChar = (char: string) => (char.normalize("NFD")[0] ?? char).toLowerCase()[0] ?? char;
export const foldText = (text: string) => text.split("").map(foldChar).join("");
export const wordsOf = (text: string): string[] => foldText(text).match(/[a-z0-9]+/g) ?? [];

const STOP_WORDS = new Set(["de", "da", "do", "das", "dos", "e", "em", "a", "o", "as", "os", "na", "no", "nas", "nos", "com", "para", "um", "uma", "ltda", "me", "sa"]);
export const meaningfulWords = (text: string) => wordsOf(text).filter((word) => word.length >= 2 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));

const KEYWORD_PATTERN = /\b(cliente|cidade|etapa|(?<!\b(?:preco|valor)\s(?:d[ae]\s)?)tabela|produtos?|preco|valor)\b/g;
const OBSERVATION_PATTERN = /\b(observacao|observacoes|obs)\b/;

const STAGE_PATTERNS: Array<[RegExp, DraftStage | RefusedStage]> = [
  [/\b(ganh[oa]s?|ganhamos|fechad[oa]s?|vendid[oa]s?)\b/, "ganho"],
  [/\b(perdid[oa]s?|perdemos)\b/, "perdido"],
  [/\b(prospec\w*|prospect\w*)\b/, "prospeccao"],
  [/\b(negocia\w*)\b/, "negociacao"],
  [/\b(propostas?|orcamento)\b/, "proposta"]
];

const KG_PATTERN = /(\d+(?:[.,]\d+)?)\s*(?:kg|kgs|quilos?|kilos?|quilogramas?)\b/;
const QUANTITY_PATTERN = /(\d+(?:[.,]\d+)?)\s*(?:sacas?|sacos?|sc)\b/;
const REGISTERED_PRICE_PATTERN = /\b(cadastrad[oa]|tabela|normal|lista)\b/;
const MONEY_PATTERN = /(?:r\s?\$\s*)?(\d[\d.,]*)\s*(mil\b|k\b)?/;
const MONEY_HINT_PATTERN = /r\s?\$|\breais\b|\bmil\b/;

// "1.500,50", "130", "130.5", "50.000": vírgula é decimal; ponto seguido de 3 dígitos é milhar.
export const parseSpokenNumber = (raw: string) => {
  let value = raw.replace(/[.,]+$/, "");
  if (value.includes(",")) value = value.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{3}(\.|$)/.test(value)) value = value.replace(/\./g, "");
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseMoney = (folded: string) => {
  const match = MONEY_PATTERN.exec(folded);
  if (!match) return null;
  const amount = parseSpokenNumber(match[1]);
  if (amount === null) return null;
  return Number((match[2] ? amount * 1000 : amount).toFixed(2));
};

const cleanSegment = (text: string) => text.replace(/^[\s:,.;-]+/, "").replace(/[\s:,.;-]+$/, "").trim();
const collapse = (text: string) => text.replace(/[\s,;.]+/g, " ").trim();
const firstSentence = (text: string) => cleanSegment(text.split(/[.;!?](?:\s|$)/)[0]);

const parseStage = (folded: string): DraftStage | RefusedStage | null => {
  for (const [pattern, stage] of STAGE_PATTERNS) if (pattern.test(folded)) return stage;
  return null;
};

const parsePriceTable = (folded: string): DraftPriceTable | null => {
  if (/\b(2|dois|duas|consumidor)\b/.test(folded)) return "2";
  if (/\b(1|um|uma|revenda|cooperativa)\b/.test(folded)) return "1";
  return null;
};

const parsePrice = (folded: string): SpokenPrice | null => {
  if (REGISTERED_PRICE_PATTERN.test(folded)) return { mode: "registered" };
  const amount = parseMoney(folded);
  return amount === null ? null : { mode: "informed", amount };
};

// Trecho do produto: tira quilos, sacas e preço; o que sobra é o nome falado (espécie/cultivar, marca etc.).
const parseItem = (original: string): SpokenItem => {
  let folded = foldText(original);
  let remaining = original;
  const blank = (match: RegExpExecArray) => {
    const filler = " ".repeat(match[0].length);
    folded = folded.slice(0, match.index) + filler + folded.slice(match.index + match[0].length);
    remaining = remaining.slice(0, match.index) + filler + remaining.slice(match.index + match[0].length);
  };
  const kgMatch = KG_PATTERN.exec(folded);
  if (kgMatch) blank(kgMatch);
  const quantityMatch = QUANTITY_PATTERN.exec(folded);
  if (quantityMatch) blank(quantityMatch);
  let price: SpokenPrice = { mode: "registered" };
  const priceMatch = /\bpreco\b.*$/.exec(folded) ?? /r\s?\$\s*\d[\d.,]*\s*(?:mil\b)?/.exec(folded);
  if (priceMatch) {
    price = parsePrice(priceMatch[0]) ?? price;
    blank(priceMatch);
  }
  const spokenName = collapse(remaining.replace(/^\s*sementes?\s+d[ae]\s+/i, ""));
  return {
    spokenName,
    words: meaningfulWords(spokenName),
    kg: kgMatch ? parseSpokenNumber(kgMatch[1]) : null,
    quantity: quantityMatch ? parseSpokenNumber(quantityMatch[1]) : null,
    price
  };
};

const WEEKDAYS: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const MONTHS: Record<string, number> = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
const DATE_HINT_PATTERN = new RegExp(`\\b(dia|dias|semana|mes|proxim[oa]|depois|amanha|hoje|feira|${Object.keys(WEEKDAYS).join("|")}|${Object.keys(MONTHS).join("|")})\\b|\\d`);

const weekdayOf = (dayKey: string) => new Date(`${dayKey}T00:00:00.000Z`).getUTCDay();
const validDayKey = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
};
const explicitDate = (dayKey: string | null, today: string): ObservationDate | null => {
  if (!dayKey) return null;
  return dayKey < today ? { kind: "past", date: dayKey } : { kind: "date", date: dayKey };
};

// Data citada na observação ("me ligue sexta", "dia 5", "10/11", "amanhã"). Dia da semana é sempre o próximo depois
// de hoje ("sexta" dita numa sexta = sexta seguinte); "dia N" sem mês é o próximo dia N a partir de hoje. Data com mês
// explícito sem ano fica no ano corrente; se já passou, volta como "past" (ignorada com aviso).
export const parseObservationDate = (notes: string, today: string): ObservationDate | null => {
  const folded = foldText(notes);
  const [year, month, day] = today.split("-").map(Number);
  if (/\bdepois de amanha\b/.test(folded)) return { kind: "date", date: shiftDayKey(today, 2) };
  if (/\bamanha\b/.test(folded)) return { kind: "date", date: shiftDayKey(today, 1) };
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(folded);
  if (slash) {
    const spokenYear = slash[3] ? Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]) : year;
    return explicitDate(validDayKey(spokenYear, Number(slash[2]), Number(slash[1])), today);
  }
  const withMonth = new RegExp(`\\bdia (\\d{1,2}) de (${Object.keys(MONTHS).join("|")})(?: de (\\d{4}))?\\b`).exec(folded);
  if (withMonth) return explicitDate(validDayKey(withMonth[3] ? Number(withMonth[3]) : year, MONTHS[withMonth[2]], Number(withMonth[1])), today);
  const weekday = new RegExp(`\\b(${Object.keys(WEEKDAYS).join("|")})\\b`).exec(folded);
  if (weekday) {
    const ahead = ((WEEKDAYS[weekday[1]] - weekdayOf(today) + 7) % 7) || 7;
    return { kind: "date", date: shiftDayKey(today, ahead) };
  }
  const dayOnly = /\bdia (\d{1,2})\b/.exec(folded);
  if (dayOnly) {
    const spokenDay = Number(dayOnly[1]);
    for (let offset = 0; offset < 13; offset += 1) {
      const monthIndex = month - 1 + offset;
      const candidate = validDayKey(year + Math.floor(monthIndex / 12), (monthIndex % 12) + 1, spokenDay);
      if (candidate && (offset > 0 || spokenDay >= day)) return { kind: "date", date: candidate };
    }
    return null;
  }
  if (/\bhoje\b/.test(folded)) return { kind: "date", date: today };
  return null;
};

export const observationHasDateHint = (notes: string) => DATE_HINT_PATTERN.test(foldText(notes));

// Retorno padrão: hoje + 3 dias; sábado ou domingo vai para a segunda.
export const defaultFollowUpDate = (today: string) => {
  const date = shiftDayKey(today, 3);
  const weekday = weekdayOf(date);
  return weekday === 6 ? shiftDayKey(date, 2) : weekday === 0 ? shiftDayKey(date, 1) : date;
};

export const parseDraftText = (text: string, today: string): ParsedDraftText => {
  const observation = OBSERVATION_PATTERN.exec(foldText(text));
  const main = observation ? text.slice(0, observation.index) : text;
  const notes = observation ? cleanSegment(text.slice(observation.index + observation[0].length)) || null : null;
  const folded = foldText(main);

  const result: ParsedDraftText = {
    clientName: null,
    clientCity: null,
    stage: null,
    refusedStage: null,
    stageUnrecognized: false,
    priceTable: null,
    priceTableUnrecognized: false,
    items: [],
    value: null,
    productOrValueHint: /\b(sacas?|sacos?|kg|quilos?|kilos?|reais|mil)\b|r\s?\$/.test(folded),
    notes,
    observationDate: notes ? parseObservationDate(notes, today) : null,
    observationHasDateHint: notes ? observationHasDateHint(notes) : false
  };

  const keywords = [...folded.matchAll(KEYWORD_PATTERN)];
  const leading = folded.slice(0, keywords[0]?.index ?? folded.length);
  if (MONEY_HINT_PATTERN.test(leading)) result.value = parseMoney(leading);

  let currentItem: SpokenItem | null = null;
  keywords.forEach((match, index) => {
    const start = match.index! + match[0].length;
    const end = keywords[index + 1]?.index ?? main.length;
    const original = cleanSegment(main.slice(start, end));
    const segment = foldText(original);
    switch (match[1]) {
      case "cliente": {
        // Nome e cidade terminam no fim da sentença. "Agro X, Cidade Y": o que vem depois da última vírgula é a cidade
        // (curta), se a cidade não foi dita à parte.
        const sentence = firstSentence(original);
        const comma = sentence.lastIndexOf(",");
        const tail = comma >= 0 ? cleanSegment(sentence.slice(comma + 1)) : "";
        if (tail && tail.split(/\s+/).length <= 4) {
          result.clientName = cleanSegment(sentence.slice(0, comma)) || null;
          result.clientCity ??= tail;
        } else {
          result.clientName = sentence || null;
        }
        break;
      }
      case "cidade":
        result.clientCity = cleanSegment(firstSentence(original).replace(/^d[ae]\s+/i, "")) || result.clientCity;
        break;
      case "etapa": {
        const stage = parseStage(segment);
        if (stage === "ganho" || stage === "perdido") result.refusedStage = stage;
        else if (stage) result.stage = stage;
        else result.stageUnrecognized = true;
        break;
      }
      case "tabela": {
        const table = parsePriceTable(segment);
        if (table) result.priceTable = table;
        else result.priceTableUnrecognized = true;
        break;
      }
      case "produto":
      case "produtos":
        currentItem = parseItem(original);
        result.items.push(currentItem);
        break;
      case "preco":
        if (currentItem) {
          currentItem.price = parsePrice(segment) ?? currentItem.price;
          // Sacas e quilos ditos depois do preço ainda são do mesmo produto.
          const quantity = QUANTITY_PATTERN.exec(segment);
          if (quantity && currentItem.quantity === null) currentItem.quantity = parseSpokenNumber(quantity[1]);
          const kg = KG_PATTERN.exec(segment);
          if (kg && currentItem.kg === null) currentItem.kg = parseSpokenNumber(kg[1]);
        } else {
          result.value = parseMoney(segment) ?? result.value;
        }
        break;
      case "valor":
        result.value = parseMoney(segment) ?? result.value;
        break;
    }
  });
  return result;
};
