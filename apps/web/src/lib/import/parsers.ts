export type ImportParsedSheet = {
  headers: string[];
  rows: Record<string, unknown>[];
};

type SheetJsLibrary = {
  read: (data: ArrayBuffer, options: { type: string }) => any;
  writeFile: (workbook: any, fileName: string) => void;
  utils: {
    book_new: () => any;
    aoa_to_sheet: (data: Array<Array<string | number>>) => any;
    book_append_sheet: (workbook: any, worksheet: any, title: string) => void;
    sheet_to_json: <T>(sheet: any, options?: Record<string, unknown>) => T[];
  };
};

declare global {
  interface Window {
    XLSX?: SheetJsLibrary;
  }
}

export const normalizeHeader = (value: unknown) =>
  String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/[_\s]+/g, " ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^a-z0-9]/g, "");

export const normalizeTextValue = (value: unknown) => String(value ?? "").trim();

export const parseDecimalValue = (value: unknown): { parsedValue: number | undefined; isInvalid: boolean } => {
  if (value === null || value === undefined) return { parsedValue: undefined, isInvalid: false };
  if (typeof value === "number") {
    return Number.isFinite(value) ? { parsedValue: value, isInvalid: false } : { parsedValue: undefined, isInvalid: true };
  }

  const normalized = String(value).trim();
  if (!normalized) return { parsedValue: undefined, isInvalid: false };

  const sanitized = normalized
    .replace(/r\$/gi, "")
    .replace(/\s/g, "")
    .replace(/[^\d,.-]/g, "");
  const lastComma = sanitized.lastIndexOf(",");
  const lastDot = sanitized.lastIndexOf(".");

  let decimalSeparator = "";
  if (lastComma >= 0 && lastDot >= 0) decimalSeparator = lastComma > lastDot ? "," : ".";
  else if (lastComma >= 0) decimalSeparator = ",";
  else if (lastDot >= 0) decimalSeparator = ".";

  let numericText = sanitized;
  if (decimalSeparator) {
    const thousandsSeparator = decimalSeparator === "," ? /\./g : /,/g;
    numericText = numericText.replace(thousandsSeparator, "");
    if (decimalSeparator === ",") numericText = numericText.replace(/,/g, ".");
  }

  const parsedValue = Number(numericText);
  return Number.isNaN(parsedValue) ? { parsedValue: undefined, isInvalid: true } : { parsedValue, isInvalid: false };
};

const parseCsvLine = (line: string, separator: "," | ";") => {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === separator && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
};

const parseCsvFile = async (file: File): Promise<ImportParsedSheet> => {
  const content = await file.text();
  const lines = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");

  if (lines.length < 2) {
    throw new Error("O arquivo CSV precisa conter cabeçalho e pelo menos uma linha de dados.");
  }

  const commaCount = (lines[0].match(/,/g) || []).length;
  const semicolonCount = (lines[0].match(/;/g) || []).length;
  const separator: "," | ";" = semicolonCount > commaCount ? ";" : ",";

  const rawHeaders = parseCsvLine(lines[0], separator).map((header) => String(header ?? "").trim());
  const headers = rawHeaders.filter((header) => header !== "");

  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line, separator);
    return rawHeaders.reduce<Record<string, unknown>>((acc, header, index) => {
      if (!header) return acc;
      acc[header] = String(values[index] ?? "").trim();
      return acc;
    }, {});
  });

  return { headers, rows };
};

export const loadXlsxLibrary = async (): Promise<SheetJsLibrary> => {
  if (window.XLSX) return window.XLSX;

  await new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector("script[data-sheetjs='true']") as HTMLScriptElement | null;
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("Não foi possível carregar a biblioteca Excel.")), {
        once: true
      });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js";
    script.async = true;
    script.dataset.sheetjs = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Não foi possível carregar a biblioteca Excel."));
    document.head.appendChild(script);
  });

  if (!window.XLSX) throw new Error("Biblioteca Excel indisponível.");

  return window.XLSX;
};

const parseXlsxFile = async (file: File): Promise<ImportParsedSheet> => {
  const data = await file.arrayBuffer();
  const xlsx = await loadXlsxLibrary();
  const workbook = xlsx.read(data, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) throw new Error("A planilha não possui abas válidas.");

  const sheet = workbook.Sheets[firstSheetName];
  const sheetRows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });

  if (sheetRows.length < 1) {
    throw new Error("A planilha precisa conter cabeçalho e pelo menos uma linha de dados.");
  }

  return {
    headers: Object.keys(sheetRows[0] ?? {}).filter((header) => String(header).trim() !== ""),
    rows: sheetRows
  };
};

export const parseImportFile = async (file: File): Promise<ImportParsedSheet> => {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".csv")) return parseCsvFile(file);
  if (lowerName.endsWith(".xlsx")) return parseXlsxFile(file);
  throw new Error("Formato inválido. Envie um arquivo CSV ou XLSX.");
};
