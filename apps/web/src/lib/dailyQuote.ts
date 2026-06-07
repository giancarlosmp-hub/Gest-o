import motivationalQuotes from "../data/motivationalQuotes.json";

export type MotivationalQuote = {
  text: string;
  author: string;
  category: string;
};

export const DAILY_QUOTE_INDEX_KEY = "central-do-dia-daily-quote-index";
export const LAST_DAILY_QUOTE_INDEX_KEY =
  "central-do-dia-last-daily-quote-index";

const LEGACY_DAILY_QUOTE_KEY_PREFIX = "central-do-dia-motivational-quote:";
const motivationalQuotesList = motivationalQuotes as MotivationalQuote[];

const fallbackQuote: MotivationalQuote = motivationalQuotesList[0] ?? {
  text: "Resultados consistentes começam com prioridades claras logo cedo.",
  author: "Demetra Agro Performance",
  category: "prioridade",
};

function getStorageIndex(key: string) {
  if (typeof window === "undefined") return null;

  const storedValue = window.sessionStorage.getItem(key);
  if (storedValue === null) return null;

  const storedIndex = Number(storedValue);
  if (
    Number.isInteger(storedIndex) &&
    storedIndex >= 0 &&
    storedIndex < motivationalQuotesList.length
  ) {
    return storedIndex;
  }

  return null;
}

function getRandomQuoteIndex(excludedIndex: number | null = null) {
  if (motivationalQuotesList.length <= 1) return 0;

  let selectedIndex = Math.floor(Math.random() * motivationalQuotesList.length);
  if (selectedIndex === excludedIndex) {
    selectedIndex =
      (selectedIndex +
        1 +
        Math.floor(Math.random() * (motivationalQuotesList.length - 1))) %
      motivationalQuotesList.length;
  }

  return selectedIndex;
}

export function clearCurrentDailyQuoteIndex() {
  if (typeof window === "undefined") return;

  window.sessionStorage.removeItem(DAILY_QUOTE_INDEX_KEY);
  Object.keys(window.sessionStorage)
    .filter((key) => key.startsWith(LEGACY_DAILY_QUOTE_KEY_PREFIX))
    .forEach((key) => window.sessionStorage.removeItem(key));
}

export function selectNewDailyQuoteForLogin() {
  if (typeof window === "undefined" || motivationalQuotesList.length === 0)
    return fallbackQuote;

  clearCurrentDailyQuoteIndex();
  const lastIndex = getStorageIndex(LAST_DAILY_QUOTE_INDEX_KEY);
  const selectedIndex = getRandomQuoteIndex(lastIndex);

  window.sessionStorage.setItem(DAILY_QUOTE_INDEX_KEY, String(selectedIndex));
  window.sessionStorage.setItem(
    LAST_DAILY_QUOTE_INDEX_KEY,
    String(selectedIndex),
  );

  return motivationalQuotesList[selectedIndex] ?? fallbackQuote;
}

export function getSessionMotivationalQuote() {
  if (typeof window === "undefined" || motivationalQuotesList.length === 0)
    return fallbackQuote;

  const storedIndex = getStorageIndex(DAILY_QUOTE_INDEX_KEY);
  if (storedIndex !== null)
    return motivationalQuotesList[storedIndex] ?? fallbackQuote;

  const selectedIndex = getRandomQuoteIndex(
    getStorageIndex(LAST_DAILY_QUOTE_INDEX_KEY),
  );
  window.sessionStorage.setItem(DAILY_QUOTE_INDEX_KEY, String(selectedIndex));
  window.sessionStorage.setItem(
    LAST_DAILY_QUOTE_INDEX_KEY,
    String(selectedIndex),
  );

  return motivationalQuotesList[selectedIndex] ?? fallbackQuote;
}
