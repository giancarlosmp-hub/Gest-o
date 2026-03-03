import { ChangeEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { ImportColumnMappingStep, type ImportFieldDefinition } from "../ClientImportColumnMappingStep";
import { normalizeHeader, normalizeTextValue, parseDecimalValue, parseImportFile } from "../../lib/import/parsers";

type OpportunityImportFieldKey = "titulo" | "cliente" | "valor" | "etapa" | "status" | "responsavelEmail" | "followUp" | "probabilidade" | "observacoes";

type OpportunityImportStatus = "valid" | "error";
type OpportunityStage = "prospeccao" | "negociacao" | "proposta" | "ganho";
type OpportunityOpenClosed = "open" | "closed";

type OpportunityImportRow = {
  sourceRowNumber: number;
  titulo: string;
  cliente: string;
  valor?: number;
  etapa?: OpportunityStage;
  statusValue?: OpportunityOpenClosed;
  responsavelEmail: string;
  followUp?: string;
  probabilidade?: number;
  observacoes: string;
  status: OpportunityImportStatus;
  errorMessage?: string;
};

const fields: ImportFieldDefinition<OpportunityImportFieldKey>[] = [
  { key: "titulo", label: "Título", required: true },
  { key: "cliente", label: "Cliente", required: true },
  { key: "valor", label: "Valor", required: true },
  { key: "etapa", label: "Etapa", required: true },
  { key: "status", label: "Status", required: true },
  { key: "responsavelEmail", label: "Responsável (email)", required: false },
  { key: "followUp", label: "Follow-up", required: false },
  { key: "probabilidade", label: "Probabilidade", required: false },
  { key: "observacoes", label: "Observações", required: false }
];

const requiredFields: OpportunityImportFieldKey[] = ["titulo", "cliente", "valor", "etapa", "status"];

const stageMap: Record<string, OpportunityStage> = {
  prospeccao: "prospeccao",
  prospeccão: "prospeccao",
  prospecao: "prospeccao",
  prospecção: "prospeccao",
  negociacao: "negociacao",
  negociação: "negociacao",
  proposta: "proposta",
  fechamento: "ganho"
};

const statusMap: Record<string, OpportunityOpenClosed> = {
  open: "open",
  aberto: "open",
  aberta: "open",
  closed: "closed",
  fechado: "closed",
  fechada: "closed"
};

const normalizeStage = (value: string): OpportunityStage | undefined => {
  if (!value) return undefined;
  const byHeaderNormalization = normalizeHeader(value);
  if (byHeaderNormalization in stageMap) return stageMap[byHeaderNormalization];

  const plain = value.trim().toLowerCase();
  if (plain in stageMap) return stageMap[plain];
  return undefined;
};

const normalizeStatus = (value: string): OpportunityOpenClosed | undefined => {
  if (!value) return undefined;
  const normalized = normalizeHeader(value);
  if (normalized in statusMap) return statusMap[normalized];
  return undefined;
};

const normalizeDate = (value: string): string | undefined => {
  if (!value) return undefined;
  const isoPattern = /^\d{4}-\d{2}-\d{2}$/;
  if (isoPattern.test(value)) return value;

  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return undefined;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
};

const autoMapColumns = (headers: string[]) => {
  const synonyms: Record<OpportunityImportFieldKey, string[]> = {
    titulo: ["titulo", "title", "oportunidade", "nome"],
    cliente: ["cliente", "client", "clienteid", "clientid"],
    valor: ["valor", "value"],
    etapa: ["etapa", "estagio", "stage"],
    status: ["status", "situacao", "situação"],
    responsavelEmail: ["responsavelemail", "responsavel", "owneremail", "vendedoremail"],
    followUp: ["followup", "follow", "retorno", "datafollowup"],
    probabilidade: ["probabilidade", "probability"],
    observacoes: ["observacoes", "observação", "notes", "nota"]
  };

  const normalizedHeaders = headers.map((header) => ({ header, normalized: normalizeHeader(header) }));
  const mapping: Partial<Record<OpportunityImportFieldKey, string>> = {};

  fields.forEach((field) => {
    const expected = normalizeHeader(field.key);
    const candidates = normalizedHeaders.filter((item) => {
      if (!item.normalized) return false;
      if (item.normalized === expected) return true;
      return synonyms[field.key].some((synonym) => item.normalized.includes(normalizeHeader(synonym)));
    });

    if (candidates.length === 1) mapping[field.key] = candidates[0].header;
  });

  return mapping;
};

export default function OpportunityImportModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<OpportunityImportFieldKey, string>>>({});
  const [previewRows, setPreviewRows] = useState<OpportunityImportRow[]>([]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const reset = () => {
    setStep(1);
    setHeaders([]);
    setRawRows([]);
    setMapping({});
    setPreviewRows([]);
    setValidationErrors([]);
    onClose();
  };

  const validateAndBuildRows = (rows: Record<string, unknown>[], currentMapping: Partial<Record<OpportunityImportFieldKey, string>>) => {
    const nextRows: OpportunityImportRow[] = [];
    const errors: string[] = [];

    rows.forEach((row, index) => {
      const line = index + 2;
      const valorResult = parseDecimalValue(currentMapping.valor ? row[currentMapping.valor] : undefined);
      const probabilidadeResult = parseDecimalValue(currentMapping.probabilidade ? row[currentMapping.probabilidade] : undefined);

      const titulo = currentMapping.titulo ? normalizeTextValue(row[currentMapping.titulo]) : "";
      const cliente = currentMapping.cliente ? normalizeTextValue(row[currentMapping.cliente]) : "";
      const etapaRaw = currentMapping.etapa ? normalizeTextValue(row[currentMapping.etapa]) : "";
      const statusRaw = currentMapping.status ? normalizeTextValue(row[currentMapping.status]) : "";
      const followUpRaw = currentMapping.followUp ? normalizeTextValue(row[currentMapping.followUp]) : "";

      const etapa = normalizeStage(etapaRaw);
      const statusValue = normalizeStatus(statusRaw);
      const followUp = followUpRaw ? normalizeDate(followUpRaw) : undefined;

      const built: OpportunityImportRow = {
        sourceRowNumber: line,
        titulo,
        cliente,
        valor: valorResult.isInvalid ? Number.NaN : valorResult.parsedValue,
        etapa,
        statusValue,
        responsavelEmail: currentMapping.responsavelEmail ? normalizeTextValue(row[currentMapping.responsavelEmail]) : "",
        followUp,
        probabilidade: probabilidadeResult.isInvalid ? Number.NaN : probabilidadeResult.parsedValue,
        observacoes: currentMapping.observacoes ? normalizeTextValue(row[currentMapping.observacoes]) : "",
        status: "valid"
      };

      const rowErrors: string[] = [];
      if (!built.titulo) rowErrors.push("título vazio");
      if (!built.cliente) rowErrors.push("cliente vazio");
      if (built.valor === undefined || Number.isNaN(built.valor) || built.valor <= 0) rowErrors.push("valor deve ser maior que zero");
      if (!built.statusValue) rowErrors.push("status inválido");
      if (!built.etapa) rowErrors.push("etapa inválida");
      if (followUpRaw && !built.followUp) rowErrors.push("followUp inválido");
      if (built.probabilidade !== undefined && (Number.isNaN(built.probabilidade) || built.probabilidade < 0 || built.probabilidade > 100)) {
        rowErrors.push("probabilidade fora de 0-100");
      }

      if (rowErrors.length > 0) {
        built.status = "error";
        built.errorMessage = rowErrors.join("; ");
        errors.push(`Linha ${line}: ${rowErrors.join("; ")}`);
      }

      nextRows.push(built);
    });

    setPreviewRows(nextRows);
    setValidationErrors(errors);
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    setHeaders([]);
    setRawRows([]);
    setMapping({});
    setPreviewRows([]);
    setValidationErrors([]);
    setStep(1);

    if (!selected) return;

    const lowerName = selected.name.toLowerCase();
    if (!lowerName.endsWith(".xlsx") && !lowerName.endsWith(".csv")) {
      toast.error("Selecione um arquivo .csv ou .xlsx");
      return;
    }

    try {
      const parsed = await parseImportFile(selected);
      const autoMapping = autoMapColumns(parsed.headers);
      setHeaders(parsed.headers);
      setRawRows(parsed.rows);
      setMapping(autoMapping);

      if (requiredFields.every((field) => Boolean(autoMapping[field]))) {
        setStep(2);
        validateAndBuildRows(parsed.rows, autoMapping);
      }
    } catch (error: any) {
      toast.error(error.message || "Erro ao processar o arquivo.");
    }
  };

  const counters = useMemo(
    () => ({
      total: previewRows.length,
      valid: previewRows.filter((row) => row.status === "valid").length,
      error: previewRows.filter((row) => row.status === "error").length
    }),
    [previewRows]
  );

  const handleContinue = () => {
    if (!requiredFields.every((field) => Boolean(mapping[field]))) {
      toast.warning("Mapeie todas as colunas obrigatórias para continuar.");
      return;
    }

    setStep(2);
    validateAndBuildRows(rawRows, mapping);
  };

  const handleImport = () => {
    if (counters.error > 0 || counters.total === 0) return;
    toast.success("Arquivo validado com sucesso. Pronto para envio ao backend na próxima etapa.");
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <h3 className="text-xl font-semibold text-slate-900">Importar oportunidades (CSV/XLSX)</h3>
        <p className="text-sm text-slate-500">Passo {step} de 2 · {step === 1 ? "Mapear colunas" : "Preview e validação"}</p>

        <div className="mt-4 space-y-4">
          <input
            type="file"
            accept=".csv,.xlsx"
            onChange={handleFileChange}
            className="block w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
          />

          {headers.length > 0 && step === 1 ? (
            <ImportColumnMappingStep
              fields={fields}
              excelHeaders={headers}
              mapping={mapping}
              templateNames={[]}
              selectedTemplateName=""
              onChangeMapping={(field, value) => setMapping((prev) => ({ ...prev, [field]: value || undefined }))}
              onChangeTemplate={() => undefined}
              onSaveTemplate={() => toast.info("Templates de importação serão adicionados em seguida.")}
              onEditTemplate={() => undefined}
              onDeleteTemplate={() => undefined}
              onUseModelHeaders={() => setMapping(autoMapColumns(headers))}
              onContinue={handleContinue}
            />
          ) : null}

          {step === 2 ? (
            <>
              {validationErrors.length > 0 ? (
                <div className="max-h-32 overflow-y-auto rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                  {validationErrors.slice(0, 20).map((error) => (
                    <p key={error}>• {error}</p>
                  ))}
                </div>
              ) : null}

              <p className="text-sm text-slate-600">
                Total linhas: <span className="font-semibold text-slate-900">{counters.total}</span> ·{" "}
                <span className="font-semibold text-emerald-700">{counters.valid} válidas</span> ·{" "}
                <span className="font-semibold text-rose-700">{counters.error} com erro</span>
              </p>

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-slate-100 text-left text-slate-700">
                    <tr>
                      <th className="px-3 py-2">Linha</th>
                      <th className="px-3 py-2">Título</th>
                      <th className="px-3 py-2">Cliente</th>
                      <th className="px-3 py-2">Valor</th>
                      <th className="px-3 py-2">Etapa</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Follow-up</th>
                      <th className="px-3 py-2">Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.length > 0 ? (
                      previewRows.slice(0, 20).map((row) => (
                        <tr key={row.sourceRowNumber} className="border-t border-slate-200">
                          <td className="px-3 py-2">{row.sourceRowNumber}</td>
                          <td className="px-3 py-2">{row.titulo || "—"}</td>
                          <td className="px-3 py-2">{row.cliente || "—"}</td>
                          <td className="px-3 py-2">{row.valor ?? "—"}</td>
                          <td className="px-3 py-2">{row.etapa || "—"}</td>
                          <td className="px-3 py-2">{row.statusValue || "—"}</td>
                          <td className="px-3 py-2">{row.followUp || "—"}</td>
                          <td className="px-3 py-2">{row.errorMessage || "OK"}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                          Envie um arquivo para visualizar o preview.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
          >
            Cancelar
          </button>
          {step === 2 ? (
            <button
              type="button"
              onClick={handleImport}
              disabled={counters.total === 0 || counters.error > 0}
              className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Importar
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
