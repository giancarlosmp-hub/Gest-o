import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { normalizeHeader, normalizeTextValue, parseDecimalValue, parseImportFile } from "../../lib/import/parsers";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";
import { useAuth } from "../../context/AuthContext";

type OpportunityPreviewRow = {
  line: number;
  title: string;
  clientId: string;
  value?: number;
  stage: string;
  payload: Record<string, unknown>;
  status: "new" | "update" | "ignored" | "error";
  reason?: string;
  invalidFields?: string[];
};

type OpportunityImportFieldKey =
  | "title"
  | "clientNameOrId"
  | "value"
  | "stage"
  | "status"
  | "ownerEmail"
  | "ownerSellerName"
  | "followUpDate"
  | "proposalDate"
  | "expectedCloseDate"
  | "lastContactAt"
  | "probability"
  | "notes"
  | "areaHa"
  | "expectedTicketPerHa"
  | "crop"
  | "season"
  | "productOffered";

type OpportunityImportField = {
  key: OpportunityImportFieldKey;
  label: string;
  required: boolean;
  aliases: string[];
};

type ImportErrorItem = {
  row?: number;
  rowNumber?: number;
  message?: string;
};



type ImportDictionaryColumn = {
  key: string;
  required: boolean;
  example?: string;
  accepted?: string[];
  notes?: string;
};

type OpportunityImportDictionary = {
  columns: ImportDictionaryColumn[];
  tips: string[];
};

type OpportunityImportResponse = {
  created?: number;
  updated?: number;
  ignored?: number;
  skipped?: number;
  totalCreated?: number;
  totalIgnored?: number;
  totalImportados?: number;
  totalIgnorados?: number;
  errors?: ImportErrorItem[];
  skippedDetails?: Array<{
    row: number;
    reason: string;
    matchedId?: string;
    matchedTitle?: string;
    matchedClientName?: string;
    matchedCreatedAt?: string;
  }>;
  rowResults?: Array<{
    row: number;
    status: "created" | "updated" | "ignored" | "error";
    reason?: string;
    message?: string;
  }>;
};

const REQUIRED_FIELDS: OpportunityImportFieldKey[] = ["title", "clientNameOrId", "value", "stage", "probability"];
const VALID_STAGES = new Set(["prospeccao", "negociacao", "proposta", "ganho"]);
const VALID_STATUS = new Set(["open", "closed"]);

