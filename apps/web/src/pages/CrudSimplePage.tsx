import { ChangeEvent, FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useNavigate } from "react-router-dom";
import api from "../lib/apiClient";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import { validateClientPayload, type ClientPayloadInput } from "../lib/validateClientPayload";
import {
  ClientImportColumnMappingStep,
  type ClientImportFieldDefinition,
  type ClientImportFieldKey
} from "../components/ClientImportColumnMappingStep";

type CrudSimplePageProps = {
  endpoint: string;
  title: string;
  fields: {
    key: string;
    label: string;
    type?: string;
    placeholder?: string;
    options?: Array<{ value: string; label: string }>;
  }[];
  readOnly?: boolean;
  detailsPath?: string;
  createInModal?: boolean;
  createButtonLabel?: string;
  createModalTitle?: string;
};

type ClientListItem = {
  id: string;
  ownerSellerId?: string;
  ownerSellerName?: string;
  ownerSeller?: {
    id: string;
    name: string;
  };
  [key: string]: unknown;
};

type ClientImportRow = {
  sourceRowNumber: number;
  name: string;
  city?: string;
  state?: string;
  region?: string;
  potentialHa?: number;
  farmSizeHa?: number;
  clientType?: string;
  cnpj?: string;
  segment?: string;
  ownerSellerId?: string;
};

type ImportParsedSheet = {
  headers: string[];
  rows: Record<string, unknown>[];
};

type ClientImportErrorItem = {
  rowNumber: number;
  clientName: string;
  message: string;
};

type ClientImportAction = "update" | "skip" | "import_anyway";
type ClientImportStatus = "new" | "duplicate_in_file" | "duplicate" | "error";

type ClientImportSummary = {
  total: number;
  imported: number;
  ignoredByError: number;
  apiFailures: number;
};

type ClientImportFinalReportRow = {
  rowNumber: number;
  status: "IMPORTADO" | "ERRO" | "FALHA_API";
  reason: string;
  createdId: string;
};

type ImportAnalysisRow = ClientImportRow & {
  status: ClientImportStatus;
  action?: ClientImportAction;
  existingClientId?: string;
  errorMessage?: string;
};

type ClientImportSimulationStatus = "valid" | "duplicate" | "error";

type ClientImportSimulationItem = {
  row: number;
  name: string;
  status: ClientImportSimulationStatus;
  reason: string | null;
};

type ClientImportSimulationSummary = {
  totalAnalyzed: number;
  valid: number;
  duplicated: number;
  errors: number;
  items: ClientImportSimulationItem[];
};

type ExistsBulkResponseItem = {
  cnpjDigits: string | null;
  fallbackKey: string | null;
  exists: boolean;
  clientId: string | null;
};

