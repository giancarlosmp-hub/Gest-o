import { Settings2, Target, Users } from "lucide-react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import CrudSimplePage from "./CrudSimplePage";
import ActivityKpisPage from "./ActivityKpisPage";

type SettingsSection = "kpis" | "users";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string; description: string; icon: typeof Target }> = [
  {
    id: "kpis",
    label: "KPIs de Atividades",
    description: "Defina metas mensais por vendedor para acompanhar produtividade e execução comercial.",
    icon: Target
  },
  {
    id: "users",
    label: "Usuários",
    description: "Gerencie cadastro, permissões e manutenção de contas da operação comercial.",
    icon: Users
  }
];

function getSectionFromUrl(sectionParam: string | null, hash: string): SettingsSection {
  const normalizedSection = (sectionParam || "").toLowerCase();
  const normalizedHash = hash.toLowerCase();

  if (normalizedSection === "users" || normalizedSection === "usuarios") return "users";
  if (normalizedSection === "kpis" || normalizedSection === "kpis-atividades") return "kpis";

  if (normalizedHash === "#usuarios" || normalizedHash === "#users") return "users";
  if (normalizedHash === "#kpis" || normalizedHash === "#kpis-atividades") return "kpis";

  return "kpis";
}

export default function SettingsPage() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeSection = useMemo(
    () => getSectionFromUrl(searchParams.get("section"), location.hash),
    [location.hash, searchParams]
  );

  const setSection = (section: SettingsSection) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("section", section);
      return next;
    });
  };

  if (loading) return <div className="p-8">Carregando...</div>;
  if (!user) return <Navigate to="/login" replace />;

  const canAccess = user.role === "diretor" || user.role === "gerente";
  if (!canAccess) return <Navigate to="/dashboard" replace />;

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Configurações</h2>
        <p className="text-sm text-slate-500">Gerencie parâmetros estratégicos e regras da operação comercial.</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <nav className="grid gap-2 md:grid-cols-2" aria-label="Seções de configurações">
          {SETTINGS_SECTIONS.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;

            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setSection(section.id)}
                className={`rounded-lg border p-4 text-left transition ${
                  isActive
                    ? "border-brand-300 bg-brand-50/70 shadow-sm"
                    : "border-transparent hover:border-slate-200 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon size={18} className={isActive ? "text-brand-700" : "text-slate-500"} />
                  <h3 className="text-sm font-semibold text-slate-900">{section.label}</h3>
                </div>
                <p className="mt-2 text-xs text-slate-600">{section.description}</p>
                {isActive && (
                  <span className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-brand-700">
                    <Settings2 size={14} />
                    Seção ativa
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {activeSection === "kpis" ? (
        <ActivityKpisPage embedded />
      ) : (
        <div id="usuarios" className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          <CrudSimplePage
            endpoint="/users"
            title="Usuários"
            fields={[
              { key: "name", label: "Nome completo", placeholder: "Informe o nome completo" },
              { key: "email", label: "E-mail corporativo", placeholder: "Informe o e-mail corporativo" },
              {
                key: "role",
                label: "Perfil de acesso",
                type: "select",
                options: [
                  { value: "diretor", label: "Diretor" },
                  { value: "gerente", label: "Gerente" },
                  { value: "vendedor", label: "Vendedor" }
                ]
              },
              { key: "region", label: "Região de atuação", placeholder: "Informe a região de atuação" },
              { key: "password", label: "Senha de acesso", placeholder: "Defina uma senha de acesso" }
            ]}
            readOnly={user.role !== "diretor"}
          />
        </div>
      )}
    </section>
  );
}
