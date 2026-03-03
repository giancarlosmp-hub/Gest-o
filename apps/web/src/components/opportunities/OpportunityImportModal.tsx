import { ChangeEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { normalizeTextValue, parseDecimalValue, parseImportFile } from "../../lib/import/parsers";

type OpportunityPreviewRow = {
  line: number;
  title: string;
  clientId: string;
  value?: number;
  stage: string;
  status: "valid" | "error";
  errorMessage?: string;
};

const TEMPLATE_HEADERS = ["title", "clientId", "value", "stage", "proposalDate", "expectedCloseDate", "crop", "season"];
const VALID_STAGES = new Set(["prospeccao", "negociacao", "proposta", "ganho", "perdido"]);

const parseCsvLine = (line: string) => {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
};

const parseCsvFile = async (file: File) => {
  const text = await file.text();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("O arquivo CSV deve conter cabeçalho e pelo menos uma linha de dados.");
  }

  const headers = parseCsvLine(lines[0]).map((header) => normalizeTextValue(header));
  const rows = lines.slice(1).map<Record<string, unknown>>((line) => {
    const values = parseCsvLine(line);
    return headers.reduce<Record<string, unknown>>((acc, header, index) => {
      acc[header] = values[index] ?? "";
      return acc;
    }, {});
  });

  return { headers, rows };
};

const downloadTemplate = () => {
  const example = [
    "Oportunidade exemplo",
    "CLI-001",
    "15000",
    "prospeccao",
    "2026-01-10",
    "2026-01-25",
    "Soja",
    "2026"
  ].join(",");

  const csvContent = `${TEMPLATE_HEADERS.join(",")}\n${example}`;
  const blob = new Blob([`\uFEFF${csvContent}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", "modelo-importacao-oportunidades.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
};

const buildPreviewRows = (rows: Record<string, unknown>[]) => {
  return rows.map<OpportunityPreviewRow>((row, index) => {
    const valueResult = parseDecimalValue((row as any).value);
    const stage = normalizeTextValue((row as any).stage).toLowerCase();

    const previewRow: OpportunityPreviewRow = {
      line: index + 2, // linha 1 é cabeçalho
      title: normalizeTextValue((row as any).title),
      clientId: normalizeTextValue((row as any).clientId),
      value: valueResult.isInvalid ? Number.NaN : valueResult.parsedValue,
      stage,
      status: "valid"
    };

    const errors: string[] = [];
    if (!previewRow.title) errors.push("Título obrigatório");
    if (!previewRow.clientId) errors.push("Cliente (ID) obrigatório");

    if (previewRow.value === undefined || Number.isNaN(previewRow.value) || previewRow.value <= 0) {
      errors.push("Valor deve ser numérico e maior que zero");
    }

    if (stage && !VALID_STAGES.has(stage)) errors.push("Estágio inválido");

    if (errors.length) {
      previewRow.status = "error";
      previewRow.errorMessage = errors.join(" · ");
    }

    return previewRow;
  });
};

export default function OpportunityImportModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [fileName, setFileName] = useState("");
  const [previewRows, setPreviewRows] = useState<OpportunityPreviewRow[]>([]);
  const [isImporting, setIsImporting] = useState(false);

  const counters = useMemo(
    () => ({
      totalRead: previewRows.length,
      valid: previewRows.filter((row) => row.status === "valid").length,
      error: previewRows.filter((row) => row.status === "error").length
    }),
    [previewRows]
  );

  const reset = () => {
    setFileName("");
    setPreviewRows([]);
    setIsImporting(false);
    onClose();
  };

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
      const parsed = lowerName.endsWith(".csv") ? await parseCsvFile(selectedFile) : await parseImportFile(selectedFile);
      setPreviewRows(buildPreviewRows(parsed.rows));
    } catch (error: any) {
      toast.error(error.message || "Não foi possível processar o arquivo selecionado.");
      setPreviewRows([]);
    }
  };

  const handleImport = async () => {
    if (!previewRows.length || counters.error > 0) return;

    // IMPORT REAL será adicionado depois (chamar endpoint de import)
    setIsImporting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      toast.success("Importação simulada com sucesso. A persistência será adicionada em breve.");
      reset();
    } catch {
      toast.error("Erro ao importar oportunidades.");
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
              onClick={downloadTemplate}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Baixar modelo
            </button>

            <input
              type="file"
              accept=".csv,.xlsx"
              onChange={handleFileChange}
              className="block w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-brand-700 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-800"
            />

            {fileName ? <span className="text-xs text-slate-500">Arquivo: {fileName}</span> : null}
          </div>

          <p className="text-sm text-slate-600">
            Linhas lidas: <span className="font-semibold text-slate-900">{counters.totalRead}</span> ·{" "}
            <span className="font-semibold text-emerald-700">{counters.valid} válidas</span> ·{" "}
            <span className="font-semibold text-rose-700">{counters.error} com erro</span>
          </p>

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
                      <td className="px-3 py-2">{row.title || "—"}</td>
                      <td className="px-3 py-2">{row.clientId || "—"}</td>
                      <td className="px-3 py-2">{row.value ?? "—"}</td>
                      <td className="px-3 py-2">{row.stage || "—"}</td>
                      <td className="px-3 py-2">{row.status === "valid" ? "VÁLIDO" : "ERRO"}</td>
                      <td className="px-3 py-2">{row.errorMessage || "OK"}</td>
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
            {isImporting ? "Importando..." : "Importar"}
          </button>
        </div>
      </div>
    </div>
  );
}