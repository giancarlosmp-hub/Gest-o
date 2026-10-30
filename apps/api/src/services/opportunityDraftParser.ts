import { shiftDayKey } from "../utils/dateRange.js";
import { statesWithMunicipalityNamed } from "./brazilMunicipalities.js";

// Leitura da frase ditada para o rascunho de oportunidade (Assistente Comercial), só com regras fixas e sem banco.
// Ordem livre; palavras-chave: cliente, cidade, etapa, tabela, produto, preço, valor, observação. Quilos/kg e sacas
// ficam dentro do trecho do produto. Tudo depois de "observação" é texto livre (notas da oportunidade).
// Ditado do teclado: números por extenso junto de sacas/quilos/reais (e "sem sacas" = "cem sacas"), etapa sem a palavra
// "etapa" e cliente sem a palavra "cliente" (o nome no começo da frase, com a cidade se for um município do IBGE).

export type DraftStage = "prospeccao" | "negociacao" | "proposta";
export type RefusedStage = "ganho" | "perdido";
export type DraftPriceTable = "1" | "2";
export type SpokenPrice = { mode: "registered" } | { mode: "informed"; amount: number };
export type SpokenItem = { spokenName: string; words: string[]; kg: number | null; quantity: number | null; price: SpokenPrice };
export type ObservationDate = { kind: "date"; date: string } | { kind: "past"; date: string };

export type ParsedDraftText = {
  clientName: string | null;
  clientCity: string | null;
  // Cidade tirada do fim do nome dito no começo da frase (sem "cliente"/"cidade"): pode ser parte do nome do cliente.
  clientCityInferred: boolean;
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
  [/\b(propostas?|orcamentos?|cotac\w*)\b/, "proposta"]
];

// Etapa dita em qualquer posição (sem a palavra "etapa"). Ganho e perdido só depois de "etapa".
const STAGE_ANYWHERE_PATTERNS: Array<[RegExp, DraftStage]> = [
  [/\b(?:prospec\w*|prospect\w*)\b/, "prospeccao"],
  [/\b(?:negocia\w*)\b/, "negociacao"],
  [/\b(?:propostas?|orcamentos?|cotac\w*)\b/, "proposta"]
];
const STAGE_WORDS_PATTERN = /\b(?:(?:em|na|fase)\s+)?(?:prospec\w*|prospect\w*|negocia\w*|propostas?|orcamentos?|cotac\w*)\b/;

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

// Números por extenso do ditado ("cem sacas", "dez quilos", "noventa reais", "cento e vinte"). Só viram dígitos junto
// de uma unidade (depois) ou de "preço"/"valor" (antes), para não mexer em nomes como "Dois Irmãos". "sem" logo antes
// de sacas/sacos é "cem" mal reconhecido.
const NUMBER_WORDS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90,
  cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300, quatrocentos: 400, quatrocentas: 400,
  quinhentos: 500, quinhentas: 500, seiscentos: 600, seiscentas: 600, setecentos: 700, setecentas: 700,
  oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900, mil: 1000
};
const NUMBER_UNIT_WORDS = /^(?:sacas?|sacos?|sc|kg|kgs|quilos?|kilos?|quilogramas?|reais|real)$/;
const NUMBER_LEAD_WORDS = /^(?:preco|valor)$/;
const isNumberWord = (word: string) => Object.prototype.hasOwnProperty.call(NUMBER_WORDS, word);

const numberRunValue = (words: string[]) => {
  let total = 0;
  let current = 0;
  for (const word of words) {
    if (word === "e") continue;
    if (word === "mil") {
      total += (current || 1) * 1000;
      current = 0;
    } else {
      current += NUMBER_WORDS[word];
    }
  }
  return total + current;
};