type ImportValidationSummary = {
  errors: string[];
  rowResults: ImportAnalysisRow[];
  validCount: number;
  errorCount: number;
  duplicateInFileCount: number;
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

const clientImportColumns = [
  "name",
  "city",
  "state",
  "region",
  "potentialHa",
  "farmSizeHa",
  "clientType",
  "cnpj",
  "segment",
  "ownerSellerId"
] as const;

const importMappingStorageKey = "clientsImport.columnMapping.v1";
const importTemplatesStorageKey = "clientsImport.templates.v1";

const clientImportFieldDefinitions: ClientImportFieldDefinition[] = [
  { key: "name", label: "Nome", required: true },
  { key: "city", label: "Cidade", required: true },
  { key: "state", label: "UF", required: true },
  { key: "clientType", label: "Tipo PJ/PF", required: true },
  { key: "region", label: "Região", required: false },
  { key: "potentialHa", label: "Potencial (ha)", required: false },
  { key: "farmSizeHa", label: "Área total (ha)", required: false },
  { key: "cnpj", label: "CNPJ/CPF", required: false },
  { key: "segment", label: "Segmento", required: false },
  { key: "ownerSellerId", label: "Vendedor responsável", required: false }
];

const getImportColumnLabel = (key: (typeof clientImportColumns)[number]) =>
  clientImportFieldDefinitions.find((f) => f.key === key)?.label ?? key;

export default function CrudSimplePage({
  endpoint,
  title,
  fields,
  readOnly = false,
  detailsPath,
  createInModal = false,
  createButtonLabel = "Adicionar",
  createModalTitle = "Novo registro"
}: CrudSimplePageProps) {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [items, setItems] = useState<ClientListItem[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string; role?: string }>>([]);
  const [form, setForm] = useState<any>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formFieldErrors, setFormFieldErrors] = useState<
    Partial<Record<keyof ClientPayloadInput, string>>
  >({});
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [quickFilters, setQuickFilters] = useState({
    uf: "",
    region: "",
    clientType: "",
    ownerSellerId: ""
  });

  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isApplyingFilters, setIsApplyingFilters] = useState(false);

  const [openActionsMenuId, setOpenActionsMenuId] = useState<string | null>(null);

  // Import
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importStep, setImportStep] = useState<1 | 2>(1);
  const [importRows, setImportRows] = useState<ClientImportRow[]>([]);
  const [importPreviewRows, setImportPreviewRows] = useState<ImportAnalysisRow[]>([]);
  const [importExcelHeaders, setImportExcelHeaders] = useState<string[]>([]);
  const [importColumnMapping, setImportColumnMapping] = useState<
    Partial<Record<ClientImportFieldKey, string>>
  >({});
  const [importTemplates, setImportTemplates] = useState<
    Record<string, Partial<Record<ClientImportFieldKey, string>>>
  >({});
  const [selectedImportTemplateName, setSelectedImportTemplateName] = useState("");
  const [importRawRows, setImportRawRows] = useState<Record<string, unknown>[]>([]);
  const [importDefaultOwnerSellerId, setImportDefaultOwnerSellerId] = useState("");
  const [importValidationErrors, setImportValidationErrors] = useState<string[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportReady, setIsImportReady] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });
  const [importSummary, setImportSummary] = useState<ClientImportSummary | null>(null);
  const [importFinalReportRows, setImportFinalReportRows] = useState<ClientImportFinalReportRow[]>([]);
  const [importSimulationSummary, setImportSimulationSummary] =
    useState<ClientImportSimulationSummary | null>(null);
  const [didRunLocalValidation, setDidRunLocalValidation] = useState(false);

  const isClientsPage = endpoint === "/clients";
  const canFilterBySeller = isClientsPage && (user?.role === "diretor" || user?.role === "gerente");
  const isSeller = user?.role === "vendedor";
  const canChooseOwnerSeller = user?.role === "diretor" || user?.role === "gerente";

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get(endpoint);
      setItems(Array.isArray(response.data) ? response.data : []);
    } catch (e: any) {
      setItems([]);
      setError(e.response?.data?.message || "Não foi possível carregar os dados.");
    } finally {
      setLoading(false);
    }
  };

  const loadClients = async () => {
    setError(null);
    setIsApplyingFilters(true);

    const params: Record<string, string | number> = {
      page,
      pageSize
    };

    if (debouncedSearch) params.q = debouncedSearch;
    if (quickFilters.uf) params.state = quickFilters.uf;
    if (quickFilters.region) params.region = quickFilters.region;
    if (quickFilters.clientType) params.clientType = quickFilters.clientType;
    if (canFilterBySeller && quickFilters.ownerSellerId) params.ownerSellerId = quickFilters.ownerSellerId;

    try {
      const response = await api.get(endpoint, { params });
      const payload = response.data;

      const resolvedItems = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.items)
          ? payload.items
          : Array.isArray(payload?.data)
            ? payload.data
            : [];

      const parsedTotal = Number(payload?.total);
      const resolvedTotal = Number.isFinite(parsedTotal) ? parsedTotal : resolvedItems.length;

      const parsedTotalPages = Number(payload?.totalPages);
      const resolvedTotalPages = Number.isFinite(parsedTotalPages)
        ? parsedTotalPages
        : Math.max(1, Math.ceil(resolvedTotal / pageSize));

      setItems(resolvedItems);
      setTotalItems(resolvedTotal);
      setTotalPages(Math.max(1, resolvedTotalPages));
    } catch (e: any) {
      setItems([]);
      setTotalItems(0);
      setTotalPages(1);
      setError(e.response?.data?.message || "Não foi possível carregar os clientes.");
    } finally {
      setLoading(false);
      setIsApplyingFilters(false);
    }
  };

  useEffect(() => {
    if (isClientsPage) {
      setLoading(true);
      void loadClients();
      return;
    }
    void load();
  }, [
    endpoint,
    isClientsPage,
    page,
    pageSize,
    debouncedSearch,
    quickFilters.uf,
    quickFilters.region,
    quickFilters.clientType,
    quickFilters.ownerSellerId,
    canFilterBySeller
  ]);

  useEffect(() => {
    if (!isClientsPage || !canFilterBySeller) {
      setUsers([]);
      return;
    }

    api
      .get("/users")
      .then((response) => {
        const allUsers = Array.isArray(response.data) ? response.data : [];
        const sellers = allUsers.filter((item: any) => item?.role === "vendedor" && item?.id && item?.name);
        setUsers(sellers);
      })
      .catch(() => {
        setUsers([]);
      });
  }, [canFilterBySeller, isClientsPage]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filterOptions = useMemo(
    () => ({
      ufs: [
        "AC",
        "AL",
        "AP",
        "AM",
        "BA",
        "CE",
        "DF",
        "ES",
        "GO",
        "MA",
        "MT",
        "MS",
        "MG",
        "PA",
        "PB",
        "PR",
        "PE",
        "PI",
        "RJ",
        "RN",
        "RS",
        "RO",
        "RR",
        "SC",
        "SP",
        "SE",
        "TO"
      ],
      regions: ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"],
      clientTypes: ["PJ", "PF"]
    }),
    []
  );

  const visibleItems = items;

  const getCellValue = (item: ClientListItem, fieldKey: string) => {
    if (isClientsPage && fieldKey === "ownerSellerId") {
      return item.ownerSeller?.name || item.ownerSellerName || "—";
    }
    const value = item[fieldKey];
    if (value === null || value === undefined || value === "") return "—";
    return String(value);
  };

  const clearClientFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setQuickFilters({ uf: "", region: "", clientType: "", ownerSellerId: "" });
    setPage(1);
  };

  useEffect(() => {
    if (!isClientsPage) return;
    setPage(1);
  }, [
    debouncedSearch,
    quickFilters.uf,
    quickFilters.region,
    quickFilters.clientType,
    quickFilters.ownerSellerId,
    isClientsPage
  ]);

  const parseFormValue = (fieldKey: string, fieldType: string | undefined, rawValue: string) => {
    if (fieldType === "number") return rawValue === "" ? "" : Number(rawValue);
    if (fieldKey === "state") return rawValue.toUpperCase();
    return rawValue;
  };

  const loadXlsxLibrary = async () => {
    if (window.XLSX) return window.XLSX;

    await new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector("script[data-sheetjs='true']") as HTMLScriptElement | null;
      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(), { once: true });
        existingScript.addEventListener(
          "error",
          () => reject(new Error("Não foi possível carregar a biblioteca Excel.")),
          { once: true }
        );
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

    if (!window.XLSX) {
      throw new Error("Biblioteca Excel indisponível.");
    }

    return window.XLSX;
  };

  const downloadImportTemplate = async () => {
    const worksheetData: Array<Array<string | number>> = [
      [...clientImportColumns],
      ["Fazenda Santa Rita", "Sorriso", "MT", "Centro-Oeste", 1200, 2500, "PJ", "12.345.678/0001-99", "Soja e milho", ""]
    ];

    const xlsx = await loadXlsxLibrary();
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.aoa_to_sheet(worksheetData);
    xlsx.utils.book_append_sheet(workbook, worksheet, "clientes");
    xlsx.writeFile(workbook, "modelo-importacao-clientes.xlsx");
    toast.success("Modelo de importação baixado com sucesso.");
  };

  const normalizeHeader = (value: unknown) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, "");

  const normalizeTextValue = (value: unknown) => String(value ?? "").trim();

  const parseDecimalValue = (value: unknown): { parsedValue: number | undefined; isInvalid: boolean } => {
    if (value === null || value === undefined) {
      return { parsedValue: undefined, isInvalid: false };
    }

    if (typeof value === "number") {
      return Number.isFinite(value) ? { parsedValue: value, isInvalid: false } : { parsedValue: undefined, isInvalid: true };
    }

    const normalized = String(value).trim();
    if (!normalized) {
      return { parsedValue: undefined, isInvalid: false };
    }

    const sanitized = normalized.replace(/\s/g, "");
    const lastComma = sanitized.lastIndexOf(",");
    const lastDot = sanitized.lastIndexOf(".");

    let decimalSeparator = "";
    if (lastComma >= 0 && lastDot >= 0) {
      decimalSeparator = lastComma > lastDot ? "," : ".";
    } else if (lastComma >= 0) {
      decimalSeparator = ",";
    } else if (lastDot >= 0) {
      decimalSeparator = ".";
    }

    let numericText = sanitized;
    if (decimalSeparator) {
      const thousandsSeparator = decimalSeparator === "," ? /\./g : /,/g;
      numericText = numericText.replace(thousandsSeparator, "");
      if (decimalSeparator === ",") {
        numericText = numericText.replace(/,/g, ".");
      }
    }

    const parsedValue = Number(numericText);
    return Number.isNaN(parsedValue) ? { parsedValue: undefined, isInvalid: true } : { parsedValue, isInvalid: false };
  };

  const parseImportFile = async (file: File): Promise<ImportParsedSheet> => {
    const data = await file.arrayBuffer();
    const xlsx = await loadXlsxLibrary();
    const workbook = xlsx.read(data, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      throw new Error("A planilha não possui abas válidas.");
    }

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

  const autoMapColumns = (headers: string[]) => {
    const synonyms: Record<ClientImportFieldKey, string[]> = {
      name: ["name", "nome", "cliente", "razaosocial", "produtor", "nomedocliente"],
      city: ["city", "cidade", "municipio"],
      state: ["state", "uf", "estado"],
      clientType: ["clienttype", "tipo", "pjpf", "pessoa", "tipocliente"],
      region: ["region", "regiao"],
      potentialHa: ["potentialha", "potencial", "hapotencial", "potencialha"],
      farmSizeHa: ["farmsizeha", "area", "tamanho", "hatotal", "areatotal"],
      cnpj: ["cnpj", "cpf", "cnpjcpf", "documento"],
      segment: ["segment", "segmento", "atividade", "perfil"],
      ownerSellerId: ["ownersellerid", "vendedor", "responsavel", "vendedorresponsavel", "idseller"]
    };

    const normalizedHeaders = headers.map((header) => ({ header, normalized: normalizeHeader(header) }));
    const mapping: Partial<Record<ClientImportFieldKey, string>> = {};

    clientImportFieldDefinitions.forEach((field) => {
      const expected = normalizeHeader(field.key);
      const candidates = normalizedHeaders.filter((item) => {
        if (!item.normalized) return false;
        if (item.normalized === expected) return true;
        return synonyms[field.key].some(
          (synonym) => item.normalized.includes(synonym) || synonym.includes(item.normalized)
        );
      });

      if (candidates.length === 1) {
        mapping[field.key] = candidates[0].header;
      }
    });

    return mapping;
  };

  const loadMappingFromLocalStorage = () => {
    try {
      const rawValue = localStorage.getItem(importMappingStorageKey);
      if (!rawValue) return {};
      const parsed = JSON.parse(rawValue) as Partial<Record<ClientImportFieldKey, string>>;
      return parsed ?? {};
    } catch {
      return {};
    }
  };

  const loadTemplatesFromLocalStorage = () => {
    try {
      const rawValue = localStorage.getItem(importTemplatesStorageKey);
      if (!rawValue) return {};
      const parsed = JSON.parse(rawValue) as Record<string, Partial<Record<ClientImportFieldKey, string>>>;
      return parsed ?? {};
    } catch {
      return {};
    }
  };

  const saveTemplatesToLocalStorage = (templates: Record<string, Partial<Record<ClientImportFieldKey, string>>>) => {
    localStorage.setItem(importTemplatesStorageKey, JSON.stringify(templates));
  };

  const saveMappingToLocalStorage = (mapping: Partial<Record<ClientImportFieldKey, string>>) => {
    localStorage.setItem(importMappingStorageKey, JSON.stringify(mapping));
  };

  const applySavedMapping = (mapping: Partial<Record<ClientImportFieldKey, string>>, headers: string[]) => {
    const headersSet = new Set(headers);
    return Object.entries(mapping).reduce<Partial<Record<ClientImportFieldKey, string>>>((acc, [key, value]) => {
      if (!value || !headersSet.has(value)) return acc;
      acc[key as ClientImportFieldKey] = value;
      return acc;
    }, {});
  };

  const hasAllRequiredMappings = (mapping: Partial<Record<ClientImportFieldKey, string>>) => {
    const requiredFields: ClientImportFieldKey[] = ["name", "city", "state", "clientType"];
    return requiredFields.every((field) => Boolean(mapping[field]));
  };

  useEffect(() => {
    setImportTemplates(loadTemplatesFromLocalStorage());
  }, []);

  const applyMappingToRow = (
    row: Record<string, unknown>,
    rowIndex: number,
    mapping: Partial<Record<ClientImportFieldKey, string>>,
    defaultOwnerSellerId?: string
  ): ClientImportRow => {
    const potentialValue = mapping.potentialHa ? row[mapping.potentialHa] : undefined;
    const farmValue = mapping.farmSizeHa ? row[mapping.farmSizeHa] : undefined;

    const potentialHaResult = parseDecimalValue(potentialValue);
    const farmSizeHaResult = parseDecimalValue(farmValue);

    const resolvedOwnerSeller = isSeller
      ? user?.id
      : (mapping.ownerSellerId ? normalizeTextValue(row[mapping.ownerSellerId]) : "") || defaultOwnerSellerId;

    return {
      sourceRowNumber: rowIndex + 2,
      name: mapping.name ? normalizeTextValue(row[mapping.name]) : "",
      city: mapping.city ? normalizeTextValue(row[mapping.city]) : "",
      state: mapping.state ? normalizeTextValue(row[mapping.state]) : "",
      region: mapping.region ? normalizeTextValue(row[mapping.region]) : "",
      potentialHa: potentialHaResult.isInvalid ? Number.NaN : potentialHaResult.parsedValue,
      farmSizeHa: farmSizeHaResult.isInvalid ? Number.NaN : farmSizeHaResult.parsedValue,
      clientType: mapping.clientType ? normalizeTextValue(row[mapping.clientType]) : "",
      cnpj: mapping.cnpj ? normalizeTextValue(row[mapping.cnpj]) : "",
      segment: mapping.segment ? normalizeTextValue(row[mapping.segment]) : "",
      ownerSellerId: resolvedOwnerSeller ? normalizeTextValue(resolvedOwnerSeller) : ""
    };
  };

  const buildRowsFromCurrentMapping = (
    rows: Record<string, unknown>[],
    mapping: Partial<Record<ClientImportFieldKey, string>>,
    defaultOwnerSellerId?: string
  ) =>
    rows
      .map((row, index) => applyMappingToRow(row, index, mapping, defaultOwnerSellerId))
      .filter((row) =>
        [
          row.name,
          row.city,
          row.state,
          row.region,
          row.potentialHa,
          row.farmSizeHa,
          row.clientType,
          row.cnpj,
          row.segment,
          row.ownerSellerId
        ].some((value) => value !== "" && value !== undefined)
      );

  const validateImportRows = (rows: ClientImportRow[], defaultOwnerSellerId?: string): ImportValidationSummary => {
    const errors: string[] = [];
    const rowResults: ImportAnalysisRow[] = [];
    let validCount = 0;
    let duplicateInFileCount = 0;
    const duplicateKeyToRows = new Map<string, number[]>();

    if (rows.length === 0) {
      errors.push("Nenhuma linha de dados válida foi encontrada.");
      return { errors, rowResults, validCount: 0, errorCount: 0, duplicateInFileCount: 0 };
    }

    if (!isSeller && canChooseOwnerSeller && !defaultOwnerSellerId && !importColumnMapping.ownerSellerId) {
      errors.push("Selecione um vendedor padrão para este lote ou mapeie a coluna de vendedor responsável.");
    }

    rows.forEach((row, index) => {
      const rowNumber = row.sourceRowNumber || index + 2;
      const rowErrors: string[] = [];

      if (!row.name) rowErrors.push("Nome obrigatório");
      if (!row.city) rowErrors.push("Cidade obrigatória");
      if (!row.state || row.state.trim().length !== 2) rowErrors.push("UF obrigatória (2 letras)");

      const normalizedClientType = String(row.clientType ?? "")
        .trim()
        .toUpperCase();
      if (!["PJ", "PF"].includes(normalizedClientType)) {
        rowErrors.push("Tipo do cliente deve ser PJ ou PF");
      }

      if (row.cnpj) {
        const numericDocument = row.cnpj.replace(/\D/g, "");
        if (!/^\d{11}$|^\d{14}$/.test(numericDocument)) {
          rowErrors.push("CNPJ/CPF inválido (use 11 ou 14 dígitos)");
        }
      }
      if (rowErrors.length === 0) {
        const normalizedDocument = String(row.cnpj ?? "").replace(/\D/g, "");
        const normalizePreviewText = (value: string | undefined) =>
          String(value ?? "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");
        const duplicateKey = normalizedDocument
          ? `doc:${normalizedDocument}`
          : `name_city_uf:${normalizePreviewText(row.name)}|${normalizePreviewText(row.city)}|${normalizePreviewText(row.state)}`;

        if (!duplicateKeyToRows.has(duplicateKey)) {
          duplicateKeyToRows.set(duplicateKey, []);
        }

        duplicateKeyToRows.get(duplicateKey)?.push(rowNumber);

        validCount += 1;
        rowResults.push({
          ...row,
          clientType: normalizedClientType,
          status: "new"
        });
        return;
      }

      errors.push(`Linha ${rowNumber}: ${rowErrors.join(", ")}`);
      rowResults.push({
        ...row,
        clientType: normalizedClientType,
        status: "error",
        errorMessage: rowErrors.join("; ")
      });
    });

    const duplicateRowNumbers = new Set<number>();
    duplicateKeyToRows.forEach((rowNumbers) => {
      if (rowNumbers.length > 1) {
        rowNumbers.forEach((rowNumber) => duplicateRowNumbers.add(rowNumber));
      }
    });

    rowResults.forEach((row) => {
      if (row.status !== "new") return;
      if (!duplicateRowNumbers.has(row.sourceRowNumber)) return;

      row.status = "duplicate_in_file";
      row.errorMessage = "Duplicado no arquivo: mesma chave local (CNPJ/CPF ou Nome + Cidade + UF).";
      validCount -= 1;
      duplicateInFileCount += 1;
      errors.push(`Linha ${row.sourceRowNumber}: duplicado no arquivo (mesma chave local).`);
    });

    return {
      errors,
      rowResults,
      validCount,
      errorCount: rows.length - validCount,
      duplicateInFileCount
    };
  };

  const buildImportPayload = (row: ClientImportRow): Record<string, unknown> => {
    const rowWithResolvedOwner = {
      ...row,
      ownerSellerId: isSeller ? user?.id : row.ownerSellerId || importDefaultOwnerSellerId
    };

    const { sanitizedPayload } = validateClientPayload(rowWithResolvedOwner, {
      isSeller,
      canChooseOwnerSeller,
      sellerId: user?.id
    });

    return sanitizedPayload;
  };

  const buildFallbackDuplicateKey = (row: Pick<ClientImportRow, "name" | "city" | "state">) => {
    const normalizeText = (value?: string) =>
      String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

    return `${normalizeText(row.name)}|${normalizeText(row.city)}|${String(row.state ?? "").trim().toUpperCase()}`;
  };

  const applyBackendDuplicateCheck = async (rows: ImportAnalysisRow[]) => {
    const candidates = rows.filter((row) => row.status === "new");
    if (candidates.length === 0) return rows;

    const keys = candidates.map((row) => ({
      cnpjDigits: String(row.cnpj ?? "").replace(/\D/g, "") || undefined,
      fallbackKey: buildFallbackDuplicateKey(row)
    }));

    const pageSize = 500;
    const totalPages = Math.max(1, Math.ceil(keys.length / pageSize));
    const foundByKey = new Map<string, string>();

    for (let page = 1; page <= totalPages; page += 1) {
      const response = await api.post<{ data: ExistsBulkResponseItem[] }>("/clients/exists-bulk", {
        keys,
        page,
        pageSize
      });

      const responseItems = response.data?.data ?? [];
      responseItems.forEach((item) => {
        if (!item.exists || !item.clientId) return;

        if (item.cnpjDigits) {
          foundByKey.set(`doc:${item.cnpjDigits}`, item.clientId);
        }
        if (item.fallbackKey) {
          foundByKey.set(`fallback:${item.fallbackKey}`, item.clientId);
        }
      });
    }

    return rows.map((row) => {
      if (row.status !== "new") return row;

      const cnpjDigits = String(row.cnpj ?? "").replace(/\D/g, "");
      const fallbackKey = buildFallbackDuplicateKey(row);
      const existingClientId =
        (cnpjDigits ? foundByKey.get(`doc:${cnpjDigits}`) : undefined) ?? foundByKey.get(`fallback:${fallbackKey}`);

      if (!existingClientId) return row;

      return {
        ...row,
        status: "duplicate" as const,
        existingClientId,
        action: row.action ?? "skip",
        errorMessage: "JÁ EXISTE NO SISTEMA"
      };
    });
  };

  const runImportValidation = async (
    rows: Record<string, unknown>[],
    mapping: Partial<Record<ClientImportFieldKey, string>>,
    defaultOwnerSellerId?: string
  ) => {
    const mappedRows = buildRowsFromCurrentMapping(rows, mapping, defaultOwnerSellerId);
    const validation = validateImportRows(mappedRows, defaultOwnerSellerId);

    setImportRows(mappedRows);
    setImportValidationErrors(validation.errors);
    setIsImportReady(validation.validCount > 0);
    setImportSummary(null);
    setImportFinalReportRows([]);
    setImportSimulationSummary(null);
    setDidRunLocalValidation(false);

    let previewRows = validation.rowResults;

    if (validation.rowResults.some((row) => row.status === "new")) {
      try {
        previewRows = await applyBackendDuplicateCheck(validation.rowResults);
      } catch {
        toast.warning("Não foi possível checar duplicados no sistema. O preview exibirá apenas validação local.");
      }
    }

    setImportPreviewRows(previewRows);

    if (validation.errors.length > 0) {
      toast.error("Foram encontrados erros de validação na planilha.");
      return;
    }

    toast.success(`${mappedRows.length} linha(s) carregada(s) com sucesso.`);
  };

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];

    setImportRows([]);
    setImportPreviewRows([]);
    setImportExcelHeaders([]);
    setImportRawRows([]);
    setImportColumnMapping({});
    setSelectedImportTemplateName("");
    setImportValidationErrors([]);
    setImportDefaultOwnerSellerId("");
    setIsImportReady(false);
    setImportSummary(null);
    setImportSimulationSummary(null);
    setImportProgress({ current: 0, total: 0 });
    setImportStep(1);
    setDidRunLocalValidation(false);

    if (!selectedFile) return;

    if (!selectedFile.name.toLowerCase().endsWith(".xlsx")) {
      toast.error("Selecione um arquivo no formato .xlsx.");
      return;
    }

    try {
      const parsedSheet = await parseImportFile(selectedFile);
      const autoMapping = autoMapColumns(parsedSheet.headers);
      const savedMapping = applySavedMapping(loadMappingFromLocalStorage(), parsedSheet.headers);
      const mergedMapping = { ...autoMapping, ...savedMapping };

      setImportExcelHeaders(parsedSheet.headers);
      setImportRawRows(parsedSheet.rows);
      setImportColumnMapping(mergedMapping);

      if (hasAllRequiredMappings(mergedMapping)) {
        setImportStep(2);
        await runImportValidation(parsedSheet.rows, mergedMapping, "");
      } else {
        setImportStep(1);
        toast.warning("Mapeie as colunas obrigatórias para continuar.");
      }
    } catch (err: any) {
      setImportRows([]);
      setImportPreviewRows([]);
      setImportValidationErrors([err.message || "Erro ao ler arquivo."]);
      setIsImportReady(false);
      toast.error(err.message || "Não foi possível processar o arquivo.");
    }
  };

  const handleImportMappingChange = (field: ClientImportFieldKey, header: string) => {
    setImportColumnMapping((previous) => ({ ...previous, [field]: header || undefined }));
  };

  const handleUseModelHeaders = () => {
    const fallbackMapping = autoMapColumns(importExcelHeaders);
    setImportColumnMapping(fallbackMapping);
    toast.info("Mapeamento automático aplicado com base no modelo.");
  };

  const handleImportTemplateChange = (templateName: string) => {
    setSelectedImportTemplateName(templateName);

    if (!templateName) return;

    const templateMapping = importTemplates[templateName];
    if (!templateMapping) return;

    const appliedTemplate = applySavedMapping(templateMapping, importExcelHeaders);
    const fallbackMapping = autoMapColumns(importExcelHeaders);
    setImportColumnMapping({ ...fallbackMapping, ...appliedTemplate });
    toast.success(`Template "${templateName}" aplicado.`);
  };

  const handleSaveMapping = () => {
    saveMappingToLocalStorage(importColumnMapping);
    const suggestedName = selectedImportTemplateName || "";
    const templateName = window.prompt("Nome do template", suggestedName)?.trim();

    if (!templateName) {
      toast.warning("Informe um nome válido para o template.");
      return;
    }

    const nextTemplates = {
      ...importTemplates,
      [templateName]: importColumnMapping
    };

    setImportTemplates(nextTemplates);
    setSelectedImportTemplateName(templateName);
    saveTemplatesToLocalStorage(nextTemplates);
    toast.success(`Template "${templateName}" salvo com sucesso.`);
  };

  const handleEditTemplate = () => {
    if (!selectedImportTemplateName) {
      toast.warning("Selecione um template para editar.");
      return;
    }

    const updatedName = window.prompt("Editar nome do template", selectedImportTemplateName)?.trim();
    if (!updatedName) {
      toast.warning("Informe um nome válido para o template.");
      return;
    }

    const nextTemplates = { ...importTemplates };
    delete nextTemplates[selectedImportTemplateName];
    nextTemplates[updatedName] = importColumnMapping;

    setImportTemplates(nextTemplates);
    setSelectedImportTemplateName(updatedName);
    saveTemplatesToLocalStorage(nextTemplates);
    toast.success(`Template "${updatedName}" atualizado.`);
  };

  const handleDeleteTemplate = () => {
    if (!selectedImportTemplateName) {
      toast.warning("Selecione um template para excluir.");
      return;
    }

    const shouldDelete = window.confirm(`Excluir template "${selectedImportTemplateName}"?`);
    if (!shouldDelete) return;

    const nextTemplates = { ...importTemplates };
    delete nextTemplates[selectedImportTemplateName];

    setImportTemplates(nextTemplates);
    setSelectedImportTemplateName("");
    saveTemplatesToLocalStorage(nextTemplates);
    toast.success("Template excluído.");
  };

  const handleContinueAfterMapping = async () => {
    if (!hasAllRequiredMappings(importColumnMapping)) {
      toast.error("Preencha os campos obrigatórios para continuar.");
      return;
    }

    setImportStep(2);
    await runImportValidation(importRawRows, importColumnMapping, importDefaultOwnerSellerId || undefined);
  };

  const resetImportState = () => {
    setIsImportModalOpen(false);
    setImportStep(1);
    setImportRows([]);
    setImportPreviewRows([]);
    setImportExcelHeaders([]);
    setImportColumnMapping({});
    setSelectedImportTemplateName("");
    setImportRawRows([]);
    setImportDefaultOwnerSellerId("");
    setImportValidationErrors([]);
    setIsImportReady(false);
    setImportProgress({ current: 0, total: 0 });
    setImportSummary(null);
    setImportFinalReportRows([]);
    setImportSimulationSummary(null);
  };

  const buildImportFinalReportRows = (
    previewRows: ImportAnalysisRow[],
    importResultsByRow: Map<number, { success: boolean; reason: string; createdId: string }>
  ): ClientImportFinalReportRow[] => {
    return previewRows
      .map((row) => {
        if (row.status === "error") {
          return {
            rowNumber: row.sourceRowNumber,
            status: "ERRO" as const,
            reason: row.errorMessage || "Linha inválida no preview.",
            createdId: ""
          };
        }

        const importResult = importResultsByRow.get(row.sourceRowNumber);

        if (!importResult) {
          return {
            rowNumber: row.sourceRowNumber,
            status: "FALHA_API" as const,
            reason: "Linha válida não processada pela API.",
            createdId: ""
          };
        }

        if (!importResult.success) {
          return {
            rowNumber: row.sourceRowNumber,
            status: "FALHA_API" as const,
            reason: importResult.reason,
            createdId: ""
          };
        }

        return {
          rowNumber: row.sourceRowNumber,
          status: "IMPORTADO" as const,
          reason: importResult.reason,
          createdId: importResult.createdId
        };
      })
      .sort((a, b) => a.rowNumber - b.rowNumber);
  };

  const downloadImportFinalReport = () => {
    if (!importSummary || importFinalReportRows.length === 0) return;

    const escapeCsvCell = (value: string | number) => {
      const stringValue = String(value ?? "").replace(/\r?\n/g, " ");
      const escaped = stringValue.replace(/"/g, '""');
      return `"${escaped}"`;
    };

    const header = ["linha", "status", "motivo", "idCriado"];
    const rows = importFinalReportRows.map((row) =>
      [row.rowNumber, row.status, row.reason, row.createdId].map(escapeCsvCell).join(";")
    );

    const csvContent = [header.map(escapeCsvCell).join(";"), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const today = new Date();
    const dateLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;

    const link = document.createElement("a");
    link.href = url;
    link.download = `relatorio-importacao-clientes-${dateLabel}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const importValidRowsInBatches = async (validRows: ImportAnalysisRow[]) => {
    const batchSize = 50;
    let imported = 0;
    let apiFailures = 0;
    const resultsByRow = new Map<number, { success: boolean; reason: string; createdId: string }>();

    for (let index = 0; index < validRows.length; index += batchSize) {
      const batchRows = validRows.slice(index, index + batchSize);

      const batchResults = await Promise.all(
        batchRows.map(async (row) => {
          try {
            const response = await api.post("/clients", buildImportPayload(row));
            const createdId = String(response?.data?.id ?? response?.data?.client?.id ?? "");
            return {
              rowNumber: row.sourceRowNumber,
              success: true as const,
              reason: "Cliente importado com sucesso.",
              createdId
            };
          } catch (error: any) {
            return {
              rowNumber: row.sourceRowNumber,
              success: false as const,
              reason: error?.response?.data?.message || "Falha ao importar cliente na API.",
              createdId: ""
            };
          }
        })
      );

      batchResults.forEach((result) => {
        resultsByRow.set(result.rowNumber, result);
        if (result.success) imported += 1;
        else apiFailures += 1;
      });

      setImportProgress({ current: Math.min(index + batchRows.length, validRows.length), total: validRows.length });
    }

    return {
      imported,
      apiFailures,
      resultsByRow
    };
  };

  const handleSimulateImport = () => {
    if (importRows.length === 0) return;
    setDidRunLocalValidation(true);
    if (importValidationErrors.length > 0) {
      toast.warning("Validação concluída com pendências. Revise as linhas com status ERRO.");
      return;
    }
    toast.success("Validação local concluída com sucesso.");
  };

  const handleImportClients = async () => {
    if (!isImportReady || importRows.length === 0) return;

    const validRows = importPreviewRows.filter(
      (row) => row.status === "new" || (row.status === "duplicate" && row.action === "import_anyway")
    );
    const ignoredByError = importPreviewRows.length - validRows.length;

    if (validRows.length === 0) {
      toast.warning("Não há linhas válidas para importar.");
      return;
    }

    setIsImporting(true);
    setImportSummary(null);
    setImportFinalReportRows([]);
    setImportSimulationSummary(null);
    setImportProgress({ current: 0, total: validRows.length });

    try {
      const { imported, apiFailures, resultsByRow } = await importValidRowsInBatches(validRows);
      const resolvedSummary: ClientImportSummary = {
        total: importPreviewRows.length,
        imported,
        ignoredByError,
        apiFailures
      };

      const reportRows = buildImportFinalReportRows(importPreviewRows, resultsByRow);

      setImportSummary(resolvedSummary);
      setImportFinalReportRows(reportRows);

      if (apiFailures > 0) {
        toast.warning(
          `Importação finalizada: ${imported} importado(s), ${ignoredByError} ignorado(s) por erro e ${apiFailures} falha(s) da API.`
        );
      } else {
        toast.success(`Importação concluída: ${imported} importado(s), ${ignoredByError} ignorado(s) por erro.`);
      }

      await loadClients();
    } catch (e: any) {
      toast.error(e.response?.data?.message || "Erro ao importar clientes.");
    } finally {
      setIsImporting(false);
    }
  };

  const closeCreateModal = () => {
    setIsCreateModalOpen(false);
    setEditing(null);
    setForm({});
    setFormError(null);
    setFormFieldErrors({});
  };

  const openCreateModal = () => {
    setEditing(null);
    if (isClientsPage && isSeller && user?.id) {
      setForm({ ownerSellerId: user.id });
    } else {
      setForm({});
    }
    setFormError(null);
    setFormFieldErrors({});
    setIsCreateModalOpen(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();

    if (endpoint === "/clients") {
      const { sanitizedPayload, fieldErrors } = validateClientPayload(form, {
        isSeller,
        canChooseOwnerSeller,
        sellerId: user?.id
      });

      setFormFieldErrors(fieldErrors);

      const firstError = Object.values(fieldErrors).find(Boolean);
      if (firstError) {
        setFormError("Corrija os campos obrigatórios destacados.");
        toast.error(firstError);
        return;
      }

      setFormError(null);
      setSaving(true);
      try {
        if (editing) await api.put(`${endpoint}/${editing}`, sanitizedPayload);
        else await api.post(endpoint, sanitizedPayload);

        toast.success(editing ? "Registro atualizado com sucesso." : "Registro criado com sucesso.");

        setForm({});
        setEditing(null);
        setFormFieldErrors({});
        if (isClientsPage) await loadClients();
        else await load();
        if (createInModal) closeCreateModal();
      } catch (err: any) {
        toast.error(err.response?.data?.message || "Erro ao salvar");
      } finally {
        setSaving(false);
      }
      return;
    }

    setSaving(true);
    try {
      const payload = { ...form };

      if (endpoint === "/clients") {
        if (isSeller && user?.id) {
          payload.ownerSellerId = user.id;
        } else if (canChooseOwnerSeller) {
          if (!payload.ownerSellerId) delete payload.ownerSellerId;
        }
      }

      if (editing) await api.put(`${endpoint}/${editing}`, payload);
      else await api.post(endpoint, payload);

      toast.success(editing ? "Registro atualizado com sucesso." : "Registro criado com sucesso.");

      setForm({});
      setEditing(null);
      setFormFieldErrors({});
      if (isClientsPage) await loadClients();
      else await load();
      if (createInModal) closeCreateModal();
    } catch (err: any) {
      toast.error(err.response?.data?.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const onEdit = (item: any) => {
    setFormError(null);
    setFormFieldErrors({});
    if (createInModal) {
      setEditing(item.id);
      setForm(item);
      setIsCreateModalOpen(true);
      return;
    }
    setEditing(item.id);
    setForm(item);
  };

  const onDelete = async (id: string) => {
    const userConfirmed = window.confirm("Tem certeza que deseja excluir este registro?");
    if (!userConfirmed) return;

    await api.delete(`${endpoint}/${id}`);
    if (isClientsPage) await loadClients();
    else await load();
  };

  const onOpenDetails = (id: string) => {
    if (!detailsPath) return;
    navigate(`${detailsPath}/${id}`);
  };

  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    if (!detailsPath) return;

    const targetElement = event.target as HTMLElement;
    const clickedInteractiveElement = targetElement.closest("button, a, [data-row-action-menu='true']");
    if (clickedInteractiveElement) return;

    onOpenDetails(id);
  };

  const importCounters = useMemo(() => {
    const errorCount = importPreviewRows.filter((row) => row.status === "error").length;
    const duplicateInFileCount = importPreviewRows.filter((row) => row.status === "duplicate_in_file").length;
    const duplicateInSystemCount = importPreviewRows.filter((row) => row.status === "duplicate").length;
    const validCount = importPreviewRows.filter(
      (row) => row.status === "new" || (row.status === "duplicate" && row.action === "import_anyway")
    ).length;
    return { validCount, errorCount, duplicateInFileCount, duplicateInSystemCount, totalAnalyzed: importPreviewRows.length };
  }, [importPreviewRows]);

  const handleDuplicateActionChange = (rowNumber: number, action: ClientImportAction) => {
    setImportPreviewRows((previous) =>
      previous.map((row) => (row.sourceRowNumber === rowNumber && row.status === "duplicate" ? { ...row, action } : row))
    );
  };

  const downloadPreviewValidationReport = () => {
    if (importPreviewRows.length === 0) return;

    const escapeCsvCell = (value: string | number) => `"${String(value ?? "").replace(/\r?\n/g, " ").replace(/"/g, '""')}"`;
    const header = ["linha", "status", "motivo"];
    const rows = importPreviewRows.map((row) =>
      [
        row.sourceRowNumber,
        row.status === "new"
          ? "NOVO"
          : row.status === "duplicate_in_file"
            ? "DUPLICADO NO ARQUIVO"
            : row.status === "duplicate"
              ? "JÁ EXISTE NO SISTEMA"
              : "ERRO",
        row.errorMessage || "OK"
      ]
        .map(escapeCsvCell)
        .join(";")
    );

    const blob = new Blob([[header.map(escapeCsvCell).join(";"), ...rows].join("\n")], {
      type: "text/csv;charset=utf-8;"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "relatorio-preview-importacao-clientes.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-slate-900">{title}</h2>

      {!readOnly && !createInModal && (
        <form
          onSubmit={submit}
          className="grid gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-3"
        >
          {fields.map((f) => {
            const fieldPlaceholder = f.placeholder ?? `Informe ${f.label.toLowerCase()}`;

            if (f.type === "select") {
              return (
                <select
                  key={f.key}
                  required
                  className="rounded-lg border p-2"
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                >
                  <option value="">Selecione {f.label.toLowerCase()}</option>
                  {(f.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              );
            }

            return (
              <input
                key={f.key}
                required
                className="rounded-lg border p-2"
                type={f.type || "text"}
                placeholder={fieldPlaceholder}
                value={form[f.key] ?? ""}
                onChange={(e) => setForm({ ...form, [f.key]: parseFormValue(f.key, f.type, e.target.value) })}
              />
            );
          })}
          <button
            disabled={saving}
            className="rounded-lg bg-brand-700 px-3 py-2 font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Salvando..." : editing ? "Atualizar" : "Criar"}
          </button>
        </form>
      )}

      {!readOnly && createInModal ? (
        <div className="flex flex-wrap justify-end gap-2">
          {isClientsPage ? (
            <button
              type="button"
              onClick={() => setIsImportModalOpen(true)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
            >
              Importar
            </button>
          ) : null}
          <button
            type="button"
            onClick={openCreateModal}
            className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800"
          >
            {createButtonLabel}
          </button>
        </div>
      ) : null}

      {isClientsPage ? (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <input
              className="rounded-lg border border-slate-300 px-3 py-2"
              placeholder="Buscar clientes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="rounded-lg border border-slate-300 px-3 py-2"
              value={quickFilters.uf}
              onChange={(e) => setQuickFilters((prev) => ({ ...prev, uf: e.target.value }))}
            >
              <option value="">UF (todas)</option>
              {filterOptions.ufs.map((uf) => (
                <option key={uf} value={uf}>
                  {uf}
                </option>
              ))}
            </select>
            <select
              className="rounded-lg border border-slate-300 px-3 py-2"
              value={quickFilters.region}
              onChange={(e) => setQuickFilters((prev) => ({ ...prev, region: e.target.value }))}
            >
              <option value="">Região (todas)</option>
              {filterOptions.regions.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
            <select
              className="rounded-lg border border-slate-300 px-3 py-2"
              value={quickFilters.clientType}
              onChange={(e) => setQuickFilters((prev) => ({ ...prev, clientType: e.target.value }))}
            >
              <option value="">Tipo (todos)</option>
              {filterOptions.clientTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>

            {canFilterBySeller ? (
              <select
                className="rounded-lg border border-slate-300 px-3 py-2"
                value={quickFilters.ownerSellerId}
                onChange={(e) => setQuickFilters((prev) => ({ ...prev, ownerSellerId: e.target.value }))}
              >
                <option value="">Vendedor (todos)</option>
                {users.map((seller) => (
                  <option key={seller.id} value={seller.id}>
                    {seller.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-slate-600">{totalItems} clientes encontrados</span>
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              onClick={clearClientFilters}
            >
              Limpar filtros
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? <div className="p-4 text-slate-500">Carregando...</div> : null}

        {error ? (
          <div className="space-y-3 p-4 text-amber-700">
            <p>{error}</p>
            <button
              type="button"
              className="rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-medium"
              onClick={() => (isClientsPage ? void loadClients() : void load())}
            >
              Tentar novamente
            </button>
          </div>
        ) : null}

        {!loading && !error ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-brand-50 text-brand-800">
                {fields.map((f) => (
                  <th className="p-2 text-left" key={f.key}>
                    {f.label}
                  </th>
                ))}
                {detailsPath || !readOnly ? <th className="p-2 text-left">Ações</th> : null}
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => (
                <tr
                  key={it.id}
                  className={`border-t border-slate-100 ${detailsPath ? "cursor-pointer hover:bg-slate-50" : ""}`}
                  onClick={(event) => onRowClick(event, it.id)}
                >
                  {fields.map((f) => (
                    <td key={f.key} className="p-2 text-slate-700">
                      {getCellValue(it, f.key)}
                    </td>
                  ))}
                  {detailsPath || !readOnly ? (
                    <td className="p-2">
                      <div className="flex items-center justify-end gap-2" data-row-action-menu="true">
                        {detailsPath ? (
                          <button
                            type="button"
                            className="rounded-md border border-brand-200 px-2.5 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50 sm:text-sm"
                            onClick={() => onOpenDetails(it.id)}
                          >
                            Abrir
                          </button>
                        ) : null}

                        {!readOnly ? (
                          <div className="relative">
                            <button
                              type="button"
                              className="rounded-md border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-100"
                              aria-label="Abrir ações"
                              onClick={() => setOpenActionsMenuId((current) => (current === it.id ? null : it.id))}
                            >
                              <MoreHorizontal size={16} />
                            </button>

                            {openActionsMenuId === it.id ? (
                              <div className="absolute right-0 z-10 mt-1 min-w-28 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                                <button
                                  type="button"
                                  className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100"
                                  onClick={() => {
                                    setOpenActionsMenuId(null);
                                    onEdit(it);
                                  }}
                                >
                                  Editar
                                </button>
                                <button
                                  type="button"
                                  className="block w-full px-3 py-1.5 text-left text-sm text-rose-700 hover:bg-rose-50"
                                  onClick={() => {
                                    setOpenActionsMenuId(null);
                                    void onDelete(it.id);
                                  }}
                                >
                                  Excluir
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}

              {visibleItems.length === 0 ? (
                <tr>
                  <td
                    colSpan={fields.length + (detailsPath || !readOnly ? 1 : 0)}
                    className="p-8 text-center text-slate-500"
                  >
                    Nenhum registro encontrado com os filtros atuais.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </div>

      {isClientsPage && !loading && !error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-sm text-slate-600">
            Página <span className="font-semibold text-slate-900">{page}</span> de{" "}
            <span className="font-semibold text-slate-900">{totalPages}</span> · Total de{" "}
            <span className="font-semibold text-slate-900">{totalItems}</span> clientes
            {isApplyingFilters ? <span className="ml-2 text-slate-500">Atualizando...</span> : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page <= 1 || isApplyingFilters}
            >
              Anterior
            </button>
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={page >= totalPages || isApplyingFilters}
            >
              Próximo
            </button>
          </div>
        </div>
      ) : null}

      {isClientsPage && isImportModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="mb-4">
              <h3 className="text-xl font-semibold text-slate-900">Importar clientes (Excel)</h3>
              <p className="text-sm text-slate-500">Use um arquivo .xlsx para mapear, validar os dados e importar em lote.</p>
              <p className="mt-1 text-xs text-slate-500">
                Passo {importStep} de 2 · {importStep === 1 ? "Mapear colunas" : "Preview e validação"}
              </p>
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    void downloadImportTemplate().catch((error: Error) =>
                      toast.error(error.message || "Não foi possível baixar o modelo.")
                    )
                  }
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Baixar modelo .xlsx
                </button>
                <input
                  type="file"
                  accept=".xlsx"
                  onChange={handleImportFileChange}
                  className="block w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-brand-700 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-800"
                />
              </div>

              {importExcelHeaders.length > 0 && importStep === 1 ? (
                <ClientImportColumnMappingStep
                  fields={clientImportFieldDefinitions}
                  excelHeaders={importExcelHeaders}
                  mapping={importColumnMapping}
                  canMapOwnerSeller={canChooseOwnerSeller}
                  templateNames={Object.keys(importTemplates).sort((a, b) => a.localeCompare(b))}
                  selectedTemplateName={selectedImportTemplateName}
                  onChangeMapping={handleImportMappingChange}
                  onChangeTemplate={handleImportTemplateChange}
                  onSaveTemplate={handleSaveMapping}
                  onEditTemplate={handleEditTemplate}
                  onDeleteTemplate={handleDeleteTemplate}
                  onUseModelHeaders={handleUseModelHeaders}
                  onContinue={handleContinueAfterMapping}
                />
              ) : null}

              {importStep === 2 ? (
                <>
                  {!isSeller && canChooseOwnerSeller && !importColumnMapping.ownerSellerId ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <label className="block text-sm font-medium text-slate-700" htmlFor="import-default-owner">
                        Vendedor padrão para este lote *
                      </label>
                      <select
                        id="import-default-owner"
                        className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-slate-800"
                        value={importDefaultOwnerSellerId}
                        onChange={(event) => {
                          const selectedOwner = event.target.value;
                          setImportDefaultOwnerSellerId(selectedOwner);
                          if (importRawRows.length > 0) {
                            void runImportValidation(importRawRows, importColumnMapping, selectedOwner || undefined);
                          }
                        }}
                      >
                        <option value="">— Selecione —</option>
                        {users.map((seller) => (
                          <option key={seller.id} value={seller.id}>
                            {seller.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  {importSummary ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                      <p className="font-medium text-slate-900">Resumo da importação</p>
                      <p>
                        Total importado: <span className="font-semibold text-slate-900">{importSummary.imported}</span>
                      </p>
                      <p>
                        Ignorados por erro: <span className="font-semibold text-slate-900">{importSummary.ignoredByError}</span>
                      </p>
                      <p>
                        Falhas da API: <span className="font-semibold text-slate-900">{importSummary.apiFailures}</span>
                      </p>
                      <button
                        type="button"
                        onClick={downloadImportFinalReport}
                        className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        Baixar CSV final
                      </button>
                    </div>
                  ) : null}

                  {importValidationErrors.length > 0 ? (
                    <div className="max-h-32 overflow-y-auto rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                      {importValidationErrors.slice(0, 20).map((validationError) => (
                        <p key={validationError}>• {validationError}</p>
                      ))}
                      {importValidationErrors.length > 20 ? (
                        <p className="mt-1 text-xs">+{importValidationErrors.length - 20} erro(s) adicionais.</p>
                      ) : null}
                    </div>
                  ) : null}

                  <p className="text-sm text-slate-600">
                    Total linhas: <span className="font-semibold text-slate-900">{importCounters.totalAnalyzed}</span>
                    {" · "}
                    <span className="font-semibold text-emerald-700">{importCounters.validCount} válidas</span>
                    {" · "}
                    <span className="font-semibold text-amber-700">{importCounters.duplicateInFileCount} duplicadas no arquivo</span>
                    {" · "}
                    <span className="font-semibold text-orange-700">{importCounters.duplicateInSystemCount} já existentes no sistema</span>
                    {" · "}
                    <span className="font-semibold text-rose-700">{importCounters.errorCount} com erro</span>
                  </p>

                  {didRunLocalValidation ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                      <p className="font-medium text-slate-900">Resumo da validação local</p>
                      <p>Total linhas: {importCounters.totalAnalyzed}</p>
                      <p>Total válidas: {importCounters.validCount}</p>
                      <p>Total duplicadas no arquivo: {importCounters.duplicateInFileCount}</p>
                      <p>Total já existentes no sistema: {importCounters.duplicateInSystemCount}</p>
                      <p>Total com erro: {importCounters.errorCount}</p>
                    </div>
                  ) : null}

                  {isImporting ? (
                    <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800">
                      Importando {importProgress.current}/{importProgress.total}
                    </p>
                  ) : null}

                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full min-w-[980px] text-sm">
                      <thead className="bg-slate-100 text-left text-slate-700">
                        <tr>
                          {clientImportColumns.map((column) => (
                            <th key={column} className="px-3 py-2 font-medium">
                              {getImportColumnLabel(column)}
                            </th>
                          ))}
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Motivo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importPreviewRows.length > 0 ? (
                          importPreviewRows.slice(0, 200).map((row, index) => (
                            <tr key={`${row.name}-${index}`} className="border-t border-slate-200">
                              <td className="px-3 py-2">{row.name || "—"}</td>
                              <td className="px-3 py-2">{row.city || "—"}</td>
                              <td className="px-3 py-2">{row.state || "—"}</td>
                              <td className="px-3 py-2">{row.region || "—"}</td>
                              <td className="px-3 py-2">{row.potentialHa ?? "—"}</td>
                              <td className="px-3 py-2">{row.farmSizeHa ?? "—"}</td>
                              <td className="px-3 py-2">{row.clientType || "—"}</td>
                              <td className="px-3 py-2">{row.cnpj || "—"}</td>
                              <td className="px-3 py-2">{row.segment || "—"}</td>
                              <td className="px-3 py-2">{row.ownerSellerId || "—"}</td>

                              <td className="px-3 py-2">
                                {row.status === "new"
                                  ? "NOVO"
                                  : row.status === "duplicate_in_file"
                                    ? "DUPLICADO NO ARQUIVO"
                                    : row.status === "duplicate"
                                      ? "JÁ EXISTE NO SISTEMA"
                                      : "ERRO"}
                              </td>

                              <td className="px-3 py-2">
                                {row.status === "duplicate" ? (
                                  <div className="flex flex-col gap-2">
                                    <span className="text-orange-700">{row.errorMessage || "JÁ EXISTE NO SISTEMA"}</span>
                                    <select
                                      value={row.action || "skip"}
                                      onChange={(event) =>
                                        handleDuplicateActionChange(row.sourceRowNumber, event.target.value as ClientImportAction)
                                      }
                                      className="w-full rounded-md border border-slate-300 p-1 text-xs text-slate-800"
                                    >
                                      <option value="skip">PULAR</option>
                                      <option value="import_anyway">IMPORTAR MESMO ASSIM</option>
                                    </select>
                                  </div>
                                ) : row.status !== "new" ? (
                                  <span className="text-rose-700">{row.errorMessage || "Erro"}</span>
                                ) : (
                                  "OK"
                                )}
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={12} className="px-3 py-6 text-center text-slate-500">
                              Envie um arquivo para visualizar o preview.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {importPreviewRows.length > 200 ? (
                    <p className="text-xs text-slate-500">+{importPreviewRows.length - 200} linhas não exibidas no preview.</p>
                  ) : null}
                </>
              ) : null}
            </div>

            <div className="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={resetImportState}
                className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
                disabled={isImporting}
              >
                Cancelar
              </button>

              {importStep === 2 ? (
                <>
                  <button
                    type="button"
                    onClick={handleSimulateImport}
                    className="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={importRows.length === 0 || isImporting}
                  >
                    Validar sem importar
                  </button>
                  <button
                    type="button"
                    onClick={downloadPreviewValidationReport}
                    className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={importPreviewRows.length === 0 || isImporting}
                  >
                    Baixar relatório do preview (.csv)
                  </button>
                  <button
                    type="button"
                    onClick={handleImportClients}
                    className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!isImportReady || isImporting || importCounters.validCount === 0}
                  >
                    {isImporting ? `Importando ${importProgress.current}/${importProgress.total}` : `Importar ${importCounters.validCount} clientes válidos`}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {createInModal && isCreateModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-4xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="mb-4">
              <h3 className="text-xl font-semibold text-slate-900">{createModalTitle}</h3>
              <p className="text-sm text-slate-500">Preencha os dados para cadastrar um cliente.</p>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                {fields.map((f) => {
                  const isRequired = endpoint === "/clients" ? ["name", "city", "state", "clientType"].includes(f.key) : true;

                  const isOwnerSellerField = endpoint === "/clients" && f.key === "ownerSellerId";

                  if (isOwnerSellerField) {
                    const sellerOptions = canChooseOwnerSeller
                      ? users
                      : user?.id && user?.name
                        ? [{ id: user.id, name: user.name }]
                        : [];

                    const selectedOwnerSellerId = form.ownerSellerId ?? (isSeller && user?.id ? user.id : "");

                    return (
                      <div key={f.key} className="space-y-1 md:col-span-2">
                        <label className="block text-sm font-medium text-slate-700" htmlFor={`modal-${f.key}`}>
                          {f.label}
                        </label>
                        <select
                          id={`modal-${f.key}`}
                          className="w-full rounded-lg border border-slate-300 p-2 text-slate-800 disabled:bg-slate-100 disabled:text-slate-500"
                          value={selectedOwnerSellerId}
                          disabled={isSeller}
                          onChange={(e) => {
                            setFormError(null);
                            setFormFieldErrors((prev) => ({ ...prev, ownerSellerId: undefined }));
                            setForm({ ...form, ownerSellerId: e.target.value });
                          }}
                        >
                          {canChooseOwnerSeller ? <option value="">Selecione o vendedor responsável</option> : null}
                          {sellerOptions.map((seller) => (
                            <option key={seller.id} value={seller.id}>
                              {seller.name}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-slate-500">
                          {isSeller
                            ? "Este cliente será vinculado automaticamente ao seu usuário vendedor."
                            : "Defina o vendedor responsável para acompanhar este cliente."}
                        </p>
                        {formFieldErrors.ownerSellerId ? <p className="text-xs text-rose-600">{formFieldErrors.ownerSellerId}</p> : null}
                      </div>
                    );
                  }

                  return (
                    <div key={f.key} className="space-y-1">
                      <label className="block text-sm font-medium text-slate-700" htmlFor={`modal-${f.key}`}>
                        {f.label}
                      </label>

                      {f.type === "select" ? (
                        <select
                          id={`modal-${f.key}`}
                          required={isRequired}
                          className="w-full rounded-lg border border-slate-300 p-2 text-slate-800"
                          value={form[f.key] ?? ""}
                          onChange={(e) => {
                            setFormError(null);
                            setFormFieldErrors((prev) => ({ ...prev, [f.key]: undefined }));
                            setForm({ ...form, [f.key]: e.target.value });
                          }}
                        >
                          <option value="">Selecione {f.label.toLowerCase()}</option>
                          {(f.options ?? []).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={`modal-${f.key}`}
                          required={isRequired}
                          className="w-full rounded-lg border border-slate-300 p-2 text-slate-800"
                          type={f.type || "text"}
                          placeholder={f.placeholder ?? `Informe ${f.label.toLowerCase()}`}
                          value={form[f.key] ?? ""}
                          onChange={(e) => {
                            setFormError(null);
                            setFormFieldErrors((prev) => ({ ...prev, [f.key]: undefined }));
                            setForm({ ...form, [f.key]: parseFormValue(f.key, f.type, e.target.value) });
                          }}
                        />
                      )}

                      {formFieldErrors[f.key as keyof ClientPayloadInput] ? (
                        <p className="text-xs text-rose-600">{formFieldErrors[f.key as keyof ClientPayloadInput]}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {formError ? <p className="text-sm text-rose-600">{formError}</p> : null}

              <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
                <button
                  type="button"
                  onClick={closeCreateModal}
                  className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
                  disabled={saving}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-400 disabled:text-slate-100 disabled:opacity-100"
                  disabled={saving}
                >
                  {saving ? "Salvando..." : "Salvar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
