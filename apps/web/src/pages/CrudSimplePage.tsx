import { ChangeEvent, FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useNavigate } from "react-router-dom";
import api from "../lib/apiClient";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import { validateClientPayload, type ClientPayloadInput } from "../lib/validateClientPayload";
import { formatCnpj, normalizeCnpjDigits } from "../lib/cnpj";
import { loadXlsxLibrary, normalizeHeader, normalizeTextValue, parseDecimalValue, parseImportFile } from "../lib/import/parsers";
import {
  ImportColumnMappingStep,
  type ClientImportFieldDefinition,
  type ClientImportFieldKey
} from "../components/ClientImportColumnMappingStep";
import QuickCreateClientSection from "../components/clients/QuickCreateClientSection";
import { buildDuplicateClientMessage, checkClientDuplicate } from "../lib/clientDuplicateCheck";

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
  fantasyName?: string;
  code?: string;
  city?: string;
  state?: string;
  region?: string;
  potentialHa?: number;
  farmSizeHa?: number;
  clientType?: string;
  cnpj?: string;
  segment?: string;
  ownerSellerId?: string;
  ownerSellerName?: string;
  ownerSellerLookupError?: string;
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
  ignoredByValidation: number;
  alreadyExisting: number;
  duplicates: number;
  apiFailures: number;
  updated: number;
};

type ClientImportFinalReportRow = {
  rowNumber: number;
  status: "IMPORTADO" | "ATUALIZADO" | "IGNORADO" | "ERRO_VALIDACAO" | "JA_EXISTENTE" | "DUPLICADO" | "FALHA_API";
  reason: string;
  createdId: string;
};