const FALLBACK_DICTIONARY: OpportunityImportDictionary = {
  columns: [
    { key: "titulo", required: true, example: "Algodão Safra 25/26" },
    { key: "cliente", required: true, example: "Coop X" },
    { key: "vendedor_responsavel", required: true, notes: "nome do vendedor; também aceitamos email_responsavel" },
    { key: "email_responsavel", required: true, notes: "compatível com arquivos legados" },
    { key: "etapa", required: true, accepted: ["prospeccao", "negociacao", "proposta", "ganho"] },
    { key: "valor", required: true, example: "52000.00", notes: "use ponto como decimal" },
    { key: "probabilidade", required: true, notes: "0 a 100" },
    { key: "data_entrada", required: true, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
    { key: "follow_up", required: true, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
    { key: "area_ha", required: false },
    { key: "ticket_esperado_ha", required: false },
    { key: "cultura", required: false },
    { key: "safra", required: false },
    { key: "produto_ofertado", required: false },
    { key: "fechamento_previsto", required: false, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
    { key: "ultimo_contato", required: false, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
    { key: "observacoes", required: false },
    { key: "status", required: false, accepted: ["open", "closed"] }
  ],
  tips: [
    "Se 'cliente' não existir e a opção 'Criar cliente automaticamente' estiver ligada, será criado como PJ com dados mínimos.",
    "Etapa inválida vira erro na linha (não bloqueia o arquivo todo).",
    "Datas inválidas viram erro na linha."
  ]
};

const IMPORT_FIELDS: OpportunityImportField[] = [
  { key: "title", label: "Título", required: true, aliases: ["title", "titulo", "nome da oportunidade", "oportunidade", "opportunity"] },
  { key: "clientNameOrId", label: "Cliente", required: true, aliases: ["clientnameorid", "cliente", "clienteid", "clientid", "nome do cliente", "cliente nome"] },
  { key: "value", label: "Valor", required: false, aliases: ["value", "valor", "valor total", "amount"] },
  { key: "stage", label: "Etapa", required: false, aliases: ["stage", "etapa", "fase"] },
  { key: "status", label: "Status", required: false, aliases: ["status", "situacao"] },
  { key: "ownerEmail", label: "E-mail do responsável", required: false, aliases: ["owneremail", "responsavelemail", "emailresponsavel", "email_responsavel", "email", "responsavel", "vendedor", "responsavelemail"] },
  { key: "ownerSellerName", label: "Vendedor responsável", required: false, aliases: ["vendedor_responsavel", "vendedorresponsavel", "nomeresponsavel", "responsavel_nome", "ownersellername"] },
  { key: "followUpDate", label: "Data de follow-up", required: false, aliases: ["followupdate", "followup", "follow_up", "dataseguimento", "datafollowup"] },
  { key: "proposalDate", label: "Data de entrada", required: false, aliases: ["proposaldate", "data_entrada", "dataentrada", "data de entrada"] },
  { key: "expectedCloseDate", label: "Fechamento previsto", required: false, aliases: ["expectedclosedate", "fechamento_previsto", "fechamentoprevisto"] },
  { key: "lastContactAt", label: "Último contato", required: false, aliases: ["lastcontactat", "ultimo_contato", "ultimocontato"] },
  { key: "probability", label: "Probabilidade (%)", required: false, aliases: ["probability", "probabilidade"] },
  { key: "notes", label: "Observações", required: false, aliases: ["notes", "observacoes", "observação", "comentarios"] },
  { key: "areaHa", label: "Área (ha)", required: false, aliases: ["area_ha", "areaha"] },
  { key: "expectedTicketPerHa", label: "Ticket esperado/ha", required: false, aliases: ["ticket_esperado_ha", "ticketesperadoha", "expectedticketperha"] },
  { key: "crop", label: "Cultura", required: false, aliases: ["crop", "cultura"] },
  { key: "season", label: "Safra", required: false, aliases: ["season", "safra"] },
  { key: "productOffered", label: "Produto ofertado", required: false, aliases: ["productoffered", "produto_ofertado", "produtoofertado"] }
];

const LOCAL_STORAGE_MAPPING_KEY = "opportunity-import-column-mapping";
const TEMPLATE_HEADERS = [
  "titulo",
  "cliente",
  "vendedor_responsavel",
  "email_responsavel",
  "etapa",
  "valor",
  "probabilidade",
  "data_entrada",
  "follow_up",
  "area_ha",
  "ticket_esperado_ha",
  "cultura",
  "safra",
  "produto_ofertado",
  "fechamento_previsto",
  "ultimo_contato",
  "observacoes",
  "status"
];
const TEMPLATE_EXAMPLE_ROWS = [
  ["Algodão Safra 25/26", "Coop X", "Carlos Silva", "vendedor@empresa.com", "prospeccao", "52000.00", "20", "2026-01-04", "2026-01-10", "120", "430.00", "algodao", "2025/26", "Programa Algodão Premium", "2026-02-15", "2026-01-08", "Primeiro contato via WhatsApp", "open"],
  ["Milho Verão Lote 3", "Fazenda São Pedro", "Aline Souza", "comercial@empresa.com", "negociacao", "148000.50", "55", "2026-01-18", "15/02/2026", "210", "705.50", "milho", "2025/26", "Pacote Nutrição Verão", "2026-03-05", "2026-02-02", "Cliente pediu ajuste de prazo", "open"],
  ["Soja Premium Exportação", "Coop X", "Carlos Silva", "vendedor@empresa.com", "proposta", "93000.00", "75", "2026-01-25", "2026-02-20", "175", "531.43", "soja", "2025/26", "Soja Premium Export", "2026-03-18", "2026-02-10", "Proposta enviada por e-mail", "open"],
  ["Fertilizante NPK 20-10", "Novo Cliente Horizonte", "Aline Souza", "comercial@empresa.com", "prospeccao", "41000.00", "30", "2026-01-06", "28/01/2026", "80", "512.50", "outros", "2025/26", "NPK 20-10", "2026-02-28", "2026-01-17", "Novo cliente para testar criação automática", "open"],
  ["Defensivo Programa Safra", "Fazenda São Pedro", "Carlos Silva", "vendedor@empresa.com", "ganho", "125500.00", "100", "2026-02-01", "2026-03-05", "260", "482.69", "soja", "2025/26", "Programa Safra Completo", "2026-03-05", "2026-03-04", "Pedido confirmado", "closed"]
];


const getSavedMappingForUser = (userId?: string | null): Partial<Record<OpportunityImportFieldKey, string>> => {
  if (!userId) return {};

  try {
    const rawValue = localStorage.getItem(`${LOCAL_STORAGE_MAPPING_KEY}:${userId}`);
    if (!rawValue) return {};
    return JSON.parse(rawValue) as Partial<Record<OpportunityImportFieldKey, string>>;
  } catch {
    return {};
  }
};

const saveMappingForUser = (userId: string | undefined, mapping: Partial<Record<OpportunityImportFieldKey, string>>) => {
  if (!userId) return;
  localStorage.setItem(`${LOCAL_STORAGE_MAPPING_KEY}:${userId}`, JSON.stringify(mapping));
};

const suggestColumnMapping = (
  headers: string[],
  savedMapping: Partial<Record<OpportunityImportFieldKey, string>>
): Partial<Record<OpportunityImportFieldKey, string>> => {
  const headersByNormalized = new Map(headers.map((header) => [normalizeHeader(header), header]));

  return IMPORT_FIELDS.reduce<Partial<Record<OpportunityImportFieldKey, string>>>((acc, field) => {
    const savedHeader = savedMapping[field.key];
    if (savedHeader && headers.includes(savedHeader)) {
      acc[field.key] = savedHeader;
      return acc;
    }

    for (const alias of field.aliases) {
      const foundHeader = headersByNormalized.get(normalizeHeader(alias));
      if (foundHeader) {
        acc[field.key] = foundHeader;
        break;
      }
    }

    return acc;
  }, {});
};

const buildPreviewRows = (rows: Record<string, unknown>[], mapping: Partial<Record<OpportunityImportFieldKey, string>>) => {
  const getMappedValue = (row: Record<string, unknown>, field: OpportunityImportFieldKey) => {
    const mappedHeader = mapping[field];
    if (!mappedHeader) return "";
    return row[mappedHeader];
  };

  const previewRows = rows.map<OpportunityPreviewRow>((row, index) => {
    const valueResult = parseDecimalValue(getMappedValue(row, "value"));
    const stage = normalizeTextValue(getMappedValue(row, "stage")).toLowerCase();
    const status = normalizeTextValue(getMappedValue(row, "status")).toLowerCase();
    const probabilityResult = parseDecimalValue(getMappedValue(row, "probability"));
    const probability = probabilityResult.isInvalid ? Number.NaN : probabilityResult.parsedValue;
    const followUpDate = normalizeTextValue(getMappedValue(row, "followUpDate"));

    const title = normalizeTextValue(getMappedValue(row, "title"));
    const clientNameOrId = normalizeTextValue(getMappedValue(row, "clientNameOrId"));
    const ownerEmail = normalizeTextValue(getMappedValue(row, "ownerEmail"));
    const ownerSellerName = normalizeTextValue(getMappedValue(row, "ownerSellerName"));
    const areaHaResult = parseDecimalValue(getMappedValue(row, "areaHa"));
    const expectedTicketPerHaResult = parseDecimalValue(getMappedValue(row, "expectedTicketPerHa"));
    const proposalDate = normalizeTextValue(getMappedValue(row, "proposalDate"));
    const expectedCloseDate = normalizeTextValue(getMappedValue(row, "expectedCloseDate"));
    const lastContactAt = normalizeTextValue(getMappedValue(row, "lastContactAt"));

    const previewRow: OpportunityPreviewRow = {
      line: index + 2,
      title,
      clientId: clientNameOrId,
      value: valueResult.isInvalid ? Number.NaN : valueResult.parsedValue,
      stage,
      payload: {
        title,
        clientNameOrId,
        value: valueResult.isInvalid ? undefined : valueResult.parsedValue,
        stage: stage || "prospeccao",
        status: status || undefined,
        ownerEmail: ownerEmail || undefined,
        ownerSellerName: ownerSellerName || undefined,
        followUpDate: followUpDate || undefined,
        proposalDate: proposalDate || undefined,
        expectedCloseDate: expectedCloseDate || undefined,
        lastContactAt: lastContactAt || undefined,
        probability: probability === undefined || Number.isNaN(probability) ? undefined : Number(probability),
        notes: normalizeTextValue(getMappedValue(row, "notes")) || undefined,
        areaHa: areaHaResult.isInvalid ? undefined : areaHaResult.parsedValue,
        expectedTicketPerHa: expectedTicketPerHaResult.isInvalid ? undefined : expectedTicketPerHaResult.parsedValue,
        crop: normalizeTextValue(getMappedValue(row, "crop")) || undefined,
        season: normalizeTextValue(getMappedValue(row, "season")) || undefined,
        productOffered: normalizeTextValue(getMappedValue(row, "productOffered")) || undefined
      },
      status: "new",
      invalidFields: []
    };

    const errors: string[] = [];
    const invalidFields = new Set<string>();

    if (!previewRow.title) {
      errors.push("título obrigatório");
      invalidFields.add("title");
    }
    if (!previewRow.clientId) {
      errors.push("cliente obrigatório");
      invalidFields.add("clientNameOrId");
    }
    if (!ownerEmail && !ownerSellerName) {
      errors.push("vendedor não encontrado");
      invalidFields.add("ownerEmail");
      invalidFields.add("ownerSellerName");
    }

    if (valueResult.isInvalid || valueResult.parsedValue === undefined || Number(valueResult.parsedValue) <= 0) {
      errors.push("valor inválido");
      invalidFields.add("value");
    }
    if (areaHaResult.isInvalid) {
      errors.push("Área (ha) inválida");
      invalidFields.add("areaHa");
    }
    if (expectedTicketPerHaResult.isInvalid) {
      errors.push("Ticket esperado/ha inválido");
      invalidFields.add("expectedTicketPerHa");
    }

    if (!stage || !VALID_STAGES.has(stage)) {
      errors.push("etapa inválida");
      invalidFields.add("stage");
    }
    if (status && !VALID_STATUS.has(status)) {
      errors.push("status inválido");
      invalidFields.add("status");
    }
    if (followUpDate && !/^\d{4}-\d{2}-\d{2}$/.test(followUpDate) && !/^\d{2}\/\d{2}\/\d{4}$/.test(followUpDate)) {
      errors.push("data inválida");
      invalidFields.add("followUpDate");
    }
    if (proposalDate && !/^\d{4}-\d{2}-\d{2}$/.test(proposalDate) && !/^\d{2}\/\d{2}\/\d{4}$/.test(proposalDate)) {
      errors.push("data inválida");
      invalidFields.add("proposalDate");
    }
    if (expectedCloseDate && !/^\d{4}-\d{2}-\d{2}$/.test(expectedCloseDate) && !/^\d{2}\/\d{2}\/\d{4}$/.test(expectedCloseDate)) {
      errors.push("data inválida");
      invalidFields.add("expectedCloseDate");
    }
    if (lastContactAt && !/^\d{4}-\d{2}-\d{2}$/.test(lastContactAt) && !/^\d{2}\/\d{2}\/\d{4}$/.test(lastContactAt)) {
      errors.push("data inválida");
      invalidFields.add("lastContactAt");
    }
    if (probability === undefined || Number.isNaN(probability) || probability < 0 || probability > 100) {
      errors.push("probabilidade inválida");
      invalidFields.add("probability");
    }

    if (errors.length) {
      previewRow.status = "error";
      previewRow.reason = errors.join(" · ");
      previewRow.invalidFields = Array.from(invalidFields);
    }

    return previewRow;
  });

  const seenKeys = new Set<string>();
  for (const row of previewRows) {
    if (row.status === "error") continue;
    const payload = row.payload as { ownerEmail?: string; ownerSellerName?: string };
    const ownerKey = (payload.ownerEmail || payload.ownerSellerName || "").toLowerCase();
    const key = [row.clientId.toLowerCase(), row.title.toLowerCase(), row.stage.toLowerCase(), ownerKey].join("|");
    if (seenKeys.has(key)) {
      row.status = "error";
      row.reason = row.reason ? `${row.reason} · linha duplicada no arquivo` : "linha duplicada no arquivo";
    } else {
      seenKeys.add(key);
    }
  }

  return previewRows;
};

export default function OpportunityImportModal({
  isOpen,
  onClose,
  onImported
}: {
  isOpen: boolean;
  onClose: () => void;
  onImported?: () => Promise<void> | void;
}) {
  const { user } = useAuth();
  const [fileName, setFileName] = useState("");
  const [detectedHeaders, setDetectedHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<OpportunityImportFieldKey, string>>>({});
  const [previewRows, setPreviewRows] = useState<OpportunityPreviewRow[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [dictionary, setDictionary] = useState<OpportunityImportDictionary>(FALLBACK_DICTIONARY);

  // ✅ Mantém as duas opções (resolve o conflito)
  const [isDryRun, setIsDryRun] = useState(false);
  const [createClientIfMissing, setCreateClientIfMissing] = useState(false);
  const [dedupeEnabled, setDedupeEnabled] = useState(true);
  const [dedupeWindowDays, setDedupeWindowDays] = useState(30);
  const [dedupeCompareStatuses, setDedupeCompareStatuses] = useState<"open_only" | "open_and_closed">("open_only");
  const [dedupeMode, setDedupeMode] = useState<"skip" | "upsert">("skip");

  const escapeCsvCell = (value: string) => {
    const escapedValue = value.split('"').join('""');
    if (/[;\r\n"]/.test(escapedValue)) {
      return `"${escapedValue}"`;
    }
    return escapedValue;
  };

  const downloadCsvFile = (fileName: string, rows: string[][]) => {
    const csvContent = rows
      .map((row) => row.map((cell) => escapeCsvCell(cell)).join(";"))
      .join("\r\n");
    const utf8Bom = "\uFEFF";
    const blob = new Blob([utf8Bom, `${csvContent}\r\n`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownloadTemplate = () => {
    downloadCsvFile("opportunities-import-template.csv", [TEMPLATE_HEADERS]);
  };

  const handleDownloadFilledExample = () => {
    downloadCsvFile("opportunities-import-example.csv", [TEMPLATE_HEADERS, ...TEMPLATE_EXAMPLE_ROWS]);
  };

  const counters = useMemo(
    () => ({
      totalRead: previewRows.length,
      valid: previewRows.filter((row) => row.status === "new" || row.status === "update").length,
      duplicate: previewRows.filter((row) => row.status === "ignored" || row.status === "update").length,
      error: previewRows.filter((row) => row.status === "error").length
    }),
    [previewRows]
  );

  const reset = () => {
    setFileName("");
    setDetectedHeaders([]);
    setRawRows([]);
    setMapping({});
    setPreviewRows([]);
    setIsImporting(false);
    setIsDryRun(false);
    setCreateClientIfMissing(false);
    setDedupeEnabled(true);
    setDedupeWindowDays(30);
    setDedupeCompareStatuses("open_only");
    setDedupeMode("skip");
    onClose();
  };


  useEffect(() => {
    const loadDictionary = async () => {
      try {
        const { data } = await api.get<OpportunityImportDictionary>("/opportunities/import/dictionary");
        if (data?.columns?.length) setDictionary(data);
      } catch {
        setDictionary(FALLBACK_DICTIONARY);
      }
    };

    loadDictionary();
  }, []);

  useEffect(() => {
    if (!detectedHeaders.length) return;
    const savedMapping = getSavedMappingForUser(user?.id);
    setMapping((current) => {
      if (Object.keys(current).length) return current;
      return suggestColumnMapping(detectedHeaders, savedMapping);
    });
  }, [detectedHeaders, user?.id]);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    setPreviewRows([]);

    if (!selectedFile) {
      setFileName("");
      return;
    }

    const lowerName = selectedFile.name.toLowerCase();
    if (!lowerName.endsWith(".csv") && !lowerName.endsWith(".xlsx")) {
      toast.error("Selecione um arquivo .csv ou .xlsx");
      event.target.value = "";
      setFileName("");
      return;
    }

    setFileName(selectedFile.name);

    try {
      const parsed = await parseImportFile(selectedFile);
      setDetectedHeaders(parsed.headers);
      setRawRows(parsed.rows);
      const resolvedMapping = suggestColumnMapping(parsed.headers, getSavedMappingForUser(user?.id));
      setMapping(resolvedMapping);
      const missingRequired = REQUIRED_FIELDS.filter((field) => !resolvedMapping[field]);
      if (missingRequired.length) {
        toast.warning("Faltam colunas obrigatórias no arquivo: titulo e cliente.");
      }
      const nextPreviewRows = buildPreviewRows(parsed.rows, resolvedMapping);
      setPreviewRows(await runDedupePreview(nextPreviewRows));
    } catch (error: any) {
      toast.error(error.message || "Não foi possível processar o arquivo selecionado.");
      setDetectedHeaders([]);
      setRawRows([]);
      setMapping({});
      setPreviewRows([]);
    }
  };

  const runDedupePreview = async (rows: OpportunityPreviewRow[]) => {
    if (!rows.length) return rows;

    try {
      const { data } = await api.post<OpportunityImportResponse>("/opportunities/import/preview", {
        rows: rows.map((row) => row.payload),
        options: {
          createClientIfMissing,
          dedupe: {
            enabled: dedupeEnabled,
            windowDays: dedupeWindowDays,
            compareStatuses: dedupeCompareStatuses,
            mode: dedupeMode
          }
        }
      });

      const resultByRow = new Map((data.rowResults || []).map((item) => [item.row, item]));

      return rows.map<OpportunityPreviewRow>((row, index) => {
        const result = resultByRow.get(index + 1);
        if (!result) return row;

        if (result.status === "created") return { ...row, status: "new" as const, reason: undefined };
        if (result.status === "updated") return { ...row, status: "update" as const, reason: undefined };

        if (result.status === "ignored") {
          return {
            ...row,
            status: "ignored" as const,
            reason: result.message || (result.reason === "duplicate" ? "duplicada no sistema" : "linha ignorada")
          };
        }

        return {
          ...row,
          status: "error" as const,
          reason: result.message || "Erro de validação"
        };
      });
    } catch {
      return rows;
    }
  };

  const handleApplyMapping = async () => {
    const missingRequired = REQUIRED_FIELDS.filter((field) => !mapping[field]);
    if (missingRequired.length) {
      toast.warning("Mapeie as colunas obrigatórias: Título, Cliente, Valor, Etapa e Probabilidade.");
      return;
    }

    const rows = buildPreviewRows(rawRows, mapping);
    const rowsWithDedupe = await runDedupePreview(rows);
    setPreviewRows(rowsWithDedupe);
    saveMappingForUser(user?.id, mapping);
    toast.success("Mapeamento aplicado ao preview.");
  };

  const handleImport = async () => {
    if (!previewRows.length) return;

    setIsImporting(true);
    try {
      const validRows = previewRows.filter((row) => row.status === "new" || row.status === "update").map((row) => row.payload);

      const { data } = await api.post<OpportunityImportResponse>("/opportunities/import", {
        rows: validRows,
        options: {
          dryRun: isDryRun,
          createClientIfMissing,
          dedupe: {
            enabled: dedupeEnabled,
            windowDays: dedupeWindowDays,
            compareStatuses: dedupeCompareStatuses,
            mode: dedupeMode
          }
        }
      });

      const created = data?.created ?? data?.totalCreated ?? data?.totalImportados ?? 0;
      const updated = data?.updated ?? 0;
      const ignored = data?.ignored ?? data?.skipped ?? data?.totalIgnored ?? data?.totalIgnorados ?? 0;
      const errors = data?.errors ?? [];

      toast.success(`${isDryRun ? "Simulação concluída" : "Concluído"}: ${created} importados, ${updated} atualizados, ${ignored} ignorados, ${errors.length} falhas`, {
        action: errors.length
          ? {
              label: "Ver detalhes",
              onClick: () => {
                toast.message(
                  <div className="space-y-1">
                    <p className="font-semibold">Erros da importação</p>
                    <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-4 text-xs">
                      {errors.map((item, index) => {
                        const row = item.row ?? item.rowNumber ?? "-";
                        return <li key={`${row}-${index}`}>Linha {row}: {item.message || "Erro não especificado"}</li>;
                      })}
                    </ul>
                  </div>
                );
              }
            }
          : undefined
      });

      if (errors.length) {
        toast.message(`${errors.length} linha(s) com erro na importação.`);
      }

      await onImported?.();
      reset();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Erro ao importar oportunidades."));
    } finally {
      setIsImporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
        <div className="shrink-0 border-b border-slate-200 px-6 pb-4 pt-6">
          <h3 className="text-xl font-semibold text-slate-900">Importar oportunidades</h3>
          <p className="text-sm text-slate-500">Importe oportunidades via planilha (CSV ou XLSX).</p>
        </div>

        <div className="shrink-0 border-b border-slate-200 px-6 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              ⬇️ Baixar template
            </button>
            <button
              type="button"
              onClick={handleDownloadFilledExample}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              ⬇️ Baixar exemplo preenchido
            </button>

            <input
              type="file"
              accept=".csv,.xlsx"
              onChange={handleFileChange}
              className="block w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-brand-700 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-800"
            />

            {fileName ? <span className="text-xs text-slate-500">Arquivo: {fileName}</span> : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">

          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-slate-700">
            <p className="mb-2 font-semibold text-slate-900">Ajuda rápida</p>
            <p>Etapas aceitas: {dictionary.columns.find((item) => item.key === "etapa")?.accepted?.join(", ") || "prospeccao, negociacao, proposta, ganho"}</p>
            <p>Status aceitos: {dictionary.columns.find((item) => item.key === "status")?.accepted?.join(", ") || "open, closed"}</p>
            <p>Data de follow-up: {dictionary.columns.find((item) => item.key === "follow_up")?.notes || "aceita yyyy-mm-dd ou dd/mm/aaaa"}</p>
          </div>

          <p className="text-sm text-slate-600">
            Linhas lidas: <span className="font-semibold text-slate-900">{counters.totalRead}</span> ·{" "}
            <span className="font-semibold text-emerald-700">{counters.valid} válidas</span> ·{" "}
            <span className="font-semibold text-amber-700">{counters.duplicate} duplicadas</span> ·{" "}
            <span className="font-semibold text-rose-700">{counters.error} com erro</span>
          </p>

          <div className="flex flex-wrap gap-4">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300"
                checked={isDryRun}
                onChange={(event) => setIsDryRun(event.target.checked)}
                disabled={isImporting}
              />
              Validar primeiro (simulação)
            </label>

            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={createClientIfMissing}
                onChange={(event) => setCreateClientIfMissing(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-500"
                disabled={isImporting}
              />
              Criar cliente automaticamente quando não encontrado
            </label>
          </div>

          <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-800">Proteção anti-duplicados</p>
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={dedupeEnabled} onChange={(event) => setDedupeEnabled(event.target.checked)} disabled={isImporting} />
              Evitar duplicados automaticamente
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm text-slate-700">
                Janela de comparação (dias)
                <input type="number" min={7} max={180} value={dedupeWindowDays} onChange={(event) => setDedupeWindowDays(Math.max(7, Math.min(180, Number(event.target.value) || 30)))} className="mt-1 w-full rounded-lg border border-slate-300 p-2" disabled={isImporting || !dedupeEnabled} />
              </label>
              <div className="text-sm text-slate-700">
                <p className="mb-1">Comparar com status</p>
                <label className="mr-4 inline-flex items-center gap-2"><input type="radio" name="dedupe-status" checked={dedupeCompareStatuses === "open_only"} onChange={() => setDedupeCompareStatuses("open_only")} disabled={isImporting || !dedupeEnabled} />Somente abertas</label>
                <label className="inline-flex items-center gap-2"><input type="radio" name="dedupe-status" checked={dedupeCompareStatuses === "open_and_closed"} onChange={() => setDedupeCompareStatuses("open_and_closed")} disabled={isImporting || !dedupeEnabled} />Abertas e fechadas</label>
              </div>
              <div className="text-sm text-slate-700 md:col-span-2">
                <p className="mb-1">Ação em duplicado</p>
                <label className="mr-4 inline-flex items-center gap-2"><input type="radio" name="dedupe-mode" checked={dedupeMode === "skip"} onChange={() => setDedupeMode("skip")} disabled={isImporting || !dedupeEnabled} />Ignorar linha</label>
                <label className="inline-flex items-center gap-2"><input type="radio" name="dedupe-mode" checked={dedupeMode === "upsert"} onChange={() => setDedupeMode("upsert")} disabled={isImporting || !dedupeEnabled} />Atualizar oportunidade existente (merge)</label>
              </div>
            </div>
          </div>

          {detectedHeaders.length ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-800">Mapeamento de colunas</p>
                <button
                  type="button"
                  onClick={handleApplyMapping}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Aplicar mapeamento
                </button>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                {IMPORT_FIELDS.map((field) => (
                  <div key={field.key} className="space-y-1">
                    <label className="block text-sm font-medium text-slate-700" htmlFor={`map-${field.key}`}>
                      {field.label} {field.required ? "*" : "(opcional)"}
                    </label>
                    <select
                      id={`map-${field.key}`}
                      className="w-full rounded-lg border border-slate-300 p-2 text-slate-800"
                      value={mapping[field.key] ?? ""}
                      onChange={(event) => setMapping((current) => ({ ...current, [field.key]: event.target.value }))}
                      disabled={isImporting}
                    >
                      <option value="">{field.required ? "— Selecione —" : "— Não informar —"}</option>
                      {detectedHeaders.map((header) => (
                        <option key={`${field.key}-${header}`} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[780px] text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="px-3 py-2">Linha</th>
                  <th className="px-3 py-2">Título</th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2">Valor</th>
                  <th className="px-3 py-2">Etapa</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.length ? (
                  previewRows.slice(0, 20).map((row) => (
                    <tr key={row.line} className="border-t border-slate-200">
                      <td className="px-3 py-2">{row.line}</td>
                      <td className={`px-3 py-2 ${row.invalidFields?.includes("title") ? "bg-rose-100" : ""}`}>{row.title || "—"}</td>
                      <td className={`px-3 py-2 ${row.invalidFields?.includes("clientNameOrId") ? "bg-rose-100" : ""}`}>{row.clientId || "—"}</td>
                      <td className={`px-3 py-2 ${row.invalidFields?.includes("value") ? "bg-rose-100" : ""}`}>{row.value ?? "—"}</td>
                      <td className={`px-3 py-2 ${row.invalidFields?.includes("stage") ? "bg-rose-100" : ""}`}>{row.stage || "—"}</td>
                      <td className={`px-3 py-2 ${row.invalidFields?.includes("status") ? "bg-rose-100" : ""}`}>{row.status === "new" ? "NOVO" : row.status === "update" ? "ATUALIZAR" : row.status === "ignored" ? "IGNORADO" : "ERRO"}</td>
                      <td className="px-3 py-2">{row.reason || "OK"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                      Envie um arquivo para visualizar o preview.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {previewRows.length > 20 ? (
            <p className="text-xs text-slate-500">Mostrando 20 de {previewRows.length} linhas no preview.</p>
          ) : null}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-slate-200 px-6 py-4">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
            disabled={isImporting}
          >
            Cancelar
          </button>

          <button
            type="button"
            onClick={handleImport}
            className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isImporting || counters.totalRead === 0 || counters.valid === 0}
          >
            {isImporting ? (isDryRun ? "Simulando..." : "Importando...") : isDryRun ? "Simular" : "Importar"}
          </button>
        </div>
      </div>
    </div>
  );
}
