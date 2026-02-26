import { useEffect, useMemo, useState } from "react";
import { Search, SlidersHorizontal, UserRound } from "lucide-react";
import api from "../lib/apiClient";

type TeamUser = {
  id: string;
  name: string;
  role?: string;
  status?: string | null;
};

const roleLabel: Record<string, string> = {
  diretor: "Diretor",
  gerente: "Gerente",
  vendedor: "Vendedor"
};

const statusLabel: Record<string, string> = {
  ativo: "Ativo",
  inativo: "Inativo"
};

function formatRole(role?: string) {
  if (!role) return "Não informado";
  return roleLabel[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

function formatStatus(status?: string | null) {
  if (!status) return "Ativo";
  return statusLabel[status.toLowerCase()] ?? status;
}

export default function TeamPage() {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"todos" | "vendedores">("todos");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TeamUser | null>(null);

  useEffect(() => {
    const loadUsers = async () => {
      try {
        const { data } = await api.get("/users");
        setUsers(Array.isArray(data) ? data : []);
      } catch {
        setUsers([
          { id: "seed-1", name: "Vendedor 1", role: "vendedor", status: "ativo" },
          { id: "seed-2", name: "Vendedora 2", role: "vendedor", status: "ativo" },
          { id: "seed-3", name: "Vendedor 3", role: "vendedor", status: "inativo" }
        ]);
      } finally {
        setLoading(false);
      }
    };

    loadUsers();
  }, []);

  const filteredUsers = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return users
      .filter((user) => (filter === "vendedores" ? user.role === "vendedor" : true))
      .filter((user) => user.name.toLowerCase().includes(normalizedSearch));
  }, [users, search, filter]);

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Equipe</h2>
        <p className="text-sm text-slate-500">Acompanhe e navegue pela sua equipe comercial.</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
            <Search size={16} className="text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-full bg-transparent text-sm text-slate-700 outline-none"
              placeholder="Buscar por nome"
            />
          </label>

          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
            <SlidersHorizontal size={16} className="text-slate-400" />
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as "todos" | "vendedores")}
              className="w-full bg-transparent text-sm text-slate-700 outline-none"
            >
              <option value="todos">Todos</option>
              <option value="vendedores">Somente vendedores</option>
            </select>
          </label>
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          Carregando equipe...
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredUsers.map((user) => (
            <article key={user.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold text-slate-900">{user.name}</h3>
                  <p className="text-sm text-slate-500">{formatRole(user.role)}</p>
                </div>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                  {formatStatus(user.status)}
                </span>
              </div>

              <button
                onClick={() => setSelected(user)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <UserRound size={16} />
                Ver detalhes
              </button>
            </article>
          ))}

          {!filteredUsers.length && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 md:col-span-2 xl:col-span-3">
              Nenhum vendedor encontrado para os filtros selecionados.
            </div>
          )}
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-900">Detalhes do vendedor</h3>
            <p className="mt-1 text-sm text-slate-500">
              Placeholder para próximos PRs com dados de performance e carteira.
            </p>

            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <p><strong>Nome:</strong> {selected.name}</p>
              <p><strong>Role:</strong> {formatRole(selected.role)}</p>
              <p><strong>Status:</strong> {formatStatus(selected.status)}</p>
            </div>

            <button
              onClick={() => setSelected(null)}
              className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800"
            >
              Fechar
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