type ImportApiResultItem = {
  rowNumber: number;
  clientName: string;
  status: "IMPORTED" | "UPDATED" | "IGNORED" | "API_FAILURE";
  category: "imported" | "updated" | "ignored" | "duplicate" | "validation" | "api_error";
  reason: string;
  createdId?: string;
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

type CnpjLookupResponse = {
  data?: {
    cnpj?: string | null;
    razaoSocial?: string | null;
    nome?: string | null;
    nomeFantasia?: string | null;
    cidade?: string | null;
    uf?: string | null;
    cep?: string | null;
    logradouro?: string | null;
    bairro?: string | null;
  };
  meta?: {
    provider?: string;
    normalizedCnpj?: string;
  };
};

type ImportValidationSummary = {
  errors: string[];
  rowResults: ImportAnalysisRow[];
  validCount: number;
  errorCount: number;
  duplicateInFileCount: number;
};

const clientImportColumns = [
  "name",
  "fantasyName",
  "code",
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

const clientImportTemplateColumns = [
  "nome",
  "fantasy_name",
  "code",
  "cidade",
  "uf",
  "regiao",
  "potencial_ha",
  "area_total_ha",
  "tipo_cliente",
  "cnpj_cpf",
  "segmento",
  "vendedor_responsavel"
] as const;

const importMappingStorageKey = "clientsImport.columnMapping.v1";
const importTemplatesStorageKey = "clientsImport.templates.v1";

const clientImportFieldDefinitions: ClientImportFieldDefinition[] = [
  { key: "name", label: "nome", required: true },
  { key: "fantasyName", label: "fantasy_name", required: false },
  { key: "code", label: "code", required: false },
  { key: "city", label: "cidade", required: true },
  { key: "state", label: "uf", required: true },
  { key: "clientType", label: "tipo_cliente", required: true },
  { key: "region", label: "regiao", required: false },
  { key: "potentialHa", label: "potencial_ha", required: false },
  { key: "farmSizeHa", label: "area_total_ha", required: false },
  { key: "cnpj", label: "cnpj_cpf", required: false },
  { key: "segment", label: "segmento", required: false },
  { key: "ownerSellerId", label: "vendedor_responsavel", required: false }
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
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
    if (fieldKey === "cnpj") {
      const digits = normalizeCnpjDigits(rawValue);
      return digits.length <= 14 ? formatCnpj(digits) : rawValue;
    }
    return rawValue;
  };

  const updateClientForm = (fieldKey: string, fieldType: string | undefined, rawValue: string) => {
    setForm((currentForm: ClientPayloadInput) => ({
      ...currentForm,
      [fieldKey]: parseFormValue(fieldKey, fieldType, rawValue)
    }));
  };

  const downloadImportTemplate = async () => {
    const worksheetData: Array<Array<string | number>> = [
      [...clientImportTemplateColumns],
      ["Fazenda Santa Rita", "Santa Rita Agro", "ERP-000123", "Sorriso", "MT", "Centro-Oeste", 1200, 2500, "PJ", "12.345.678/0001-99", "Soja e milho", "Ana Souza"]
    ];

    const xlsx = await loadXlsxLibrary();
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.aoa_to_sheet(worksheetData);
    xlsx.utils.book_append_sheet(workbook, worksheet, "clientes");
    xlsx.writeFile(workbook, "modelo-importacao-clientes.xlsx");
    toast.success("Modelo de importação baixado com sucesso.");
  };

  const autoMapColumns = (headers: string[]) => {
    const synonyms: Record<ClientImportFieldKey, string[]> = {
      name: ["name", "nome", "cliente", "razaosocial", "produtor", "nomedocliente"],
      fantasyName: ["fantasyname", "fantasy_name", "nomefantasia", "nome_fantasia"],
      code: ["code", "codigo", "codcliente", "codigocliente", "codigoerp", "erpcode", "codigo_cliente", "codigo_cliente_erp"],
      city: ["city", "cidade", "municipio"],
      state: ["state", "uf", "estado"],
      clientType: ["clienttype", "tipo", "pjpf", "pessoa", "tipocliente"],
      region: ["region", "regiao"],
      potentialHa: ["potentialha", "potencial", "hapotencial", "potencialha"],
      farmSizeHa: ["farmsizeha", "area", "tamanho", "hatotal", "areatotal", "areatotalha"],
      cnpj: ["cnpj", "cpf", "cnpjcpf", "documento", "cnpj_cpf"],
      segment: ["segment", "segmento", "atividade", "perfil"],
      ownerSellerId: ["ownersellerid", "vendedor", "responsavel", "vendedorresponsavel", "idseller", "vendedorresponsavelid", "vendedor_responsavel_id"]
    };

    const normalizedHeaders = headers.map((header) => ({ header, normalized: normalizeHeader(header) }));
    const mapping: Partial<Record<ClientImportFieldKey, string>> = {};

    clientImportFieldDefinitions.forEach((field) => {
      const normalizedFieldLabel = normalizeHeader(field.label);
      const expected = normalizeHeader(field.key);
      const candidates = normalizedHeaders.filter((item) => {
        if (!item.normalized) return false;
        if (item.normalized === expected) return true;
        if (item.normalized === normalizedFieldLabel) return true;
        return synonyms[field.key].some(
          (synonym) => item.normalized.includes(synonym) || synonym.includes(item.normalized)
        );
      });

      if (candidates.length === 0) return;

      const exactLabelMatch = candidates.find((item) => item.normalized === normalizedFieldLabel);
      if (exactLabelMatch) {
        mapping[field.key] = exactLabelMatch.header;
        return;
      }

      const exactKeyMatch = candidates.find((item) => item.normalized === expected);
      if (exactKeyMatch) {
        mapping[field.key] = exactKeyMatch.header;
        return;
      }

      mapping[field.key] = candidates[0].header;
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

    const normalizeSellerName = (value?: string) =>
      String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

    const sellersByName = users.reduce<Map<string, { id: string; name: string }>>((acc, seller) => {
      const normalized = normalizeSellerName(seller.name);
      if (!normalized || acc.has(normalized)) return acc;
      acc.set(normalized, { id: seller.id, name: seller.name });
      return acc;
    }, new Map());

    const sellersById = users.reduce<Map<string, { id: string; name: string }>>((acc, seller) => {
      const normalized = normalizeTextValue(seller.id);
      if (!normalized) return acc;
      acc.set(normalized, { id: seller.id, name: seller.name });
      return acc;
    }, new Map());

    const rawOwnerSeller = mapping.ownerSellerId ? normalizeTextValue(row[mapping.ownerSellerId]) : "";

    let resolvedOwnerSellerId = "";
    let resolvedOwnerSellerName = "";
    let ownerSellerLookupError = "";

    if (isSeller && user?.id) {
      resolvedOwnerSellerId = user.id;
      resolvedOwnerSellerName = user.name || "";
    } else if (rawOwnerSeller) {
      const byId = sellersById.get(rawOwnerSeller);
      if (byId) {
        resolvedOwnerSellerId = byId.id;
        resolvedOwnerSellerName = byId.name;
      } else {
        const byName = sellersByName.get(normalizeSellerName(rawOwnerSeller));
        if (byName) {
          resolvedOwnerSellerId = byName.id;
          resolvedOwnerSellerName = byName.name;
        } else {
          ownerSellerLookupError = "Vendedor responsável não encontrado";
        }
      }
    } else if (defaultOwnerSellerId) {
      resolvedOwnerSellerId = defaultOwnerSellerId;
      resolvedOwnerSellerName = users.find((seller) => seller.id === defaultOwnerSellerId)?.name || "";
    }

    return {
      sourceRowNumber: rowIndex + 2,
      name: mapping.name ? normalizeTextValue(row[mapping.name]) : "",
      fantasyName: mapping.fantasyName ? normalizeTextValue(row[mapping.fantasyName]) : "",
      code: mapping.code ? normalizeTextValue(row[mapping.code]) : "",
      city: mapping.city ? normalizeTextValue(row[mapping.city]) : "",
      state: mapping.state ? normalizeTextValue(row[mapping.state]) : "",
      region: mapping.region ? normalizeTextValue(row[mapping.region]) : "",
      potentialHa: potentialHaResult.isInvalid ? Number.NaN : potentialHaResult.parsedValue,
      farmSizeHa: farmSizeHaResult.isInvalid ? Number.NaN : farmSizeHaResult.parsedValue,
      clientType: mapping.clientType ? normalizeTextValue(row[mapping.clientType]) : "",
      cnpj: mapping.cnpj ? normalizeTextValue(row[mapping.cnpj]) : "",
      segment: mapping.segment ? normalizeTextValue(row[mapping.segment]) : "",
      ownerSellerId: resolvedOwnerSellerId ? normalizeTextValue(resolvedOwnerSellerId) : "",
      ownerSellerName: resolvedOwnerSellerName,
      ownerSellerLookupError
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
          row.fantasyName,
          row.code,
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

  const validateImportRows = (
    rows: ClientImportRow[],
    mapping: Partial<Record<ClientImportFieldKey, string>>,
    defaultOwnerSellerId?: string
  ): ImportValidationSummary => {
    const errors: string[] = [];
    const rowResults: ImportAnalysisRow[] = [];
    let validCount = 0;
    let duplicateInFileCount = 0;
    const duplicateKeyToRows = new Map<string, number[]>();

    if (rows.length === 0) {
      errors.push("Nenhuma linha de dados válida foi encontrada.");
      return { errors, rowResults, validCount: 0, errorCount: 0, duplicateInFileCount: 0 };
    }

    const hasOwnerSellerMapping = Boolean(mapping.ownerSellerId);
    const hasAnyOwnerSellerValueInRows = rows.some((row) => Boolean(row.ownerSellerId) || Boolean(row.ownerSellerLookupError));

    if (
      !isSeller &&
      canChooseOwnerSeller &&
      !defaultOwnerSellerId &&
      (!hasOwnerSellerMapping || !hasAnyOwnerSellerValueInRows)
    ) {
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
      if (row.ownerSellerLookupError) {
        rowErrors.push(row.ownerSellerLookupError);
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
    const validation = validateImportRows(mappedRows, mapping, defaultOwnerSellerId);

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
    importResultsByRow: Map<number, ImportApiResultItem>
  ): ClientImportFinalReportRow[] => {
    return previewRows
      .map((row) => {
        if (row.status === "error") {
          return {
            rowNumber: row.sourceRowNumber,
            status: "ERRO_VALIDACAO" as const,
            reason: row.errorMessage || "Linha inválida no preview.",
            createdId: ""
          };
        }

        if (row.status === "duplicate_in_file") {
          return {
            rowNumber: row.sourceRowNumber,
            status: "DUPLICADO" as const,
            reason: row.errorMessage || "Cliente duplicado no arquivo.",
            createdId: ""
          };
        }

        if (row.status === "duplicate" && (row.action || "skip") === "skip") {
          return {
            rowNumber: row.sourceRowNumber,
            status: "JA_EXISTENTE" as const,
            reason: row.errorMessage || "Cliente já existente no sistema.",
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

        if (importResult.status === "API_FAILURE") {
          const failureStatus: ClientImportFinalReportRow["status"] =
            importResult.category === "duplicate" ? "DUPLICADO" : "FALHA_API";

          return {
            rowNumber: row.sourceRowNumber,
            status: failureStatus,
            reason: importResult.reason,
            createdId: ""
          };
        }

        const finalStatus: ClientImportFinalReportRow["status"] =
          importResult.status === "UPDATED" ? "ATUALIZADO" : importResult.status === "IGNORED" ? "IGNORADO" : "IMPORTADO";

        return {
          rowNumber: row.sourceRowNumber,
          status: finalStatus,
          reason: importResult.reason,
          createdId: importResult.createdId || ""
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

  const buildImportRequestRow = (row: ImportAnalysisRow): Record<string, unknown> => {
    const sanitizedPayload = buildImportPayload(row);

    return {
      ...sanitizedPayload,
      sourceRowNumber: row.sourceRowNumber,
      existingClientId: row.existingClientId,
      action: row.action
    };
  };

  const importValidRowsInBatches = async (validRows: ImportAnalysisRow[]) => {
    const batchSize = 50;
    let imported = 0;
    let updated = 0;
    let apiFailures = 0;
    const resultsByRow = new Map<number, ImportApiResultItem>();

    for (let index = 0; index < validRows.length; index += batchSize) {
      const batchRows = validRows.slice(index, index + batchSize);

      try {
        if (import.meta.env.DEV) {
          console.debug("[clients-import] payload batch", {
            rowCount: batchRows.length,
            rows: batchRows.map((row) => buildImportRequestRow(row))
          });
        }

        const response = await api.post<{
          totalImportados?: number;
          totalAtualizados?: number;
          totalErros?: number;
          errors?: ClientImportErrorItem[];
          results?: ImportApiResultItem[];
        }>(
          "/clients/import",
          {
            rows: batchRows.map((row) => buildImportRequestRow(row))
          },
          { timeout: 30000 }
        );

        imported += Number(response.data?.totalImportados ?? 0);
        updated += Number(response.data?.totalAtualizados ?? 0);
        apiFailures += Number(response.data?.totalErros ?? 0);

        (response.data?.results ?? []).forEach((result) => {
          resultsByRow.set(result.rowNumber, result);
        });

        (response.data?.errors ?? []).forEach((error) => {
          if (resultsByRow.has(error.rowNumber)) return;
          resultsByRow.set(error.rowNumber, {
            rowNumber: error.rowNumber,
            clientName: error.clientName,
            status: "API_FAILURE",
            category: "validation",
            reason: error.message,
            createdId: ""
          });
        });
      } catch (error: any) {
        const fallbackReason = error?.response?.data?.message || "Falha ao importar lote de clientes na API.";
        if (import.meta.env.DEV) {
          console.error("[clients-import] erro ao enviar batch", {
            reason: fallbackReason,
            batchRows: batchRows.map((row) => buildImportRequestRow(row))
          });
        }
        apiFailures += batchRows.length;
        batchRows.forEach((row) => {
          resultsByRow.set(row.sourceRowNumber, {
            rowNumber: row.sourceRowNumber,
            clientName: row.name,
            status: "API_FAILURE",
            category: "api_error",
            reason: fallbackReason,
            createdId: ""
          });
        });
      }

      setImportProgress({ current: Math.min(index + batchRows.length, validRows.length), total: validRows.length });
    }

    return {
      imported,
      updated,
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
      const { imported, updated, apiFailures, resultsByRow } = await importValidRowsInBatches(validRows);
      const ignoredByValidation = importPreviewRows.filter((row) => row.status === "error").length;
      const alreadyExisting = importPreviewRows.filter((row) => row.status === "duplicate" && (row.action || "skip") === "skip").length;
      const duplicates = importPreviewRows.filter((row) => row.status === "duplicate_in_file").length;
      const resolvedSummary: ClientImportSummary = {
        total: importPreviewRows.length,
        imported,
        ignoredByValidation,
        alreadyExisting,
        duplicates,
        apiFailures,
        updated
      };

      const reportRows = buildImportFinalReportRows(importPreviewRows, resultsByRow);

      setImportSummary(resolvedSummary);
      setImportFinalReportRows(reportRows);

      const mainFailure = reportRows.find((row) => row.status === "FALHA_API" || row.status === "DUPLICADO")?.reason;
      const summaryText = `Importação concluída: ${imported} importado(s), ${updated} atualizado(s), ${ignoredByValidation} ignorado(s) por validação, ${alreadyExisting} já existente(s), ${duplicates} duplicado(s) e ${apiFailures} falha(s) de API.`;

      if (apiFailures > 0) toast.warning(mainFailure ? `${summaryText} Motivo principal: ${mainFailure}` : summaryText);
      else toast.success(summaryText);

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
        if (String(sanitizedPayload.cnpj || "").trim()) {
          const duplicateCheck = await checkClientDuplicate({
            name: typeof sanitizedPayload.name === "string" ? sanitizedPayload.name : undefined,
            city: typeof sanitizedPayload.city === "string" ? sanitizedPayload.city : undefined,
            state: typeof sanitizedPayload.state === "string" ? sanitizedPayload.state : undefined,
            cnpj: typeof sanitizedPayload.cnpj === "string" ? sanitizedPayload.cnpj : undefined,
            ignoreClientId: editing || undefined
          });

          if (duplicateCheck.exists) {
            const duplicateMessage = buildDuplicateClientMessage(duplicateCheck);
            setFormFieldErrors((currentErrors) => ({ ...currentErrors, cnpj: duplicateMessage }));
            setFormError(duplicateMessage);
            toast.error(duplicateMessage);
            return;
          }
        }

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

      if (endpoint === "/users") {
        payload.name = String(payload.name || "").trim();
        payload.email = String(payload.email || "").trim();

        if (typeof payload.password === "string") {
          const trimmedPassword = payload.password.trim();
          if (!trimmedPassword) delete payload.password;
          else payload.password = trimmedPassword;
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
    const nextForm = endpoint === "/users" ? { ...item, password: "" } : item;

    if (createInModal) {
      setEditing(item.id);
      setForm(nextForm);
      setIsCreateModalOpen(true);
      return;
    }
    setEditing(item.id);
    setForm(nextForm);
  };

  const handleClientCreatedViaCnpj = async (client: { id: string; name: string; city?: string | null; state?: string | null; cnpj?: string | null }) => {
    closeCreateModal();
    await loadClients();
    setSearch(client.name);
  };

  const handleSelectExistingClientViaCnpj = async (client: { id: string; name: string; city?: string | null; state?: string | null; cnpj?: string | null }) => {
    const existingItem = items.find((item) => String(item.id) === client.id);
    if (existingItem) {
      onEdit(existingItem);
      return;
    }

    closeCreateModal();
    setSearch(client.name);
    toast.info("Cliente já existente localizado. Filtramos a lista para facilitar a conferência.");
  };

  const onDelete = async (id: string) => {
    const userConfirmed = window.confirm("Tem certeza que deseja excluir este registro?");
    if (!userConfirmed) return;

    setDeletingId(id);
    try {
      await api.delete(`${endpoint}/${id}`);
      toast.success("Registro excluído com sucesso.");
      if (isClientsPage) await loadClients();
      else await load();
    } catch (err: any) {
      toast.error(err.response?.data?.message || "Não foi possível excluir o registro.");
    } finally {
      setDeletingId(null);
    }
  };

  const onOpenDetails = (id: string) => {
    if (!detailsPath) return;
    navigate(`${detailsPath}/${id}`);
  };

  const onRowClick = (event: MouseEvent<HTMLElement>, id: string) => {
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
            const isPasswordOptionalOnUserEdit = endpoint === "/users" && f.key === "password" && Boolean(editing);
            const isFieldRequired = !isPasswordOptionalOnUserEdit;

            if (f.type === "select") {
              return (
                <select
                  key={f.key}
                  required={isFieldRequired}
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
                required={isFieldRequired}
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

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
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
          <>
            {isClientsPage ? (
              <div className="space-y-3 p-3 md:hidden">
                {visibleItems.map((it) => (
                  <article
                    key={it.id}
                    className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                    onClick={(event) => onRowClick(event, it.id)}
                  >
                    <h3 className="text-base font-semibold text-slate-900">{String(getCellValue(it, "name") || "-")}</h3>
                    <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <dt className="text-slate-500">Cidade</dt>
                        <dd className="font-medium text-slate-800">{String(getCellValue(it, "city") || "-")}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">UF</dt>
                        <dd className="font-medium text-slate-800">{String(getCellValue(it, "state") || "-")}</dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-slate-500">Região</dt>
                        <dd className="font-medium text-slate-800">{String(getCellValue(it, "region") || "-")}</dd>
                      </div>
                    </dl>
                    {(detailsPath || !readOnly) && (
                      <div className="mt-4 flex items-center justify-end gap-2" data-row-action-menu="true">
                        {detailsPath ? (
                          <button
                            type="button"
                            className="rounded-md border border-brand-200 px-2.5 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50"
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
                              disabled={saving || deletingId === it.id}
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
                                  disabled={saving || deletingId === it.id}
                                >
                                  Excluir
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </article>
                ))}

                {visibleItems.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500">
                    Nenhum registro encontrado com os filtros atuais.
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className={isClientsPage ? "hidden overflow-auto md:block" : "overflow-auto"}>
              <table className="min-w-[600px] w-full text-sm">
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
                                  disabled={saving || deletingId === it.id}
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
                                      disabled={saving || deletingId === it.id}
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
            </div>
          </>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-3 md:p-4" role="dialog" aria-modal="true">
          <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="shrink-0 border-b border-slate-200 px-5 py-4 md:px-6">
              <h3 className="text-xl font-semibold text-slate-900">Importar clientes (Excel)</h3>
              <p className="text-sm text-slate-500">Use um arquivo .xlsx para mapear, validar os dados e importar em lote.</p>
              <p className="mt-1 text-xs text-slate-500">
                Passo {importStep} de 2 · {importStep === 1 ? "Mapear colunas" : "Preview e validação"}
              </p>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-3 md:px-6 md:py-4">
              <div className="shrink-0 pb-2">
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
                  className="block w-full max-w-md rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-brand-700 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-800"
                />
                </div>
              </div>

              {importExcelHeaders.length > 0 && importStep === 1 ? (
                <ImportColumnMappingStep
                  fields={clientImportFieldDefinitions}
                  excelHeaders={importExcelHeaders}
                  mapping={importColumnMapping}
                  hiddenFieldKeys={canChooseOwnerSeller ? [] : ["ownerSellerId"]}
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
                <div className="flex min-h-0 flex-1 flex-col gap-2.5">
                  {!isSeller && canChooseOwnerSeller && !importColumnMapping.ownerSellerId ? (
                    <div className="shrink-0 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
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
                    <div className="shrink-0 rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-sm text-slate-700">
                      <p className="font-medium text-slate-900">Resumo da importação</p>
                      <div className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                        <p>
                          Total importado: <span className="font-semibold text-slate-900">{importSummary.imported}</span>
                        </p>
                        <p>
                          Total atualizado: <span className="font-semibold text-slate-900">{importSummary.updated}</span>
                        </p>
                        <p>
                          Ignorados por validação: <span className="font-semibold text-slate-900">{importSummary.ignoredByValidation}</span>
                        </p>
                        <p>
                          Já existentes: <span className="font-semibold text-slate-900">{importSummary.alreadyExisting}</span>
                        </p>
                        <p>
                          Duplicados: <span className="font-semibold text-slate-900">{importSummary.duplicates}</span>
                        </p>
                        <p>
                          Falhas da API: <span className="font-semibold text-slate-900">{importSummary.apiFailures}</span>
                        </p>
                      </div>
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
                    <div className="shrink-0 max-h-24 overflow-y-auto rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                      {importValidationErrors.slice(0, 20).map((validationError) => (
                        <p key={validationError}>• {validationError}</p>
                      ))}
                      {importValidationErrors.length > 20 ? (
                        <p className="mt-1 text-xs">+{importValidationErrors.length - 20} erro(s) adicionais.</p>
                      ) : null}
                    </div>
                  ) : null}

                  <p className="shrink-0 text-sm text-slate-600">
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
                    <div className="shrink-0 rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-sm text-slate-700">
                      <p className="font-medium text-slate-900">Resumo da validação local</p>
                      <div className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                        <p>Total linhas: {importCounters.totalAnalyzed}</p>
                        <p>Total válidas: {importCounters.validCount}</p>
                        <p>Total duplicadas no arquivo: {importCounters.duplicateInFileCount}</p>
                        <p>Total já existentes no sistema: {importCounters.duplicateInSystemCount}</p>
                        <p>Total com erro: {importCounters.errorCount}</p>
                      </div>
                    </div>
                  ) : null}

                  {isImporting ? (
                    <p className="shrink-0 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800">
                      Importando {importProgress.current}/{importProgress.total}
                    </p>
                  ) : null}

                  <div className="preview-table-container min-h-0 flex-1 overflow-x-auto overflow-y-auto rounded-xl border border-slate-200">
                    <table className="w-full min-w-[980px] text-sm">
                      <thead className="sticky top-0 z-10 bg-slate-100 text-left text-slate-700">
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
                              <td className="px-3 py-2">{row.ownerSellerName || row.ownerSellerId || "—"}</td>

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
                    <p className="shrink-0 text-xs text-slate-500">+{importPreviewRows.length - 200} linhas não exibidas no preview.</p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="shrink-0 flex justify-end gap-2 border-t border-slate-200 px-5 py-4 md:px-6">
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
        <div className="mobile-modal-shell" role="dialog" aria-modal="true">
          <div className="mobile-modal-panel w-full max-w-4xl border border-slate-200 shadow-xl">
            <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
              <h3 className="text-xl font-semibold text-slate-900">{createModalTitle}</h3>
              <p className="text-sm text-slate-500">Preencha os dados para cadastrar um cliente.</p>
            </div>

            <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
              <div className="mobile-modal-body space-y-4">
                {isClientsPage && !editing ? (
                  <div className="mb-4 space-y-2 rounded-xl border border-brand-200 bg-brand-50/50 p-4">
                    <p className="text-sm font-semibold text-brand-800">Criação rápida via CNPJ</p>
                    <p className="text-xs text-slate-600">Use o mesmo fluxo reutilizável de CNPJ para criar um cliente PJ ou abrir um cadastro já existente.</p>
                    <QuickCreateClientSection
                      open={isCreateModalOpen}
                      fieldClassName="w-full rounded-lg border border-slate-300 p-2 text-slate-800"
                      ownerSellerId={isSeller && user?.id ? user.id : typeof form.ownerSellerId === "string" ? form.ownerSellerId : undefined}
                      requireOwnerSeller={!editing && canChooseOwnerSeller}
                      requireRegion={false}
                      onClientCreated={handleClientCreatedViaCnpj}
                      onSelectExisting={handleSelectExistingClientViaCnpj}
                    />
                  </div>
                ) : null}

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
                              setForm((currentForm: ClientPayloadInput) => ({ ...currentForm, ownerSellerId: e.target.value }));
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

                    const isCnpjField = isClientsPage && f.key === "cnpj";
                    const fieldError = formFieldErrors[f.key as keyof ClientPayloadInput];

                    return (
                      <div key={f.key} className={`space-y-1 ${isCnpjField ? "md:col-span-2" : ""}`}>
                        <div className="flex items-center justify-between gap-2">
                          <label className="block text-sm font-medium text-slate-700" htmlFor={`modal-${f.key}`}>
                            {f.label}
                          </label>
                        </div>

                        {f.type === "select" ? (
                          <select
                            id={`modal-${f.key}`}
                            required={isRequired}
                            className="w-full rounded-lg border border-slate-300 p-2 text-slate-800"
                            value={form[f.key] ?? ""}
                            onChange={(e) => {
                              setFormError(null);
                              setFormFieldErrors((prev) => ({ ...prev, [f.key]: undefined }));
                              setForm((currentForm: ClientPayloadInput) => ({ ...currentForm, [f.key]: e.target.value }));
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
                              updateClientForm(f.key, f.type, e.target.value);
                            }}
                          />
                        )}

                        {fieldError ? (
                          <p className="text-xs text-rose-600">{fieldError}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {formError ? <p className="text-sm text-rose-600">{formError}</p> : null}
              </div>

              <div className="mobile-modal-footer sticky bottom-0 z-10 border-t border-slate-200 bg-white shadow-[0_-8px_24px_rgba(15,23,42,0.06)] sm:shadow-none">
                <button
                  type="button"
                  onClick={closeCreateModal}
                  className="mobile-secondary-half rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
                  disabled={saving}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="mobile-primary-button rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-400 disabled:text-slate-100 disabled:opacity-100"
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
