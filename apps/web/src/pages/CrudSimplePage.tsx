import { ChangeEvent, FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useNavigate } from "react-router-dom";
import api from "../lib/apiClient";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";

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

type SheetJsLibrary = {
  read: (data: ArrayBuffer, options: { type: string }) => any;
  writeFile: (workbook: any, fileName: string) => void;
  utils: {
    book_new: () => any;
    aoa_to_sheet: (data: Array<Array<string | number>>) => any;
    book_append_sheet: (workbook: any, worksheet: any, title: string) => void;
    sheet_to_json: <T>(sheet: any, options: { header: number; blankrows: boolean }) => T[];
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
  const [isImporting, setIsImporting] = useState(false);
  const [isImportReady, setIsImportReady] = useState(false);

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

  const validateForm = () => {
    if (endpoint !== "/clients") return null;

    const name = String(form.name ?? "").trim();
    const state = String(form.state ?? "").trim();
    const clientType = String(form.clientType ?? "").trim().toUpperCase();
    const cnpjOrCpfDigits = String(form.cnpj ?? "").replace(/\D/g, "");

    if (!name) return "Nome é obrigatório.";
    if (state && !/^[A-Za-z]{2}$/.test(state)) return "UF deve conter exatamente 2 letras.";

    if (cnpjOrCpfDigits) {
      if (clientType === "PF" && cnpjOrCpfDigits.length !== 11) {
        return "Para cliente PF, informe um CPF com 11 dígitos.";
      }

      if (clientType === "PJ" && cnpjOrCpfDigits.length !== 14) {
        return "Para cliente PJ, informe um CNPJ com 14 dígitos.";
      }

      if (clientType !== "PF" && clientType !== "PJ" && ![11, 14].includes(cnpjOrCpfDigits.length)) {
        return "CNPJ/CPF deve conter 11 (CPF) ou 14 (CNPJ) dígitos.";
      }
    }

    return null;
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

  const parseImportFile = async (file: File) => {
    const data = await file.arrayBuffer();
    const xlsx = await loadXlsxLibrary();
    const workbook = xlsx.read(data, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      throw new Error("A planilha não possui abas válidas.");
    }

    const sheet = workbook.Sheets[firstSheetName];
    const sheetRows = xlsx.utils.sheet_to_json<Array<string | number | null>>(sheet, { header: 1, blankrows: false });

    if (sheetRows.length < 2) {
      throw new Error("A planilha precisa conter cabeçalho e pelo menos uma linha de dados.");
    }

    const headers = sheetRows[0].map(normalizeHeader);
    const rows = sheetRows.slice(1);

    const headerIndexes = clientImportColumns.reduce<Record<string, number>>((acc, columnName) => {
      acc[columnName] = headers.indexOf(columnName);
      return acc;
    }, {});

    const missingColumns = clientImportColumns.filter((columnName) => headerIndexes[columnName] < 0);
    if (missingColumns.length > 0) {
      throw new Error(`Colunas ausentes: ${missingColumns.join(", ")}.`);
    }

    const parsedRows: ClientImportRow[] = rows
      .map((row) => ({
        name: String(row[headerIndexes.name] ?? "").trim(),
        city: String(row[headerIndexes.city] ?? "").trim(),
        state: String(row[headerIndexes.state] ?? "").trim().toUpperCase(),
        region: String(row[headerIndexes.region] ?? "").trim(),
        potentialHa: row[headerIndexes.potentialHa] === "" || row[headerIndexes.potentialHa] === null
          ? undefined
          : Number(row[headerIndexes.potentialHa]),
        farmSizeHa: row[headerIndexes.farmSizeHa] === "" || row[headerIndexes.farmSizeHa] === null
          ? undefined
          : Number(row[headerIndexes.farmSizeHa]),
        clientType: String(row[headerIndexes.clientType] ?? "").trim().toUpperCase(),
        cnpj: String(row[headerIndexes.cnpj] ?? "").trim(),
        segment: String(row[headerIndexes.segment] ?? "").trim(),
        ownerSellerId: String(row[headerIndexes.ownerSellerId] ?? "").trim()
      }))
      .filter((row) => Object.values(row).some((value) => value !== "" && value !== undefined));

    return parsedRows;
  };

  const validateImportRows = (rows: ClientImportRow[]) => {
    const errors: string[] = [];

    if (rows.length === 0) {
      errors.push("Nenhuma linha de dados válida foi encontrada.");
      return errors;
    }

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      if (!row.name) {
        errors.push(`Linha ${rowNumber}: o campo name é obrigatório.`);
      }

      if (row.state && !/^[A-Z]{2}$/.test(row.state)) {
        errors.push(`Linha ${rowNumber}: state deve conter 2 letras.`);
      }

      if (row.clientType && !["PF", "PJ"].includes(row.clientType)) {
        errors.push(`Linha ${rowNumber}: clientType deve ser PF ou PJ.`);
      }

      if (row.potentialHa !== undefined && Number.isNaN(row.potentialHa)) {
        errors.push(`Linha ${rowNumber}: potentialHa deve ser numérico.`);
      }

      if (row.farmSizeHa !== undefined && Number.isNaN(row.farmSizeHa)) {
        errors.push(`Linha ${rowNumber}: farmSizeHa deve ser numérico.`);
      }
    });

    return errors;
  };

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    setImportRows([]);
    setImportPreviewRows([]);
    setImportValidationErrors([]);
    setIsImportReady(false);

    if (!selectedFile) return;

    if (!selectedFile.name.toLowerCase().endsWith(".xlsx")) {
      toast.error("Selecione um arquivo no formato .xlsx.");
      return;
    }

    try {
      const rows = await parseImportFile(selectedFile);
      const errors = validateImportRows(rows);

      setImportRows(rows);
      setImportPreviewRows(rows.slice(0, 20));
      setImportValidationErrors(errors);
      setIsImportReady(errors.length === 0);

      if (errors.length > 0) {
        toast.error("Foram encontrados erros de validação na planilha.");
      } else {
        toast.success(`${rows.length} linha(s) carregada(s) com sucesso.`);
      }
    } catch (err: any) {
      setImportRows([]);
      setImportPreviewRows([]);
      setImportValidationErrors([err.message || "Erro ao ler arquivo."]);
      setIsImportReady(false);
      toast.error(err.message || "Não foi possível processar o arquivo.");
    }
  };

  const handleImportClients = async () => {
    if (!isImportReady || importRows.length === 0) return;

    setIsImporting(true);
    try {
      for (const row of importRows) {
        const payload: Record<string, unknown> = {
          ...row,
          potentialHa: row.potentialHa ?? undefined,
          farmSizeHa: row.farmSizeHa ?? undefined,
          ownerSellerId: row.ownerSellerId || undefined
        };

        if (isSeller && user?.id) {
          payload.ownerSellerId = row.ownerSellerId || user.id;
        }

        await api.post("/clients", payload);
      }

      toast.success(`Importação concluída: ${importRows.length} cliente(s) importado(s).`);
      setIsImportModalOpen(false);
      setImportRows([]);
      setImportPreviewRows([]);
      setImportValidationErrors([]);
      setIsImportReady(false);
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
  };

  const openCreateModal = () => {
    setEditing(null);
    if (isClientsPage && isSeller && user?.id) {
      setForm({ ownerSellerId: user.id });
    } else {
      setForm({});
    }
    setFormError(null);
    setIsCreateModalOpen(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      toast.error(validationError);
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
                <p className="font-medium text-slate-900">Colunas esperadas no arquivo:</p>
                <p>name, city, state, region, potentialHa, farmSizeHa, clientType, cnpj, segment, ownerSellerId.</p>
                <p className="mt-1 text-xs text-slate-600">clientType aceita apenas PJ ou PF (sem diferenciar maiúsculas/minúsculas). ownerSellerId é opcional.</p>
              </div>

              {importValidationErrors.length > 0 ? (
                <div className="max-h-32 overflow-y-auto rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                  {importValidationErrors.map((validationError) => (
                    <p key={validationError}>• {validationError}</p>
                  ))}
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="bg-slate-100 text-left text-slate-700">
                    <tr>
                      {clientImportColumns.map((column) => (
                        <th key={column} className="px-3 py-2 font-medium">{column}</th>
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
                  setIsImportModalOpen(false);
                  setImportRows([]);
                  setImportPreviewRows([]);
                  setImportValidationErrors([]);
                  setIsImportReady(false);
                }}
                className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100"
                disabled={isImporting}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleImportClients}
                className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
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
                  const isRequired = endpoint === "/clients" ? f.key === "name" : true;
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
                            setForm({ ...form, [f.key]: parseFormValue(f.key, f.type, e.target.value) });
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {formError ? <p className="text-sm text-rose-600">{formError}</p> : null}

              <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
                <button type="button" onClick={closeCreateModal} className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-100" disabled={saving}>
                  Cancelar
                </button>
                <button type="submit" className="rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60" disabled={saving}>
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
