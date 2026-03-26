import { ChangeEvent, Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  normalizeHeader,
  normalizeTextValue,
  parseDecimalValue,
  parseImportFile,
} from "../../lib/import/parsers";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";
import { useAuth } from "../../context/AuthContext";
import ClientSearchSelect from "../clients/ClientSearchSelect";

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
  manuallyCorrected?: boolean;
};

type OpportunityImportFieldKey =
  | "title"
  | "clientNameOrId"
  | "cnpj"
  | "city"
  | "state"
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

const PAGE_SIZE = 20;
type PreviewStatusFilter = "all" | "valid" | "error" | "duplicate";

type ExistingClientOption = {
  id: string;
  name: string;
  city?: string | null;
  state?: string | null;
  cnpj?: string | null;
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
  failed?: number;
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

type OpportunityImportResultRow = {
  line: number;
  client: string;
  title: string;
  status: "created" | "updated" | "ignored" | "error";
  reason: string;
};

type OpportunityImportResultSummary = {
  created: number;
  updated: number;
  ignored: number;
  errors: number;
  rows: OpportunityImportResultRow[];
};

const REQUIRED_FIELDS: OpportunityImportFieldKey[] = [
  "title",
  "clientNameOrId",
  "value",
  "stage",
  "probability",
];
const VALID_STAGES = new Set(["prospeccao", "negociacao", "proposta", "ganho"]);
const VALID_STATUS = new Set(["open", "closed"]);

const FALLBACK_DICTIONARY: OpportunityImportDictionary = {
  columns: [
    { key: "titulo", required: true, example: "Algodão Safra 25/26" },
    { key: "cliente", required: true, example: "Coop X" },
    {
      key: "vendedor_responsavel",
      required: true,
      notes: "nome do vendedor; também aceitamos email_responsavel",
    },
    {
      key: "email_responsavel",
      required: true,
      notes: "compatível com arquivos legados",
    },
    {
      key: "etapa",
      required: true,
      accepted: ["prospeccao", "negociacao", "proposta", "ganho"],
    },
    {
      key: "valor",
      required: true,
      example: "52000.00",
      notes: "use ponto como decimal",
    },
    { key: "probabilidade", required: true, notes: "0 a 100" },
    {
      key: "data_entrada",
      required: true,
      notes: "aceita yyyy-mm-dd ou dd/mm/aaaa",
    },
    {
      key: "follow_up",
      required: true,
      notes: "aceita yyyy-mm-dd ou dd/mm/aaaa",
    },
    { key: "area_ha", required: false },
    { key: "ticket_esperado_ha", required: false },
    { key: "cultura", required: false },
    { key: "safra", required: false },
    { key: "produto_ofertado", required: false },
    {
      key: "fechamento_previsto",
      required: false,
      notes: "aceita yyyy-mm-dd ou dd/mm/aaaa",
    },
    {
      key: "ultimo_contato",
      required: false,
      notes: "aceita yyyy-mm-dd ou dd/mm/aaaa",
    },
    { key: "observacoes", required: false },
    { key: "status", required: false, accepted: ["open", "closed"] },
  ],
  tips: [
    "Se 'cliente' não existir e a opção 'Criar cliente automaticamente' estiver ligada, será criado como PJ com dados mínimos.",
    "Etapa inválida vira erro na linha (não bloqueia o arquivo todo).",
    "Datas inválidas viram erro na linha.",
  ],
};

const IMPORT_FIELDS: OpportunityImportField[] = [
  {
    key: "title",
    label: "Título",
    required: true,
    aliases: [
      "title",
      "titulo",
      "nome da oportunidade",
      "oportunidade",
      "opportunity",
    ],
  },
  {
    key: "clientNameOrId",
    label: "Cliente",
    required: true,
    aliases: [
      "clientnameorid",
      "cliente",
      "clienteid",
      "clientid",
      "nome do cliente",
      "cliente nome",
    ],
  },
  {
    key: "cnpj",
    label: "CNPJ do cliente",
    required: false,
    aliases: ["cnpj", "cnpj_cliente", "documento_cliente", "documento"],
  },
  {
    key: "city",
    label: "Cidade do cliente",
    required: false,
    aliases: ["city", "cidade", "cidade_cliente"],
  },
  {
    key: "state",
    label: "UF do cliente",
    required: false,
    aliases: ["state", "uf", "estado", "uf_cliente", "estado_cliente"],
  },
  {
    key: "value",
    label: "Valor",
    required: false,
    aliases: ["value", "valor", "valor total", "amount"],
  },
  {
    key: "stage",
    label: "Etapa",
    required: false,
    aliases: ["stage", "etapa", "fase"],
  },
  {
    key: "status",
    label: "Status",
    required: false,
    aliases: ["status", "situacao"],
  },
  {
    key: "ownerEmail",
    label: "E-mail do responsável",
    required: false,
    aliases: [
      "owneremail",
      "responsavelemail",
      "emailresponsavel",
      "email_responsavel",
      "email",
      "responsavel",
      "vendedor",
      "responsavelemail",
    ],
  },
  {
    key: "ownerSellerName",
    label: "Vendedor responsável",
    required: false,
    aliases: [
      "vendedor_responsavel",
      "vendedorresponsavel",
      "nomeresponsavel",
      "responsavel_nome",
      "ownersellername",
    ],
  },
  {
    key: "followUpDate",
    label: "Data de follow-up",
    required: false,
    aliases: [
      "followupdate",
      "followup",
      "follow_up",
      "dataseguimento",
      "datafollowup",
    ],
  },
  {
    key: "proposalDate",
    label: "Data de entrada",
    required: false,
    aliases: ["proposaldate", "data_entrada", "dataentrada", "data de entrada"],
  },
  {
    key: "expectedCloseDate",
    label: "Fechamento previsto",
    required: false,
    aliases: ["expectedclosedate", "fechamento_previsto", "fechamentoprevisto"],
  },
  {
    key: "lastContactAt",
    label: "Último contato",
    required: false,
    aliases: ["lastcontactat", "ultimo_contato", "ultimocontato"],
  },
  {
    key: "probability",
    label: "Probabilidade (%)",
    required: false,
    aliases: ["probability", "probabilidade"],
  },
  {
    key: "notes",
    label: "Observações",
    required: false,
    aliases: ["notes", "observacoes", "observação", "comentarios"],
  },
  {
    key: "areaHa",
    label: "Área (ha)",
    required: false,
    aliases: ["area_ha", "areaha"],
  },
  {
    key: "expectedTicketPerHa",
    label: "Ticket esperado/ha",
    required: false,
    aliases: ["ticket_esperado_ha", "ticketesperadoha", "expectedticketperha"],
  },
  {
    key: "crop",
    label: "Cultura",
    required: false,
    aliases: ["crop", "cultura"],
  },
  {
    key: "season",
    label: "Safra",
    required: false,
    aliases: ["season", "safra"],
  },
  {
    key: "productOffered",
    label: "Produto ofertado",
    required: false,
    aliases: ["productoffered", "produto_ofertado", "produtoofertado"],
  },
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
  "status",
];
const TEMPLATE_EXAMPLE_ROWS = [
  [
    "Algodão Safra 25/26",
    "Coop X",
    "Carlos Silva",
    "vendedor@empresa.com",
    "prospeccao",
    "52000.00",
    "20",
    "2026-01-04",
    "2026-01-10",
    "120",
    "430.00",
    "algodao",
    "2025/26",
    "Programa Algodão Premium",
    "2026-02-15",
    "2026-01-08",
    "Primeiro contato via WhatsApp",
    "open",
  ],
  [
    "Milho Verão Lote 3",
    "Fazenda São Pedro",
    "Aline Souza",
    "comercial@empresa.com",
    "negociacao",
    "148000.50",
    "55",
    "2026-01-18",
    "15/02/2026",
    "210",
    "705.50",
    "milho",
    "2025/26",
    "Pacote Nutrição Verão",
    "2026-03-05",
    "2026-02-02",
    "Cliente pediu ajuste de prazo",
    "open",
  ],
  [
    "Soja Premium Exportação",
    "Coop X",
    "Carlos Silva",
    "vendedor@empresa.com",
    "proposta",
    "93000.00",
    "75",
    "2026-01-25",
    "2026-02-20",
    "175",
    "531.43",
    "soja",
    "2025/26",
    "Soja Premium Export",
    "2026-03-18",
    "2026-02-10",
    "Proposta enviada por e-mail",
    "open",
  ],
  [
    "Fertilizante NPK 20-10",
    "Novo Cliente Horizonte",
    "Aline Souza",
    "comercial@empresa.com",
    "prospeccao",
    "41000.00",
    "30",
    "2026-01-06",
    "28/01/2026",
    "80",
    "512.50",
    "outros",
    "2025/26",
    "NPK 20-10",
    "2026-02-28",
    "2026-01-17",
    "Novo cliente para testar criação automática",
    "open",
  ],
  [
    "Defensivo Programa Safra",
    "Fazenda São Pedro",
    "Carlos Silva",
    "vendedor@empresa.com",
    "ganho",
    "125500.00",
    "100",
    "2026-02-01",
    "2026-03-05",
    "260",
    "482.69",
    "soja",
    "2025/26",
    "Programa Safra Completo",
    "2026-03-05",
    "2026-03-04",
    "Pedido confirmado",
    "closed",
  ],
];

const IMPORT_RESULT_STATUS_META: Record<
  OpportunityImportResultRow["status"],
  { label: string; badgeClassName: string; rowClassName: string }
> = {
  created: {
    label: "Criada",
    badgeClassName: "bg-emerald-100 text-emerald-800",
    rowClassName: "bg-emerald-50",
  },
  updated: {
    label: "Atualizada",
    badgeClassName: "bg-blue-100 text-blue-800",
    rowClassName: "bg-blue-50",
  },
  ignored: {
    label: "Ignorada",
    badgeClassName: "bg-amber-100 text-amber-800",
    rowClassName: "bg-amber-50",
  },
  error: {
    label: "Erro",
    badgeClassName: "bg-rose-100 text-rose-800",
    rowClassName: "bg-rose-50",
  },
};

const getSavedMappingForUser = (
  userId?: string | null,
): Partial<Record<OpportunityImportFieldKey, string>> => {
  if (!userId) return {};

  try {
    const rawValue = localStorage.getItem(
      `${LOCAL_STORAGE_MAPPING_KEY}:${userId}`,
    );
    if (!rawValue) return {};
    return JSON.parse(rawValue) as Partial<
      Record<OpportunityImportFieldKey, string>
    >;
  } catch {
    return {};
  }
};

const saveMappingForUser = (
  userId: string | undefined,
  mapping: Partial<Record<OpportunityImportFieldKey, string>>,
) => {
  if (!userId) return;
  localStorage.setItem(
    `${LOCAL_STORAGE_MAPPING_KEY}:${userId}`,
    JSON.stringify(mapping),
  );
};

const suggestColumnMapping = (
  headers: string[],
  savedMapping: Partial<Record<OpportunityImportFieldKey, string>>,
): Partial<Record<OpportunityImportFieldKey, string>> => {
  const headersByNormalized = new Map(
    headers.map((header) => [normalizeHeader(header), header]),
  );

  return IMPORT_FIELDS.reduce<
    Partial<Record<OpportunityImportFieldKey, string>>
  >((acc, field) => {
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

const buildPreviewRows = (
  rows: Record<string, unknown>[],
  mapping: Partial<Record<OpportunityImportFieldKey, string>>,
) => {
  const getMappedValue = (
    row: Record<string, unknown>,
    field: OpportunityImportFieldKey,
  ) => {
    const mappedHeader = mapping[field];
    if (!mappedHeader) return "";
    return row[mappedHeader];
  };

  const previewRows = rows.map<OpportunityPreviewRow>((row, index) => {
    const valueResult = parseDecimalValue(getMappedValue(row, "value"));
    const stage = normalizeTextValue(
      getMappedValue(row, "stage"),
    ).toLowerCase();
    const status = normalizeTextValue(
      getMappedValue(row, "status"),
    ).toLowerCase();
    const probabilityResult = parseDecimalValue(
      getMappedValue(row, "probability"),
    );
    const probability = probabilityResult.isInvalid
      ? Number.NaN
      : probabilityResult.parsedValue;
    const followUpDate = normalizeTextValue(
      getMappedValue(row, "followUpDate"),
    );
    const cnpj = normalizeTextValue(getMappedValue(row, "cnpj"));
    const city = normalizeTextValue(getMappedValue(row, "city"));
    const state = normalizeTextValue(getMappedValue(row, "state"));

    const title = normalizeTextValue(getMappedValue(row, "title"));
    const clientNameOrId = normalizeTextValue(
      getMappedValue(row, "clientNameOrId"),
    );
    const ownerEmail = normalizeTextValue(getMappedValue(row, "ownerEmail"));
    const ownerSellerName = normalizeTextValue(
      getMappedValue(row, "ownerSellerName"),
    );
    const areaHaResult = parseDecimalValue(getMappedValue(row, "areaHa"));
    const expectedTicketPerHaResult = parseDecimalValue(
      getMappedValue(row, "expectedTicketPerHa"),
    );
    const proposalDate = normalizeTextValue(
      getMappedValue(row, "proposalDate"),
    );
    const expectedCloseDate = normalizeTextValue(
      getMappedValue(row, "expectedCloseDate"),
    );
    const lastContactAt = normalizeTextValue(
      getMappedValue(row, "lastContactAt"),
    );

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
        cnpj: cnpj || undefined,
        city: city || undefined,
        state: state || undefined,
        followUpDate: followUpDate || undefined,
        proposalDate: proposalDate || undefined,
        expectedCloseDate: expectedCloseDate || undefined,
        lastContactAt: lastContactAt || undefined,
        probability:
          probability === undefined || Number.isNaN(probability)
            ? undefined
            : Number(probability),
        notes: normalizeTextValue(getMappedValue(row, "notes")) || undefined,
        areaHa: areaHaResult.isInvalid ? undefined : areaHaResult.parsedValue,
        expectedTicketPerHa: expectedTicketPerHaResult.isInvalid
          ? undefined
          : expectedTicketPerHaResult.parsedValue,
        crop: normalizeTextValue(getMappedValue(row, "crop")) || undefined,
        season: normalizeTextValue(getMappedValue(row, "season")) || undefined,
        productOffered:
          normalizeTextValue(getMappedValue(row, "productOffered")) ||
          undefined,
      },
      status: "new",
      invalidFields: [],
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

    if (
      valueResult.isInvalid ||
      valueResult.parsedValue === undefined ||
      Number(valueResult.parsedValue) <= 0
    ) {
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
    if (
      followUpDate &&
      !/^\d{4}-\d{2}-\d{2}$/.test(followUpDate) &&
      !/^\d{2}\/\d{2}\/\d{4}$/.test(followUpDate)
    ) {
      errors.push("data inválida");
      invalidFields.add("followUpDate");
    }
    if (
      proposalDate &&
      !/^\d{4}-\d{2}-\d{2}$/.test(proposalDate) &&
      !/^\d{2}\/\d{2}\/\d{4}$/.test(proposalDate)
    ) {
      errors.push("data inválida");
      invalidFields.add("proposalDate");
    }
    if (
      expectedCloseDate &&
      !/^\d{4}-\d{2}-\d{2}$/.test(expectedCloseDate) &&
      !/^\d{2}\/\d{2}\/\d{4}$/.test(expectedCloseDate)
    ) {
      errors.push("data inválida");
      invalidFields.add("expectedCloseDate");
    }
    if (
      lastContactAt &&
      !/^\d{4}-\d{2}-\d{2}$/.test(lastContactAt) &&
      !/^\d{2}\/\d{2}\/\d{4}$/.test(lastContactAt)
    ) {
      errors.push("data inválida");
      invalidFields.add("lastContactAt");
    }
    if (
      probability === undefined ||
      Number.isNaN(probability) ||
      probability < 0 ||
      probability > 100
    ) {
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
    const payload = row.payload as {
      ownerEmail?: string;
      ownerSellerName?: string;
    };
    const ownerKey = (
      payload.ownerEmail ||
      payload.ownerSellerName ||
      ""
    ).toLowerCase();
    const key = [
      row.clientId.toLowerCase(),
      row.title.toLowerCase(),
      row.stage.toLowerCase(),
      ownerKey,
    ].join("|");
    if (seenKeys.has(key)) {
      row.status = "error";
      row.reason = row.reason
        ? `${row.reason} · linha duplicada no arquivo`
        : "linha duplicada no arquivo";
    } else {
      seenKeys.add(key);
    }
  }

  return previewRows;
};

function OpportunityImportResultModal({
  result,
  onClose,
  onExportCsv,
}: {
  result: OpportunityImportResultSummary;
  onClose: () => void;
  onExportCsv: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
        <div className="shrink-0 border-b border-slate-200 px-6 pb-4 pt-6">
          <h3 className="text-xl font-semibold text-slate-900">
            Importação concluída
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Resultado detalhado por linha.
          </p>
          <div className="mt-4 grid gap-2 text-sm sm:grid-cols-4">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 font-medium text-emerald-800">
              Criadas: {result.created}
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 font-medium text-blue-800">
              Atualizadas: {result.updated}
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 font-medium text-amber-800">
              Ignoradas: {result.ignored}
            </div>
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 font-medium text-rose-800">
              Erros: {result.errors}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="px-3 py-2">Linha</th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2">Título</th>
                  <th className="px-3 py-2">Resultado</th>
                  <th className="px-3 py-2">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => {
                  const statusMeta = IMPORT_RESULT_STATUS_META[row.status];
                  return (
                    <tr
                      key={`${row.line}-${row.title}-${row.client}`}
                      className={`border-t border-slate-200 ${statusMeta.rowClassName}`}
                    >
                      <td className="px-3 py-2">{row.line}</td>
                      <td className="px-3 py-2">{row.client || "—"}</td>
                      <td className="px-3 py-2">{row.title || "—"}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${statusMeta.badgeClassName}`}
                        >
                          {statusMeta.label}
                        </span>
                      </td>
                      <td className="px-3 py-2">{row.reason || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-slate-200 px-6 py-4">
          <button
            type="button"
            onClick={onExportCsv}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
          >
            Exportar resultado (.csv)
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OpportunityImportModal({
  isOpen,
  onClose,
  onImported,
}: {
  isOpen: boolean;
  onClose: () => void;
  onImported?: () => Promise<void> | void;
}) {
  const { user } = useAuth();
  const [fileName, setFileName] = useState("");
  const [detectedHeaders, setDetectedHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [mapping, setMapping] = useState<
    Partial<Record<OpportunityImportFieldKey, string>>
  >({});
  const [previewRows, setPreviewRows] = useState<OpportunityPreviewRow[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<PreviewStatusFilter>("all");
  const [expandedLines, setExpandedLines] = useState<number[]>([]);
  const [clients, setClients] = useState<ExistingClientOption[]>([]);
  const [selectingClientForLine, setSelectingClientForLine] = useState<
    number | null
  >(null);
  const [isImporting, setIsImporting] = useState(false);
  const [dictionary, setDictionary] =
    useState<OpportunityImportDictionary>(FALLBACK_DICTIONARY);
  const [importResult, setImportResult] =
    useState<OpportunityImportResultSummary | null>(null);

  // ✅ Mantém as duas opções (resolve o conflito)
  const [isDryRun, setIsDryRun] = useState(false);
  const [createClientIfMissing, setCreateClientIfMissing] = useState(false);
  const [dedupeEnabled, setDedupeEnabled] = useState(true);
  const [dedupeWindowDays, setDedupeWindowDays] = useState(30);
  const [dedupeCompareStatuses, setDedupeCompareStatuses] = useState<
    "open_only" | "open_and_closed"
  >("open_only");
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
    const blob = new Blob([utf8Bom, `${csvContent}\r\n`], {
      type: "text/csv;charset=utf-8;",
    });
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
    downloadCsvFile("opportunities-import-example.csv", [
      TEMPLATE_HEADERS,
      ...TEMPLATE_EXAMPLE_ROWS,
    ]);
  };

  const isDuplicateRow = (row: OpportunityPreviewRow) =>
    row.status === "ignored" || row.status === "update";
  const isValidRow = (row: OpportunityPreviewRow) =>
    row.status !== "error" && !isDuplicateRow(row);
  const isAmbiguousClientError = (row: OpportunityPreviewRow) => {
    if (row.status !== "error" || !row.reason) return false;
    const reason = row.reason.toLowerCase();
    return (
      reason.includes("cliente amb") ||
      reason.includes("cliente duplic") ||
      reason.includes("múltiplos clientes") ||
      reason.includes("multiplos clientes")
    );
  };
  const isMissingClientError = (row: OpportunityPreviewRow) => {
    if (row.status !== "error" || !row.reason) return false;
    const reason = row.reason.toLowerCase();
    return (
      reason.includes("cliente não encontrado") ||
      reason.includes("cliente nao encontrado")
    );
  };

  const counters = useMemo(
    () => ({
      totalRead: previewRows.length,
      valid: previewRows.filter((row) => isValidRow(row)).length,
      duplicate: previewRows.filter((row) => isDuplicateRow(row)).length,
      error: previewRows.filter((row) => row.status === "error").length,
      importable: previewRows.filter(
        (row) => row.status === "new" || row.status === "update",
      ).length,
    }),
    [previewRows],
  );

  const filteredRows = useMemo(() => {
    if (statusFilter === "valid") {
      return previewRows.filter((row) => isValidRow(row));
    }
    if (statusFilter === "error") {
      return previewRows.filter((row) => row.status === "error");
    }
    if (statusFilter === "duplicate") {
      return previewRows.filter((row) => isDuplicateRow(row));
    }
    return previewRows;
  }, [previewRows, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const page = Math.min(currentPage, totalPages);
  const paginatedRows = filteredRows.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );

  const toggleExpandLine = (line: number) => {
    setExpandedLines((current) =>
      current.includes(line)
        ? current.filter((item) => item !== line)
        : [...current, line],
    );
  };

  const handleEditableFieldChange = (
    line: number,
    field: "value" | "stage" | "status",
    value: string,
  ) => {
    setPreviewRows((currentRows) =>
      currentRows.map((row) => {
        if (row.line !== line) return row;

        const nextInvalidFields = new Set(row.invalidFields || []);
        const nextPayload = { ...row.payload };
        const nextRow: OpportunityPreviewRow = { ...row };

        if (field === "value") {
          const parsed = parseDecimalValue(value);
          const isInvalidValue =
            parsed.isInvalid ||
            parsed.parsedValue === undefined ||
            Number(parsed.parsedValue) <= 0;
          nextRow.value = isInvalidValue ? Number.NaN : parsed.parsedValue;
          nextPayload.value = isInvalidValue ? undefined : parsed.parsedValue;
          if (isInvalidValue) nextInvalidFields.add("value");
          else nextInvalidFields.delete("value");
        }

        if (field === "stage") {
          const normalizedStage = normalizeTextValue(value).toLowerCase();
          nextRow.stage = normalizedStage;
          nextPayload.stage = normalizedStage || undefined;
          if (!normalizedStage || !VALID_STAGES.has(normalizedStage))
            nextInvalidFields.add("stage");
          else nextInvalidFields.delete("stage");
        }

        if (field === "status") {
          const normalizedStatus = normalizeTextValue(value).toLowerCase();
          nextPayload.status = normalizedStatus || undefined;
          if (normalizedStatus && !VALID_STATUS.has(normalizedStatus))
            nextInvalidFields.add("status");
          else nextInvalidFields.delete("status");
        }

        const nextReasonParts = (row.reason || "")
          .split(" · ")
          .filter(
            (reason) =>
              reason &&
              reason !== "valor inválido" &&
              reason !== "etapa inválida" &&
              reason !== "status inválido",
          );
        if (nextInvalidFields.has("value"))
          nextReasonParts.push("valor inválido");
        if (nextInvalidFields.has("stage"))
          nextReasonParts.push("etapa inválida");
        if (nextInvalidFields.has("status"))
          nextReasonParts.push("status inválido");
        nextRow.reason = nextReasonParts.length
          ? nextReasonParts.join(" · ")
          : undefined;
        nextRow.status = nextReasonParts.length ? "error" : "new";
        nextRow.invalidFields = Array.from(nextInvalidFields);
        nextRow.payload = nextPayload;
        return nextRow;
      }),
    );
  };

  const handleClientSelection = (rowLine: number, clientId: string) => {
    const selectedClient = clients.find((client) => client.id === clientId);
    if (!selectedClient) return;

    setPreviewRows((currentRows) =>
      currentRows.map((row) => {
        if (row.line !== rowLine) return row;

        const nextPayload = {
          ...row.payload,
          clientNameOrId: selectedClient.id,
          clientId: selectedClient.id,
        };
        const nextInvalidFields = (row.invalidFields || []).filter(
          (field) => field !== "clientNameOrId",
        );
        const nextReason = (row.reason || "")
          .split(" · ")
          .filter(
            (reason) =>
              reason &&
              !reason.toLowerCase().includes("cliente amb") &&
              reason !== "cliente obrigatório",
          )
          .join(" · ");

        return {
          ...row,
          clientId: selectedClient.id,
          payload: nextPayload,
          invalidFields: nextInvalidFields,
          reason: nextReason || undefined,
          status: nextReason ? "error" : "new",
          manuallyCorrected: true,
        };
      }),
    );

    setSelectingClientForLine(null);
  };

  const resetState = () => {
    setFileName("");
    setDetectedHeaders([]);
    setRawRows([]);
    setMapping({});
    setPreviewRows([]);
    setCurrentPage(1);
    setStatusFilter("all");
    setExpandedLines([]);
    setClients([]);
    setSelectingClientForLine(null);
    setIsImporting(false);
    setIsDryRun(false);
    setCreateClientIfMissing(false);
    setDedupeEnabled(true);
    setDedupeWindowDays(30);
    setDedupeCompareStatuses("open_only");
    setDedupeMode("skip");
  };

  const reset = () => {
    resetState();
    onClose();
  };

  useEffect(() => {
    const loadDictionary = async () => {
      try {
        const { data } = await api.get<OpportunityImportDictionary>(
          "/opportunities/import/dictionary",
        );
        if (data?.columns?.length) setDictionary(data);
      } catch {
        setDictionary(FALLBACK_DICTIONARY);
      }
    };

    loadDictionary();
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const loadClients = async () => {
      try {
        const { data } = await api.get<
          { clients?: ExistingClientOption[] } | ExistingClientOption[]
        >("/clients");
        const loadedClients = Array.isArray(data) ? data : data?.clients || [];
        setClients(
          loadedClients.map((client) => ({
            id: client.id,
            name: client.name,
            city: client.city,
            state: client.state,
            cnpj: client.cnpj,
          })),
        );
      } catch {
        setClients([]);
      }
    };

    loadClients();
  }, [isOpen]);

  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, previewRows]);

  useEffect(() => {
    setExpandedLines([]);
  }, [statusFilter, currentPage]);

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
      const resolvedMapping = suggestColumnMapping(
        parsed.headers,
        getSavedMappingForUser(user?.id),
      );
      setMapping(resolvedMapping);
      const missingRequired = REQUIRED_FIELDS.filter(
        (field) => !resolvedMapping[field],
      );
      if (missingRequired.length) {
        toast.warning(
          "Faltam colunas obrigatórias no arquivo: titulo e cliente.",
        );
      }
      const nextPreviewRows = buildPreviewRows(parsed.rows, resolvedMapping);
      setPreviewRows(await runDedupePreview(nextPreviewRows));
    } catch (error: any) {
      toast.error(
        error.message || "Não foi possível processar o arquivo selecionado.",
      );
      setDetectedHeaders([]);
      setRawRows([]);
      setMapping({});
      setPreviewRows([]);
    }
  };

  const runDedupePreview = async (rows: OpportunityPreviewRow[]) => {
    if (!rows.length) return rows;

    try {
      const { data } = await api.post<OpportunityImportResponse>(
        "/opportunities/import/preview",
        {
          rows: rows.map((row) => row.payload),
          options: {
            createClientIfMissing,
            dedupe: {
              enabled: dedupeEnabled,
              windowDays: dedupeWindowDays,
              compareStatuses: dedupeCompareStatuses,
              mode: dedupeMode,
            },
          },
        },
      );

      const resultByRow = new Map(
        (data.rowResults || []).map((item) => [item.row, item]),
      );

      return rows.map<OpportunityPreviewRow>((row, index) => {
        const result = resultByRow.get(index + 1);
        if (!result) return row;

        if (result.status === "created")
          return { ...row, status: "new" as const, reason: undefined };
        if (result.status === "updated")
          return { ...row, status: "update" as const, reason: undefined };

        if (result.status === "ignored") {
          return {
            ...row,
            status: "ignored" as const,
            reason:
              result.message ||
              (result.reason === "duplicate"
                ? "duplicada no sistema"
                : "linha ignorada"),
          };
        }

        return {
          ...row,
          status: "error" as const,
          reason: result.message || "Erro de validação",
          invalidFields:
            result.reason === "client_ambiguous" ||
            result.reason === "client_missing"
              ? Array.from(
                  new Set([...(row.invalidFields || []), "clientNameOrId"]),
                )
              : row.invalidFields,
        };
      });
    } catch {
      return rows;
    }
  };

  const handleApplyMapping = async () => {
    const missingRequired = REQUIRED_FIELDS.filter((field) => !mapping[field]);
    if (missingRequired.length) {
      toast.warning(
        "Mapeie as colunas obrigatórias: Título, Cliente, Valor, Etapa e Probabilidade.",
      );
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
      const importableRows = previewRows.filter(
        (row) => row.status === "new" || row.status === "update",
      );
      const validRows = importableRows.map((row) => row.payload);

      const { data } = await api.post<OpportunityImportResponse>(
        "/opportunities/import",
        {
          rows: validRows,
          options: {
            dryRun: isDryRun,
            createClientIfMissing,
            dedupe: {
              enabled: dedupeEnabled,
              windowDays: dedupeWindowDays,
              compareStatuses: dedupeCompareStatuses,
              mode: dedupeMode,
            },
          },
        },
      );

      const created =
        data?.created ?? data?.totalCreated ?? data?.totalImportados ?? 0;
      const updated = data?.updated ?? 0;
      const ignored =
        data?.ignored ??
        data?.skipped ??
        data?.totalIgnored ??
        data?.totalIgnorados ??
        0;
      const errors = data?.errors ?? [];
      const rowResults = data?.rowResults ?? [];
      const failed = data?.failed ?? errors.length;

      const resultRows: OpportunityImportResultRow[] = rowResults.length
        ? rowResults.map((result, index) => {
            const matchingRow =
              importableRows.find((row) => row.line === result.row) ??
              importableRows[result.row - 1] ??
              importableRows[index];
            return {
              line: matchingRow?.line ?? result.row ?? index + 1,
              client:
                matchingRow?.clientId ??
                String(
                  (matchingRow?.payload as { clientNameOrId?: string })
                    ?.clientNameOrId || "",
                ),
              title:
                matchingRow?.title ??
                String(
                  (matchingRow?.payload as { title?: string })?.title || "",
                ),
              status: result.status,
              reason:
                result.reason ||
                result.message ||
                (result.status === "created"
                  ? "Registro criado com sucesso"
                  : result.status === "updated"
                    ? "Registro atualizado com sucesso"
                    : result.status === "ignored"
                      ? "Linha ignorada"
                      : "Erro na importação"),
            };
          })
        : importableRows.map((row, index) => ({
            line: row.line,
            client: row.clientId,
            title: row.title,
            status: "error" as const,
            reason:
              errors[index]?.message ||
              "Sem detalhe por linha retornado pelo backend",
          }));

      toast.success(
        `${isDryRun ? "Simulação concluída" : "Concluído"}: ${created} importados, ${updated} atualizados, ${ignored} ignorados, ${errors.length} falhas`,
        {
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
                          return (
                            <li key={`${row}-${index}`}>
                              Linha {row}:{" "}
                              {item.message || "Erro não especificado"}
                            </li>
                          );
                        })}
                      </ul>
                    </div>,
                  );
                },
              }
            : undefined,
        },
      );

      if (errors.length) {
        toast.message(`${errors.length} linha(s) com erro na importação.`);
      }

      await onImported?.();
      resetState();
      onClose();
      setImportResult({
        created,
        updated,
        ignored,
        errors: failed,
        rows: resultRows,
      });
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Erro ao importar oportunidades."));
    } finally {
      setIsImporting(false);
    }
  };

  const handleExportImportResultCsv = () => {
    if (!importResult) return;
    const rows = [
      ["linha", "cliente", "titulo", "resultado", "motivo"],
      ...importResult.rows.map((row) => [
        String(row.line),
        row.client || "",
        row.title || "",
        IMPORT_RESULT_STATUS_META[row.status].label,
        row.reason || "",
      ]),
    ];
    downloadCsvFile("opportunities-import-result.csv", rows);
  };

  if (!isOpen && !importResult) return null;

  return (
    <>
      {isOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="shrink-0 border-b border-slate-200 px-6 pb-4 pt-6">
              <h3 className="text-xl font-semibold text-slate-900">
                Importar oportunidades
              </h3>
              <p className="text-sm text-slate-500">
                Importe oportunidades via planilha (CSV ou XLSX).
              </p>
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

                {fileName ? (
                  <span className="text-xs text-slate-500">
                    Arquivo: {fileName}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-slate-700">
                <p className="mb-2 font-semibold text-slate-900">
                  Ajuda rápida
                </p>
                <p>
                  Etapas aceitas:{" "}
                  {dictionary.columns
                    .find((item) => item.key === "etapa")
                    ?.accepted?.join(", ") ||
                    "prospeccao, negociacao, proposta, ganho"}
                </p>
                <p>
                  Status aceitos:{" "}
                  {dictionary.columns
                    .find((item) => item.key === "status")
                    ?.accepted?.join(", ") || "open, closed"}
                </p>
                <p>
                  Data de follow-up:{" "}
                  {dictionary.columns.find((item) => item.key === "follow_up")
                    ?.notes || "aceita yyyy-mm-dd ou dd/mm/aaaa"}
                </p>
              </div>

              <p className="text-sm text-slate-600">
                Linhas lidas:{" "}
                <span className="font-semibold text-slate-900">
                  {counters.totalRead}
                </span>{" "}
                ·{" "}
                <span className="font-semibold text-emerald-700">
                  {counters.valid} válidas
                </span>{" "}
                ·{" "}
                <span className="font-semibold text-amber-700">
                  {counters.duplicate} duplicadas
                </span>{" "}
                ·{" "}
                <span className="font-semibold text-rose-700">
                  {counters.error} com erro
                </span>
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
                    onChange={(event) =>
                      setCreateClientIfMissing(event.target.checked)
                    }
                    className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-500"
                    disabled={isImporting}
                  />
                  Criar cliente automaticamente quando não encontrado
                </label>
              </div>

              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-800">
                  Proteção anti-duplicados
                </p>
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300"
                    checked={dedupeEnabled}
                    onChange={(event) => setDedupeEnabled(event.target.checked)}
                    disabled={isImporting}
                  />
                  Evitar duplicados automaticamente
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-sm text-slate-700">
                    Janela de comparação (dias)
                    <input
                      type="number"
                      min={7}
                      max={180}
                      value={dedupeWindowDays}
                      onChange={(event) =>
                        setDedupeWindowDays(
                          Math.max(
                            7,
                            Math.min(180, Number(event.target.value) || 30),
                          ),
                        )
                      }
                      className="mt-1 w-full rounded-lg border border-slate-300 p-2"
                      disabled={isImporting || !dedupeEnabled}
                    />
                  </label>
                  <div className="text-sm text-slate-700">
                    <p className="mb-1">Comparar com status</p>
                    <label className="mr-4 inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name="dedupe-status"
                        checked={dedupeCompareStatuses === "open_only"}
                        onChange={() => setDedupeCompareStatuses("open_only")}
                        disabled={isImporting || !dedupeEnabled}
                      />
                      Somente abertas
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name="dedupe-status"
                        checked={dedupeCompareStatuses === "open_and_closed"}
                        onChange={() =>
                          setDedupeCompareStatuses("open_and_closed")
                        }
                        disabled={isImporting || !dedupeEnabled}
                      />
                      Abertas e fechadas
                    </label>
                  </div>
                  <div className="text-sm text-slate-700 md:col-span-2">
                    <p className="mb-1">Ação em duplicado</p>
                    <label className="mr-4 inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name="dedupe-mode"
                        checked={dedupeMode === "skip"}
                        onChange={() => setDedupeMode("skip")}
                        disabled={isImporting || !dedupeEnabled}
                      />
                      Ignorar linha
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name="dedupe-mode"
                        checked={dedupeMode === "upsert"}
                        onChange={() => setDedupeMode("upsert")}
                        disabled={isImporting || !dedupeEnabled}
                      />
                      Atualizar oportunidade existente (merge)
                    </label>
                  </div>
                </div>
              </div>

              {detectedHeaders.length ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-slate-800">
                      Mapeamento de colunas
                    </p>
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
                        <label
                          className="block text-sm font-medium text-slate-700"
                          htmlFor={`map-${field.key}`}
                        >
                          {field.label} {field.required ? "*" : "(opcional)"}
                        </label>
                        <select
                          id={`map-${field.key}`}
                          className="w-full rounded-lg border border-slate-300 p-2 text-slate-800"
                          value={mapping[field.key] ?? ""}
                          onChange={(event) =>
                            setMapping((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }))
                          }
                          disabled={isImporting}
                        >
                          <option value="">
                            {field.required
                              ? "— Selecione —"
                              : "— Não informar —"}
                          </option>
                          {detectedHeaders.map((header) => (
                            <option
                              key={`${field.key}-${header}`}
                              value={header}
                            >
                              {header}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="w-full overflow-x-auto rounded-xl border border-slate-200">
                <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm">
                    <span className="font-medium text-slate-600">Filtrar:</span>
                    <button
                      type="button"
                      onClick={() => setStatusFilter("all")}
                      className={`rounded-md px-2 py-1 ${statusFilter === "all" ? "bg-slate-700 text-white" : "bg-white text-slate-700 border border-slate-300"}`}
                    >
                      Todos
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatusFilter("valid")}
                      className={`rounded-md px-2 py-1 ${statusFilter === "valid" ? "bg-emerald-700 text-white" : "bg-white text-slate-700 border border-slate-300"}`}
                    >
                      Válidos
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatusFilter("error")}
                      className={`rounded-md px-2 py-1 ${statusFilter === "error" ? "bg-rose-700 text-white" : "bg-white text-slate-700 border border-slate-300"}`}
                    >
                      Erro
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatusFilter("duplicate")}
                      className={`rounded-md px-2 py-1 ${statusFilter === "duplicate" ? "bg-amber-700 text-white" : "bg-white text-slate-700 border border-slate-300"}`}
                    >
                      Duplicados
                    </button>
                  </div>
                  <p className="text-xs text-slate-500">
                    {filteredRows.length} linha(s)
                  </p>
                </div>
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
                      <th className="px-3 py-2">Detalhes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedRows.length ? (
                      paginatedRows.map((row) => (
                        <Fragment key={row.line}>
                          <tr
                            className={`border-t border-slate-200 ${
                              row.status === "error"
                                ? "bg-rose-50"
                                : row.status === "ignored" ||
                                    row.status === "update"
                                  ? "bg-amber-50"
                                  : "bg-emerald-50"
                            }`}
                          >
                            <td className="px-3 py-2">{row.line}</td>
                            <td
                              className={`px-3 py-2 ${row.invalidFields?.includes("title") ? "bg-rose-100" : ""}`}
                            >
                              {row.title || "—"}
                            </td>
                            <td
                              className={`px-3 py-2 ${row.invalidFields?.includes("clientNameOrId") ? "bg-rose-100" : ""}`}
                            >
                              <div className="flex flex-col gap-1">
                                <span>{row.clientId || "—"}</span>
                                {isAmbiguousClientError(row) ||
                                isMissingClientError(row) ? (
                                  selectingClientForLine === row.line ? (
                                    <div className="flex max-w-sm items-start gap-2">
                                      <div className="min-w-0 flex-1">
                                        <ClientSearchSelect
                                          clients={clients}
                                          value=""
                                          onChange={(clientId) => {
                                            if (clientId)
                                              handleClientSelection(
                                                row.line,
                                                clientId,
                                              );
                                          }}
                                          placeholder="Buscar cliente..."
                                          emptyLabel="Nenhum cliente encontrado."
                                          maxListHeightClassName="max-h-44"
                                          className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                                        />
                                      </div>
                                      <button
                                        type="button"
                                        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                                        onClick={() =>
                                          setSelectingClientForLine(null)
                                        }
                                      >
                                        Cancelar
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      className={`w-fit rounded border px-2 py-1 text-xs ${
                                        isAmbiguousClientError(row)
                                          ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                                          : "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
                                      }`}
                                      onClick={() =>
                                        setSelectingClientForLine(row.line)
                                      }
                                    >
                                      Selecionar cliente
                                    </button>
                                  )
                                ) : null}
                                {row.manuallyCorrected ? (
                                  <span className="w-fit rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
                                    corrigido manualmente
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td
                              className={`px-3 py-2 ${row.invalidFields?.includes("value") ? "bg-rose-100" : ""}`}
                            >
                              <input
                                type="number"
                                className="w-28 rounded border border-slate-300 bg-white px-2 py-1"
                                value={row.value ?? ""}
                                onChange={(event) =>
                                  handleEditableFieldChange(
                                    row.line,
                                    "value",
                                    event.target.value,
                                  )
                                }
                              />
                            </td>
                            <td
                              className={`px-3 py-2 ${row.invalidFields?.includes("stage") ? "bg-rose-100" : ""}`}
                            >
                              <select
                                className="rounded border border-slate-300 bg-white px-2 py-1"
                                value={row.stage || ""}
                                onChange={(event) =>
                                  handleEditableFieldChange(
                                    row.line,
                                    "stage",
                                    event.target.value,
                                  )
                                }
                              >
                                <option value="">Selecione</option>
                                {Array.from(VALID_STAGES).map((stageOption) => (
                                  <option key={stageOption} value={stageOption}>
                                    {stageOption}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td
                              className={`px-3 py-2 ${row.invalidFields?.includes("status") ? "bg-rose-100" : ""}`}
                            >
                              <div className="flex flex-col gap-1">
                                <span>
                                  {row.status === "new"
                                    ? "NOVO"
                                    : row.status === "update"
                                      ? "ATUALIZAR"
                                      : row.status === "ignored"
                                        ? "IGNORADO"
                                        : "ERRO"}
                                </span>
                                <select
                                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                                  value={String(
                                    (row.payload as { status?: string })
                                      .status || "",
                                  )}
                                  onChange={(event) =>
                                    handleEditableFieldChange(
                                      row.line,
                                      "status",
                                      event.target.value,
                                    )
                                  }
                                >
                                  <option value="">—</option>
                                  {Array.from(VALID_STATUS).map(
                                    (statusOption) => (
                                      <option
                                        key={statusOption}
                                        value={statusOption}
                                      >
                                        {statusOption}
                                      </option>
                                    ),
                                  )}
                                </select>
                              </div>
                            </td>
                            <td className="px-3 py-2">{row.reason || "OK"}</td>
                            <td className="px-3 py-2">
                              {row.status === "error" && row.reason ? (
                                <button
                                  type="button"
                                  className="text-xs font-medium text-brand-700 hover:underline"
                                  onClick={() => toggleExpandLine(row.line)}
                                >
                                  {expandedLines.includes(row.line)
                                    ? "Ocultar"
                                    : "Expandir"}
                                </button>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                          {row.status === "error" &&
                          expandedLines.includes(row.line) ? (
                            <tr className="border-t border-slate-200 bg-slate-100">
                              <td
                                colSpan={8}
                                className="px-3 py-2 text-xs text-slate-700"
                              >
                                <span className="font-semibold">
                                  Detalhe do erro:
                                </span>{" "}
                                {row.reason}
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      ))
                    ) : (
                      <tr>
                        <td
                          colSpan={8}
                          className="px-3 py-6 text-center text-slate-500"
                        >
                          Envie um arquivo para visualizar o preview.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {filteredRows.length > 0 ? (
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      setCurrentPage((prev) => Math.max(1, prev - 1))
                    }
                    disabled={page === 1}
                    className="rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Anterior
                  </button>
                  <span className="text-xs text-slate-600">
                    Página {page} de {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setCurrentPage((prev) => Math.min(totalPages, prev + 1))
                    }
                    disabled={page === totalPages}
                    className="rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Próxima
                  </button>
                </div>
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
                disabled={
                  isImporting ||
                  counters.totalRead === 0 ||
                  counters.importable === 0
                }
              >
                {isImporting
                  ? isDryRun
                    ? "Simulando..."
                    : "Importando..."
                  : isDryRun
                    ? "Simular"
                    : "Importar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {importResult ? (
        <OpportunityImportResultModal
          result={importResult}
          onExportCsv={handleExportImportResultCsv}
          onClose={() => setImportResult(null)}
        />
      ) : null}
    </>
  );
}
