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
  status: "valid" | "error" | "duplicate";
  errorMessage?: string;
  duplicateMessage?: string;
  invalidFields?: string[];
};

type OpportunityImportFieldKey =
  | "title"
  | "clientNameOrId"
  | "value"
  | "stage"
  | "status"
  | "ownerEmail"
  | "followUpDate"
  | "probability"
  | "notes";

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
};

const REQUIRED_FIELDS: OpportunityImportFieldKey[] = ["title", "clientNameOrId", "ownerEmail"];
const VALID_STAGES = new Set(["prospeccao", "negociacao", "proposta", "ganho"]);
const VALID_STATUS = new Set(["open", "closed"]);

const FALLBACK_DICTIONARY: OpportunityImportDictionary = {
  columns: [
    { key: "titulo", required: true, example: "Algodão Safra 25/26" },
    { key: "cliente", required: true, example: "Coop X" },
    { key: "valor", required: false, example: "52000.00", notes: "use ponto como decimal" },
    { key: "etapa", required: false, accepted: ["prospeccao", "negociacao", "proposta", "ganho"] },
    { key: "status", required: false, accepted: ["open", "closed"] },
    { key: "responsavelEmail", required: true, notes: "precisa existir no sistema" },
    { key: "followUp", required: false, notes: "aceita yyyy-mm-dd ou dd/mm/aaaa" },
    { key: "probabilidade", required: false, notes: "0 a 100" },
    { key: "observacoes", required: false }
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
  { key: "ownerEmail", label: "E-mail do responsável", required: true, aliases: ["owneremail", "responsavelemail", "email", "responsavel", "vendedor"] },
  { key: "followUpDate", label: "Data de follow-up", required: false, aliases: ["followupdate", "followup", "dataseguimento", "datafollowup", "proposaldate", "expectedclosedate"] },
  { key: "probability", label: "Probabilidade (%)", required: false, aliases: ["probability", "probabilidade"] },
  { key: "notes", label: "Observações", required: false, aliases: ["notes", "observacoes", "observação", "comentarios"] }
];

const LOCAL_STORAGE_MAPPING_KEY = "opportunity-import-column-mapping";
const TEMPLATE_HEADERS = ["titulo", "cliente", "valor", "etapa", "status", "responsavelEmail", "followUp", "probabilidade", "observacoes"];


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

  return rows.map<OpportunityPreviewRow>((row, index) => {
    const valueResult = parseDecimalValue(getMappedValue(row, "value"));
    const stage = normalizeTextValue(getMappedValue(row, "stage")).toLowerCase();
    const status = normalizeTextValue(getMappedValue(row, "status")).toLowerCase();
    const probabilityResult = parseDecimalValue(getMappedValue(row, "probability"));
    const probability = probabilityResult.isInvalid ? Number.NaN : probabilityResult.parsedValue;
    const followUpDate = normalizeTextValue(getMappedValue(row, "followUpDate"));

    const title = normalizeTextValue(getMappedValue(row, "title"));
    const clientNameOrId = normalizeTextValue(getMappedValue(row, "clientNameOrId"));
    const ownerEmail = normalizeTextValue(getMappedValue(row, "ownerEmail"));

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
        followUpDate: followUpDate || undefined,
        probability: probability === undefined || Number.isNaN(probability) ? undefined : Number(probability),
        notes: normalizeTextValue(getMappedValue(row, "notes")) || undefined
      },
      status: "valid",
      invalidFields: []
    };

    const errors: string[] = [];
    const invalidFields = new Set<string>();

    if (!previewRow.title) {
      errors.push("Título obrigatório");
      invalidFields.add("title");
    }
    if (!previewRow.clientId) {
      errors.push("Cliente obrigatório");
      invalidFields.add("clientNameOrId");
    }
    if (!ownerEmail) {
      errors.push("E-mail do responsável obrigatório");
      invalidFields.add("ownerEmail");
    }

    if (valueResult.isInvalid) {
      errors.push("Valor inválido");
      invalidFields.add("value");
    }

    if (stage && !VALID_STAGES.has(stage)) {
      errors.push("Etapa inválida");
      invalidFields.add("stage");
    }
    if (status && !VALID_STATUS.has(status)) {
      errors.push("Status deve ser open ou closed");
      invalidFields.add("status");
    }
    if (followUpDate && !/^\d{4}-\d{2}-\d{2}$/.test(followUpDate) && !/^\d{2}\/\d{2}\/\d{4}$/.test(followUpDate)) {
      errors.push("Follow-up deve estar em yyyy-mm-dd ou dd/mm/aaaa");
      invalidFields.add("followUpDate");
    }
    if (probability !== undefined && (Number.isNaN(probability) || probability < 0 || probability > 100)) {
      errors.push("Probabilidade deve estar entre 0 e 100");
      invalidFields.add("probability");
    }

    if (errors.length) {
      previewRow.status = "error";
      previewRow.errorMessage = errors.join(" · ");
      previewRow.invalidFields = Array.from(invalidFields);
    }

    return previewRow;
  });
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

  const handleDownloadTemplate = () => {
    const csvContent = `${TEMPLATE_HEADERS.join(";")}\r\n`;
    const utf8Bom = "\uFEFF";
    const blob = new Blob([utf8Bom, csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "opportunities-import-template.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const counters = useMemo(
    () => ({
      totalRead: previewRows.length,
      valid: previewRows.filter((row) => row.status === "valid").length,
      duplicate: previewRows.filter((row) => row.status === "duplicate").length,
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
        toast.warning("Faltam colunas obrigatórias no arquivo: titulo, cliente e/ou responsavelEmail.");
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
    if (!dedupeEnabled) return rows;

    const validRows = rows.filter((row) => row.status === "valid");
    if (!validRows.length) return rows;

    try {
      const { data } = await api.post<OpportunityImportResponse>("/opportunities/import", {
        rows: validRows.map((row) => row.payload),
        options: {
          dryRun: true,
          createClientIfMissing,
          dedupe: {
            enabled: dedupeEnabled,
            windowDays: dedupeWindowDays,
            compareStatuses: dedupeCompareStatuses,
            mode: "skip"
          }
        }
      });

      const duplicatesByRow = new Map((data.skippedDetails || [])
        .filter((item) => item.reason === "duplicate")
        .map((item) => [item.row + 1, item]));

      return rows.map((row) => {
        const duplicate = duplicatesByRow.get(row.line);
        if (!duplicate) return row;

        const formattedDate = duplicate.matchedCreatedAt ? new Date(duplicate.matchedCreatedAt).toLocaleDateString("pt-BR") : "data desconhecida";
        return {
          ...row,
          status: "duplicate" as const,
          duplicateMessage: `Possível duplicado de '${duplicate.matchedTitle || "Oportunidade"}' (cliente ${duplicate.matchedClientName || "N/A"}) criada em ${formattedDate}`
        };
      });
    } catch {
      return rows;
    }
  };

  const handleApplyMapping = async () => {
    const missingRequired = REQUIRED_FIELDS.filter((field) => !mapping[field]);
    if (missingRequired.length) {
      toast.warning("Mapeie as colunas obrigatórias: Título, Cliente e E-mail do responsável.");
      return;
    }

    const rows = buildPreviewRows(rawRows, mapping);
    const rowsWithDedupe = await runDedupePreview(rows);
    setPreviewRows(rowsWithDedupe);
    saveMappingForUser(user?.id, mapping);
    toast.success("Mapeamento aplicado ao preview.");
  };

  const handleImport = async () => {
    if (!previewRows.length || counters.error > 0) return;

    setIsImporting(true);
    try {
      const validRows = previewRows.filter((row) => row.status === "valid").map((row) => row.payload);

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

      toast.success(`${isDryRun ? "Simulação concluída" : "Concluído"}: ${created} criadas, ${updated} atualizadas, ${ignored} ignoradas (duplicadas)`, {
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
      <div className="w-full max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="mb-4">
          <h3 className="text-xl font-semibold text-slate-900">Importar oportunidades</h3>
          <p className="text-sm text-slate-500">Importe oportunidades via planilha (CSV ou XLSX).</p>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              ⬇️ Baixar template
            </button>
            <a
              href="/templates/opportunities-import-example.csv"
              download
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              ⬇️ Baixar exemplo preenchido
            </a>

            <input
              type="file"
              accept=".csv,.xlsx"
              onChange={handleFileChange}
              className="block w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-brand-700 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-800"
            />

            {fileName ? <span className="text-xs text-slate-500">Arquivo: {fileName}</span> : null}
          </div>

          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-slate-700">
            <p className="mb-2 font-semibold text-slate-900">Ajuda rápida</p>
            <p>Etapas aceitas: {dictionary.columns.find((item) => item.key === "etapa")?.accepted?.join(", ") || "prospeccao, negociacao, proposta, ganho"}</p>
            <p>Status aceitos: {dictionary.columns.find((item) => item.key === "status")?.accepted?.join(", ") || "open, closed"}</p>
            <p>Data de follow-up: {dictionary.columns.find((item) => item.key === "followUp")?.notes || "aceita yyyy-mm-dd ou dd/mm/aaaa"}</p>
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
                  <th className="px-3 py-2">Estágio</th>
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
                      <td className={`px-3 py-2 ${row.invalidFields?.includes("status") ? "bg-rose-100" : ""}`}>{row.status === "valid" ? "VÁLIDO" : row.status === "duplicate" ? "DUPLICADO" : "ERRO"}</td>
                      <td className="px-3 py-2">{row.errorMessage || row.duplicateMessage || "OK"}</td>
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

        <div className="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-4">
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
            disabled={isImporting || counters.totalRead === 0 || counters.error > 0}
          >
            {isImporting ? (isDryRun ? "Simulando..." : "Importando...") : isDryRun ? "Simular" : "Importar"}
          </button>
        </div>
      </div>
    </div>
  );
}
