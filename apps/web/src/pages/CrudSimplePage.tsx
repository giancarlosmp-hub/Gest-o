import { ChangeEvent, FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useNavigate } from "react-router-dom";
import api from "../lib/apiClient";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import { validateClientPayload, type ClientPayloadInput } from "../lib/validateClientPayload";

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

type ClientImportErrorItem = {
  rowNumber: number;
  clientName: string;
  message: string;
};

type ClientImportSummary = {
  total: number;
  imported: number;
  errors: ClientImportErrorItem[];
};

type ImportValidationSummary = {
  errors: string[];
  validCount: number;
  errorCount: number;
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

const clientImportColumnLabels: Record<(typeof clientImportColumns)[number], string> = {
  name: "Nome",
  city: "Cidade",
  state: "UF",
  region: "Região",
  potentialHa: "Potencial (ha)",
  farmSizeHa: "Área total (ha)",
  clientType: "Tipo (PJ/PF)",
  cnpj: "CNPJ/CPF",
  segment: "Segmento",
  ownerSellerId: "Vendedor responsável"
};

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
  const [formFieldErrors, setFormFieldErrors] = useState<Partial<Record<keyof ClientPayloadInput, string>>>({});
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [quickFilters, setQuickFilters] = useState({ uf: "", region: "", clientType: "", ownerSellerId: "" });
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isApplyingFilters, setIsApplyingFilters] = useState(false);
  const [openActionsMenuId, setOpenActionsMenuId] = useState<string | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importRows, setImportRows] = useState<ClientImportRow[]>([]);
  const [importPreviewRows, setImportPreviewRows] = useState<ClientImportRow[]>([]);
  const [importValidationErrors, setImportValidationErrors] = useState<string[]>([]);
  const [importDefaultOwnerSellerId, setImportDefaultOwnerSellerId] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [isImportReady, setIsImportReady] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });
  const [importSummary, setImportSummary] = useState<ClientImportSummary | null>(null);

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
  }, [endpoint, isClientsPage, page, pageSize, debouncedSearch, quickFilters.uf, quickFilters.region, quickFilters.clientType, quickFilters.ownerSellerId, canFilterBySeller]);

  useEffect(() => {
    if (!isClientsPage || !canFilterBySeller) {
      setUsers([]);
      return;
    }

    api.get("/users")
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

  const filterOptions = useMemo(() => ({
    ufs: ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"],
    regions: ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"],
    clientTypes: ["PJ", "PF"]
  }), []);

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
  }, [debouncedSearch, quickFilters.uf, quickFilters.region, quickFilters.clientType, quickFilters.ownerSellerId, isClientsPage]);

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
        existingScript.addEventListener("error", () => reject(new Error("Não foi possível carregar a biblioteca Excel.")), { once: true });
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

  const normalizeHeader = (value: unknown) => String(value ?? "").trim().toLowerCase();

  const normalizeTextValue = (value: unknown) => String(value ?? "").trim();

  const parseDecimalValue = (value: unknown): { parsedValue: number | undefined; isInvalid: boolean } => {
    if (value === null || value === undefined) {
      return { parsedValue: undefined, isInvalid: false };
    }

    if (typeof value === "number") {
      return Number.isFinite(value)
        ? { parsedValue: value, isInvalid: false }
        : { parsedValue: undefined, isInvalid: true };
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
    return Number.isNaN(parsedValue)
      ? { parsedValue: undefined, isInvalid: true }
      : { parsedValue, isInvalid: false };
  };

  const parseImportFile = async (file: File) => {
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

    const headerMap = Object.keys(sheetRows[0] ?? {}).reduce<Record<string, string>>((acc, headerName) => {
      const normalizedHeader = normalizeHeader(headerName);
      if (normalizedHeader) {
        acc[normalizedHeader] = headerName;
      }
      return acc;
    }, {});

    const missingColumns = clientImportColumns.filter((columnName) => !headerMap[columnName]);
    if (missingColumns.length > 0) {
      throw new Error(`Colunas ausentes: ${missingColumns.join(", ")}.`);
    }

    const parsedRows: ClientImportRow[] = sheetRows
      .map((row, index) => {
        const potentialHaResult = parseDecimalValue(row[headerMap.potentialHa]);
        const farmSizeHaResult = parseDecimalValue(row[headerMap.farmSizeHa]);

        return {
          sourceRowNumber: index + 2,
          name: normalizeTextValue(row[headerMap.name]),
          city: normalizeTextValue(row[headerMap.city]),
          state: normalizeTextValue(row[headerMap.state]),
          region: normalizeTextValue(row[headerMap.region]),
          potentialHa: potentialHaResult.isInvalid ? Number.NaN : potentialHaResult.parsedValue,
          farmSizeHa: farmSizeHaResult.isInvalid ? Number.NaN : farmSizeHaResult.parsedValue,
          clientType: normalizeTextValue(row[headerMap.clientType]),
          cnpj: String(row[headerMap.cnpj] ?? "").trim(),
          segment: normalizeTextValue(row[headerMap.segment]),
          ownerSellerId: normalizeTextValue(row[headerMap.ownerSellerId])
        };
      })
      .filter((row) => [
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
      ].some((value) => value !== "" && value !== undefined));

    return parsedRows;
  };

  const validateImportRows = (rows: ClientImportRow[], defaultOwnerSellerId?: string): ImportValidationSummary => {
    const errors: string[] = [];
    let validCount = 0;

    if (rows.length === 0) {
      errors.push("Nenhuma linha de dados válida foi encontrada.");
      return { errors, validCount: 0, errorCount: 0 };
    }

    rows.forEach((row, index) => {
      const rowNumber = row.sourceRowNumber || index + 2;
      const payloadToValidate = {
        ...row,
        ownerSellerId: row.ownerSellerId || defaultOwnerSellerId
      };
      const { fieldErrors } = validateClientPayload(payloadToValidate, {
        isSeller,
        canChooseOwnerSeller,
        sellerId: user?.id
      });

      const rowErrors = Object.values(fieldErrors).filter((message): message is string => Boolean(message));
      if (rowErrors.length === 0) {
        validCount += 1;
        return;
      }

      rowErrors.forEach((message) => {
        errors.push(`Linha ${rowNumber}: ${message}`);
      });
    });

    return {
      errors,
      validCount,
      errorCount: rows.length - validCount
    };
  };

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    setImportRows([]);
    setImportPreviewRows([]);
    setImportValidationErrors([]);
    setImportDefaultOwnerSellerId("");
    setIsImportReady(false);
    setImportSummary(null);
    setImportProgress({ current: 0, total: 0 });

    if (!selectedFile) return;

    if (!selectedFile.name.toLowerCase().endsWith(".xlsx")) {
      toast.error("Selecione um arquivo no formato .xlsx.");
      return;
    }

    try {
      const rows = await parseImportFile(selectedFile);
      const validationSummary = validateImportRows(rows, importDefaultOwnerSellerId);
      const normalizedRows = rows;

      setImportRows(normalizedRows);
      setImportPreviewRows(normalizedRows.slice(0, 20));
      setImportValidationErrors(validationSummary.errors);
      setIsImportReady(validationSummary.errors.length === 0);

      if (validationSummary.errors.length > 0) {
        toast.error("Foram encontrados erros de validação na planilha.");
      } else {
        toast.success(`${normalizedRows.length} linha(s) carregada(s) com sucesso.`);
      }
    } catch (err: any) {
      setImportRows([]);
      setImportPreviewRows([]);
      setImportValidationErrors([err.message || "Erro ao ler arquivo."]);
      setIsImportReady(false);
      toast.error(err.message || "Não foi possível processar o arquivo.");
    }
  };

  const importValidationSummary = useMemo(
    () => validateImportRows(importRows, importDefaultOwnerSellerId),
    [importRows, importDefaultOwnerSellerId, isSeller, canChooseOwnerSeller, user?.id]
  );

  useEffect(() => {
    if (importRows.length === 0) {
      setImportValidationErrors([]);
      setIsImportReady(false);
      return;
    }

    setImportValidationErrors(importValidationSummary.errors);
    setIsImportReady(importValidationSummary.errors.length === 0);
  }, [importRows.length, importValidationSummary]);

  const resetImportState = () => {
    setIsImportModalOpen(false);
    setImportRows([]);
    setImportPreviewRows([]);
    setImportValidationErrors([]);
    setImportDefaultOwnerSellerId("");
    setIsImportReady(false);
    setImportProgress({ current: 0, total: 0 });
    setImportSummary(null);
  };

  const buildImportPayload = (row: ClientImportRow): Record<string, unknown> => {
    const payload = {
      ...row,
      ownerSellerId: row.ownerSellerId || importDefaultOwnerSellerId
    };
    const { sanitizedPayload } = validateClientPayload(payload, {
      isSeller,
      canChooseOwnerSeller,
      sellerId: user?.id
    });

    return sanitizedPayload;
  };

  const parseBulkImportSummary = (responseData: any, total: number): ClientImportSummary | null => {
    const imported = Number(responseData?.imported ?? responseData?.successCount ?? responseData?.created ?? responseData?.totalImported);
    const errorsRaw = Array.isArray(responseData?.errors) ? responseData.errors : [];

    if (!Number.isFinite(imported) && errorsRaw.length === 0) return null;

    const errors = errorsRaw.map((errorItem: any, index: number): ClientImportErrorItem => ({
      rowNumber: Number(errorItem?.rowNumber ?? errorItem?.row ?? index + 1) || index + 1,
      clientName: String(errorItem?.clientName ?? errorItem?.name ?? ""),
      message: String(errorItem?.message ?? "Erro ao importar linha.")
    }));

    return {
      total,
      imported: Number.isFinite(imported) ? imported : Math.max(0, total - errors.length),
      errors
    };
  };

  const runFallbackImport = async (payloads: Array<Record<string, unknown>>, rows: ClientImportRow[]) => {
    const errors: ClientImportErrorItem[] = [];
    const total = payloads.length;
    const chunkSize = 10;
    let imported = 0;

    for (let index = 0; index < payloads.length; index += chunkSize) {
      const chunkPayloads = payloads.slice(index, index + chunkSize);
      const chunkRows = rows.slice(index, index + chunkSize);

      const chunkResults = await Promise.all(chunkPayloads.map(async (payload, chunkIndex) => {
        const row = chunkRows[chunkIndex];
        try {
          await api.post("/clients", payload);
          return { ok: true as const, row };
        } catch (error: any) {
          return {
            ok: false as const,
            row,
            message: error?.response?.data?.message || "Erro ao importar cliente."
          };
        }
      }));

      chunkResults.forEach((result) => {
        if (result.ok) {
          imported += 1;
          return;
        }

        errors.push({
          rowNumber: result.row.sourceRowNumber,
          clientName: result.row.name,
          message: result.message
        });
      });

      setImportProgress({ current: Math.min(index + chunkResults.length, total), total });
    }

    return { total, imported, errors } satisfies ClientImportSummary;
  };

  const downloadImportErrorsReport = () => {
    if (!importSummary || importSummary.errors.length === 0) return;

    const header = "linha;cliente;erro";
    const rows = importSummary.errors.map((errorItem) => {
      const safeName = errorItem.clientName.replace(/\n/g, " ").replace(/;/g, ",");
      const safeMessage = errorItem.message.replace(/\n/g, " ").replace(/;/g, ",");
      return `${errorItem.rowNumber};${safeName};${safeMessage}`;
    });

    const csvContent = [header, ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `relatorio-erros-importacao-clientes-${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportClients = async () => {
    if (!isImportReady || importRows.length === 0 || importValidationSummary.errors.length > 0) return;

    setIsImporting(true);
    setImportSummary(null);
    setImportProgress({ current: 0, total: importRows.length });

    try {
      const payloads = importRows.map(buildImportPayload);
      let summary: ClientImportSummary | null = null;

      try {
        const bulkResponse = await api.post("/clients/import", {
          rows: payloads,
          clients: payloads
        });
        summary = parseBulkImportSummary(bulkResponse.data, payloads.length);
        setImportProgress({ current: payloads.length, total: payloads.length });
      } catch (bulkError: any) {
        const status = Number(bulkError?.response?.status);
        const shouldFallback = [404, 405, 501].includes(status);

        if (!shouldFallback) throw bulkError;

        summary = await runFallbackImport(payloads, importRows);
      }

      const resolvedSummary = summary ?? { total: payloads.length, imported: payloads.length, errors: [] };
      setImportSummary(resolvedSummary);

      if (resolvedSummary.errors.length === 0) {
        toast.success(`Importação concluída: ${resolvedSummary.imported} cliente(s) importado(s).`);
        resetImportState();
        await loadClients();
        return;
      }

      toast.warning(`Importação finalizada com pendências: ${resolvedSummary.imported} importado(s), ${resolvedSummary.errors.length} com erro.`);
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
      } catch (e: any) {
        toast.error(e.response?.data?.message || "Erro ao salvar");
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
          if (!payload.ownerSellerId) {
            delete payload.ownerSellerId;
          }
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
    } catch (e: any) {
      toast.error(e.response?.data?.message || "Erro ao salvar");
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

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-slate-900">{title}</h2>

      {!readOnly && !createInModal && (
        <form onSubmit={submit} className="grid gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-3">
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
                    <option key={option.value} value={option.value}>{option.label}</option>
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
          <button disabled={saving} className="rounded-lg bg-brand-700 px-3 py-2 font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60">{saving ? "Salvando..." : editing ? "Atualizar" : "Criar"}</button>
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
          <button type="button" onClick={openCreateModal} className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800">
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
              {filterOptions.ufs.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
            </select>
            <select
              className="rounded-lg border border-slate-300 px-3 py-2"
              value={quickFilters.region}
              onChange={(e) => setQuickFilters((prev) => ({ ...prev, region: e.target.value }))}
            >
              <option value="">Região (todas)</option>
              {filterOptions.regions.map((region) => <option key={region} value={region}>{region}</option>)}
            </select>
            <select
              className="rounded-lg border border-slate-300 px-3 py-2"
              value={quickFilters.clientType}
              onChange={(e) => setQuickFilters((prev) => ({ ...prev, clientType: e.target.value }))}
            >
              <option value="">Tipo (todos)</option>
              {filterOptions.clientTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            {canFilterBySeller ? (
              <select
                className="rounded-lg border border-slate-300 px-3 py-2"
                value={quickFilters.ownerSellerId}
                onChange={(e) => setQuickFilters((prev) => ({ ...prev, ownerSellerId: e.target.value }))}
              >
                <option value="">Vendedor (todos)</option>
                {users.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
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
            <button type="button" className="rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-medium" onClick={() => (isClientsPage ? void loadClients() : void load())}>Tentar novamente</button>
          </div>
        ) : null}
        {!loading && !error ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-brand-50 text-brand-800">
                {fields.map((f) => (
                  <th className="p-2 text-left" key={f.key}>{f.label}</th>
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
                  {fields.map((f) => <td key={f.key} className="p-2 text-slate-700">{getCellValue(it, f.key)}</td>)}
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
                              onClick={() => setOpenActionsMenuId((current) => current === it.id ? null : it.id)}
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
                  <td colSpan={fields.length + (detailsPath || !readOnly ? 1 : 0)} className="p-8 text-center text-slate-500">
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
            Página <span className="font-semibold text-slate-900">{page}</span> de <span className="font-semibold text-slate-900">{totalPages}</span> · Total de <span className="font-semibold text-slate-900">{totalItems}</span> clientes
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
              <p className="text-sm text-slate-500">Use um arquivo .xlsx para validar os dados e importar em lote.</p>
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void downloadImportTemplate().catch((error: Error) => toast.error(error.message || "Não foi possível baixar o modelo."))}
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

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900">Colunas obrigatórias no arquivo:</p>
                <p>Nome, Cidade, UF, Tipo (PJ/PF)</p>
                <p className="mt-2 font-medium text-slate-900">Regras:</p>
                <p className="mt-1 text-xs text-slate-600">UF deve conter 2 letras (ex: PR)</p>
                <p className="mt-1 text-xs text-slate-600">Tipo deve ser PJ ou PF</p>
                <p className="mt-1 text-xs text-slate-600">Para usuário vendedor, o vendedor da planilha será ignorado</p>
                <p className="mt-1 text-xs text-slate-600">Diretor/Gerente pode informar vendedor responsável</p>
                <p className="mt-1 text-xs text-slate-600">Potencial e Área total devem ser números positivos</p>
              </div>

              {canChooseOwnerSeller ? (
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="import-default-owner-seller">
                    Vendedor padrão para linhas sem vendedor informado
                  </label>
                  <select
                    id="import-default-owner-seller"
                    className="w-full rounded-lg border border-slate-300 p-2 text-slate-800"
                    value={importDefaultOwnerSellerId}
                    onChange={(event) => setImportDefaultOwnerSellerId(event.target.value)}
                  >
                    <option value="">Selecione um vendedor</option>
                    {users.map((seller) => (
                      <option key={seller.id} value={seller.id}>{seller.name}</option>
                    ))}
                  </select>
                </div>
              ) : null}

              <p className="text-sm text-slate-600">
                <span className="font-semibold text-emerald-700">{importValidationSummary.validCount} válidos</span>
                {" · "}
                <span className="font-semibold text-rose-700">{importValidationSummary.errorCount} com erro</span>
              </p>

              {isImporting ? (
                <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800">
                  Importando {importProgress.current}/{importProgress.total}...
                </p>
              ) : null}

              {importSummary ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  <p className="font-medium text-slate-900">Resumo da importação</p>
                  <p>Total importado: <span className="font-semibold text-slate-900">{importSummary.imported}</span></p>
                  <p>Total com erro: <span className="font-semibold text-slate-900">{importSummary.errors.length}</span></p>
                  {importSummary.errors.length > 0 ? (
                    <button
                      type="button"
                      onClick={downloadImportErrorsReport}
                      className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      Baixar relatório de erros
                    </button>
                  ) : null}
                </div>
              ) : null}

              {importValidationErrors.length > 0 ? (
                <div className="max-h-32 overflow-y-auto rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                  {importValidationErrors.map((validationError) => (
                    <p key={validationError}>• {validationError}</p>
                  ))}
                </div>
              ) : null}

              <p className="text-sm text-slate-600">
                Total de linhas carregadas: <span className="font-semibold text-slate-900">{importRows.length}</span> · Preview exibindo até 20 linhas.
              </p>

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="bg-slate-100 text-left text-slate-700">
                    <tr>
                      {clientImportColumns.map((column) => (
                        <th key={column} className="px-3 py-2 font-medium">{clientImportColumnLabels[column]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {importPreviewRows.length > 0 ? importPreviewRows.map((row, index) => (
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
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={10} className="px-3 py-6 text-center text-slate-500">Envie um arquivo para visualizar até 20 linhas de preview.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={() => {
                  resetImportState();
                }}
                className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
                disabled={isImporting}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleImportClients}
                className="rounded-lg px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400 disabled:text-slate-100 disabled:opacity-100 bg-emerald-600 hover:bg-emerald-700"
                disabled={!isImportReady || isImporting}
              >
                {isImporting ? "Importando..." : "Validar e importar"}
              </button>
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
                  const isRequired = endpoint === "/clients"
                    ? ["name", "city", "state", "clientType"].includes(f.key)
                    : true;
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
                        <label className="block text-sm font-medium text-slate-700" htmlFor={`modal-${f.key}`}>{f.label}</label>
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
                          {sellerOptions.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
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
                      <label className="block text-sm font-medium text-slate-700" htmlFor={`modal-${f.key}`}>{f.label}</label>
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
                            <option key={option.value} value={option.value}>{option.label}</option>
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
                      {formFieldErrors[f.key as keyof ClientPayloadInput] ? <p className="text-xs text-rose-600">{formFieldErrors[f.key as keyof ClientPayloadInput]}</p> : null}
                    </div>
                  );
                })}
              </div>

              {formError ? <p className="text-sm text-rose-600">{formError}</p> : null}

              <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
                <button type="button" onClick={closeCreateModal} className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100" disabled={saving}>
                  Cancelar
                </button>
                <button type="submit" className="rounded-lg px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400 disabled:text-slate-100 disabled:opacity-100 bg-emerald-600 hover:bg-emerald-700" disabled={saving}>
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
