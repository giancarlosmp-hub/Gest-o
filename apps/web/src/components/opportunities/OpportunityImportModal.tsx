import { ChangeEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import api from "../../lib/apiClient";
import { ImportColumnMappingStep, type ImportFieldDefinition } from "../ClientImportColumnMappingStep";
import { normalizeHeader, normalizeTextValue, parseDecimalValue, parseImportFile } from "../../lib/import/parsers";

type OpportunityImportFieldKey = "title" | "value" | "stage" | "clientId" | "ownerSellerId" | "proposalDate" | "expectedCloseDate" | "probability" | "crop" | "season";

type OpportunityImportRow = {
  sourceRowNumber: number;
  title: string;
  value?: number;
  stage: string;
  clientId: string;
  ownerSellerId: string;
  proposalDate: string;
  expectedCloseDate: string;
  probability?: number;
  crop: string;
  season: string;
  status: "new" | "error";
  errorMessage?: string;
};

const fields: ImportFieldDefinition<OpportunityImportFieldKey>[] = [
  { key: "title", label: "Título", required: true },
  { key: "value", label: "Valor", required: true },
  { key: "stage", label: "Estágio", required: true },
  { key: "clientId", label: "Cliente (ID)", required: true },
  { key: "ownerSellerId", label: "Vendedor responsável (ID)", required: false },
  { key: "proposalDate", label: "Data proposta", required: true },
  { key: "expectedCloseDate", label: "Data previsão fechamento", required: true },
  { key: "probability", label: "Probabilidade (%)", required: false },
  { key: "crop", label: "Cultura", required: false },
  { key: "season", label: "Safra", required: false }
];

const requiredFields: OpportunityImportFieldKey[] = ["title", "value", "stage", "clientId", "proposalDate", "expectedCloseDate"];
const stageOptions = new Set(["prospeccao", "negociacao", "proposta", "ganho", "perdido"]);

const autoMapColumns = (headers: string[]) => {
  const synonyms: Record<OpportunityImportFieldKey, string[]> = {
    title: ["title", "titulo", "oportunidade", "nome"],
    value: ["value", "valor", "valornegocio"],
    stage: ["stage", "estagio", "etapa"],
    clientId: ["clientid", "clienteid", "idcliente"],
    ownerSellerId: ["ownersellerid", "vendedor", "sellerid", "idvendedor"],
    proposalDate: ["proposaldate", "dataproposta", "dataentrada"],
    expectedCloseDate: ["expectedclosedate", "dataprevisao", "datafechamento"],
    probability: ["probability", "probabilidade"],
    crop: ["crop", "cultura"],
    season: ["season", "safra"]
  };

  const normalizedHeaders = headers.map((header) => ({ header, normalized: normalizeHeader(header) }));
  const mapping: Partial<Record<OpportunityImportFieldKey, string>> = {};

  fields.forEach((field) => {
    const expected = normalizeHeader(field.key);
    const candidates = normalizedHeaders.filter((item) => {
      if (!item.normalized) return false;
      if (item.normalized === expected) return true;
      return synonyms[field.key].some((synonym) => item.normalized.includes(synonym) || synonym.includes(item.normalized));
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
  const [isImporting, setIsImporting] = useState(false);

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
      const valueResult = parseDecimalValue(currentMapping.value ? row[currentMapping.value] : undefined);
      const probabilityResult = parseDecimalValue(currentMapping.probability ? row[currentMapping.probability] : undefined);
      const built: OpportunityImportRow = {
        sourceRowNumber: line,
        title: currentMapping.title ? normalizeTextValue(row[currentMapping.title]) : "",
        value: valueResult.isInvalid ? Number.NaN : valueResult.parsedValue,
        stage: currentMapping.stage ? normalizeTextValue(row[currentMapping.stage]).toLowerCase() : "",
        clientId: currentMapping.clientId ? normalizeTextValue(row[currentMapping.clientId]) : "",
        ownerSellerId: currentMapping.ownerSellerId ? normalizeTextValue(row[currentMapping.ownerSellerId]) : "",
        proposalDate: currentMapping.proposalDate ? normalizeTextValue(row[currentMapping.proposalDate]) : "",
        expectedCloseDate: currentMapping.expectedCloseDate ? normalizeTextValue(row[currentMapping.expectedCloseDate]) : "",
        probability: probabilityResult.isInvalid ? Number.NaN : probabilityResult.parsedValue,
        crop: currentMapping.crop ? normalizeTextValue(row[currentMapping.crop]) : "",
        season: currentMapping.season ? normalizeTextValue(row[currentMapping.season]) : "",
        status: "new"
      };

      const rowErrors: string[] = [];
      if (!built.title) rowErrors.push("Título obrigatório");
      if (built.value === undefined || Number.isNaN(built.value) || built.value <= 0) rowErrors.push("Valor deve ser numérico e maior que zero");
      if (!stageOptions.has(built.stage)) rowErrors.push("Estágio inválido");
      if (!built.clientId) rowErrors.push("Cliente (ID) obrigatório");
      if (!built.proposalDate) rowErrors.push("Data proposta obrigatória");
      if (!built.expectedCloseDate) rowErrors.push("Data previsão fechamento obrigatória");
      if (built.probability !== undefined && (Number.isNaN(built.probability) || built.probability < 0 || built.probability > 100)) {
        rowErrors.push("Probabilidade deve ser um número entre 0 e 100");
      }

      if (rowErrors.length > 0) {
        built.status = "error";
        built.errorMessage = rowErrors.join(", ");
        errors.push(`Linha ${line}: ${built.errorMessage}`);
      }

      const hasValue = Object.values(built).some((value) => value !== "" && value !== undefined && value !== "new");
      if (hasValue) nextRows.push(built);
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
    if (!selected.name.toLowerCase().endsWith(".xlsx")) {
      toast.error("Selecione um arquivo .xlsx");
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

  const counters = useMemo(() => ({
    total: previewRows.length,
    valid: previewRows.filter((row) => row.status === "new").length,
    error: previewRows.filter((row) => row.status === "error").length
  }), [previewRows]);

  const handleContinue = () => {
    if (!requiredFields.every((field) => Boolean(mapping[field]))) {
      toast.warning("Mapeie todas as colunas obrigatórias para continuar.");
      return;
    }
    setStep(2);
    validateAndBuildRows(rawRows, mapping);
  };

  const handleImport = async () => {
    const validRows = previewRows.filter((row) => row.status === "new");
    if (validRows.length === 0) return;

    setIsImporting(true);
    try {
      await api.post("/opportunities/import", {
        rows: validRows.map((row) => ({
          title: row.title,
          value: row.value,
          stage: row.stage,
          clientId: row.clientId,
          ownerSellerId: row.ownerSellerId || undefined,
          proposalDate: row.proposalDate,
          expectedCloseDate: row.expectedCloseDate,
          probability: row.probability,
          crop: row.crop || undefined,
          season: row.season || undefined
        }))
      });
      toast.success("Importação de oportunidades iniciada com sucesso.");
      reset();
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Não foi possível importar oportunidades.");
    } finally {
      setIsImporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <h3 className="text-xl font-semibold text-slate-900">Importar oportunidades (Excel)</h3>
        <p className="text-sm text-slate-500">Passo {step} de 2 · {step === 1 ? "Mapear colunas" : "Preview e validação"}</p>
        <div className="mt-4 space-y-4">
          <input type="file" accept=".xlsx" onChange={handleFileChange} className="block w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700" />
          {headers.length > 0 && step === 1 ? (
            <ImportColumnMappingStep
              fields={fields}
              excelHeaders={headers}
              mapping={mapping}
              templateNames={[]}
              selectedTemplateName=""
              onChangeMapping={(field, value) => setMapping((prev) => ({ ...prev, [field]: value || undefined }))}
              onChangeTemplate={() => undefined}
              onSaveTemplate={() => toast.info("Templates de importação para oportunidades serão adicionados em seguida.")}
              onEditTemplate={() => undefined}
              onDeleteTemplate={() => undefined}
              onUseModelHeaders={() => setMapping(autoMapColumns(headers))}
              onContinue={handleContinue}
            />
          ) : null}
          {step === 2 ? (
            <>
              {validationErrors.length > 0 ? <div className="max-h-32 overflow-y-auto rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{validationErrors.slice(0, 20).map((error) => <p key={error}>• {error}</p>)}</div> : null}
              <p className="text-sm text-slate-600">Total linhas: <span className="font-semibold text-slate-900">{counters.total}</span> · <span className="font-semibold text-emerald-700">{counters.valid} válidas</span> · <span className="font-semibold text-rose-700">{counters.error} com erro</span></p>
              <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[980px] text-sm"><thead className="bg-slate-100 text-left text-slate-700"><tr><th className="px-3 py-2">Título</th><th className="px-3 py-2">Valor</th><th className="px-3 py-2">Estágio</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Motivo</th></tr></thead><tbody>{previewRows.length > 0 ? previewRows.slice(0, 200).map((row) => (<tr key={row.sourceRowNumber} className="border-t border-slate-200"><td className="px-3 py-2">{row.title || "—"}</td><td className="px-3 py-2">{row.value ?? "—"}</td><td className="px-3 py-2">{row.stage || "—"}</td><td className="px-3 py-2">{row.clientId || "—"}</td><td className="px-3 py-2">{row.status === "new" ? "NOVO" : "ERRO"}</td><td className="px-3 py-2">{row.errorMessage || "OK"}</td></tr>)) : <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">Envie um arquivo para visualizar o preview.</td></tr>}</tbody></table></div>
            </>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" onClick={reset} className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100">Cancelar</button>
          {step === 2 ? <button type="button" onClick={handleImport} disabled={isImporting || counters.valid === 0} className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60">{isImporting ? "Importando..." : `Importar ${counters.valid} oportunidades válidas`}</button> : null}
        </div>
      </div>
    </div>
  );
}