export const spokenNumbersToDigits = (text: string) => {
  const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({ start: match.index!, end: match.index! + match[0].length, word: foldText(match[0]) }));
  const wordAt = (position: number) => tokens[position]?.word ?? "";
  const replacements: Array<{ start: number; end: number; value: number }> = [];
  let index = 0;
  while (index < tokens.length) {
    if (wordAt(index) === "sem" && /^sac[oa]s?$/.test(wordAt(index + 1))) {
      replacements.push({ start: tokens[index].start, end: tokens[index].end, value: 100 });
      index += 1;
      continue;
    }
    if (!isNumberWord(wordAt(index))) {
      index += 1;
      continue;
    }
    let end = index;
    while (isNumberWord(wordAt(end + 1)) || (wordAt(end + 1) === "e" && isNumberWord(wordAt(end + 2)))) end += 1;
    const before = wordAt(index - 1) === "de" ? wordAt(index - 2) : wordAt(index - 1);
    if (NUMBER_UNIT_WORDS.test(wordAt(end + 1)) || NUMBER_LEAD_WORDS.test(before)) {
      replacements.push({ start: tokens[index].start, end: tokens[end].end, value: numberRunValue(tokens.slice(index, end + 1).map((token) => token.word)) });
    }
    index = end + 1;
  }
  return replacements.reduceRight((result, item) => result.slice(0, item.start) + String(item.value) + result.slice(item.end), text);
};

// Troca por espaços o que o padrão acha no texto dobrado (os índices valem no original, ver foldChar).
const blankPattern = (original: string, pattern: RegExp) => {
  let result = original;
  for (const match of foldText(original).matchAll(new RegExp(pattern.source, "g"))) {
    result = result.slice(0, match.index!) + " ".repeat(match[0].length) + result.slice(match.index! + match[0].length);
  }
  return result;
};
const withoutStageWords = (original: string) => blankPattern(original, STAGE_WORDS_PATTERN);

const isMunicipalityName = (text: string) => statesWithMunicipalityNamed(text).length > 0;

const cleanSegment = (text: string) => text.replace(/^[\s:,.;-]+/, "").replace(/[\s:,.;-]+$/, "").trim();
const collapse = (text: string) => text.replace(/[\s,;.]+/g, " ").trim();
const collapseSpaces = (text: string) => text.replace(/\s+/g, " ").trim();
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
  const spokenName = collapse(withoutStageWords(remaining).replace(/^\s*sementes?\s+d[ae]\s+/i, ""));
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
  const main = spokenNumbersToDigits(observation ? text.slice(0, observation.index) : text);
  const notes = observation ? cleanSegment(text.slice(observation.index + observation[0].length)) || null : null;
  const folded = foldText(main);

  const result: ParsedDraftText = {
    clientName: null,
    clientCity: null,
    clientCityInferred: false,
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
        const sentence = collapseSpaces(firstSentence(withoutStageWords(original)));
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

  // Etapa sem a palavra "etapa": a primeira prospecção/negociação/proposta dita em qualquer posição.
  if (!result.stage && !result.refusedStage) {
    const found = STAGE_ANYWHERE_PATTERNS
      .map(([pattern, stage]) => ({ stage, index: pattern.exec(folded)?.index ?? -1 }))
      .filter((item) => item.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    if (found) {
      result.stage = found.stage;
      result.stageUnrecognized = false;
    }
  }

  // Cliente sem a palavra "cliente": o nome dito no começo, antes da primeira palavra-chave (sem falar de dinheiro).
  // "Nome, Cidade" separa pela vírgula; sem vírgula, as últimas 1–3 palavras que forem um município do IBGE são a cidade.
  if (keywords.length && !keywords.some((match) => match[1] === "cliente") && !MONEY_HINT_PATTERN.test(leading)) {
    const opening = withoutStageWords(main.slice(0, keywords[0].index)).replace(/^\s*nova\s+oportunidade\b[\s.,:;-]*/i, "");
    const sentence = collapseSpaces(firstSentence(opening));
    const comma = sentence.lastIndexOf(",");
    const tail = comma >= 0 ? cleanSegment(sentence.slice(comma + 1)) : "";
    if (tail && tail.split(/\s+/).length <= 4) {
      result.clientName = cleanSegment(sentence.slice(0, comma)) || null;
      result.clientCity ??= tail;
    } else if (meaningfulWords(sentence).length) {
      const words = sentence.split(" ");
      if (isMunicipalityName(sentence)) {
        // Só a cidade: o cliente fica pendente.
        result.clientCity ??= sentence;
      } else {
        let size = Math.min(3, words.length - 1);
        while (size >= 1 && !isMunicipalityName(words.slice(-size).join(" "))) size -= 1;
        result.clientName = (size >= 1 ? words.slice(0, -size) : words).join(" ") || null;
        if (size >= 1 && !result.clientCity) {
          result.clientCity = words.slice(-size).join(" ");
          result.clientCityInferred = true;
        }
      }
    }
  }
  return result;
};
