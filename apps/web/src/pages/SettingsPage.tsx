import { Database, Leaf, MapPinned, Settings2, Target, Users } from "lucide-react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import CrudSimplePage from "./CrudSimplePage";
import ActivityKpisPage from "./ActivityKpisPage";
import WeeklyVisitMinimumPanel from "../components/settings/WeeklyVisitMinimumPanel";
import TechnicalCulturesPanel from "../components/settings/TechnicalCulturesPanel";
import ErpIntegrationPanel from "../components/settings/ErpIntegrationPanel";
import SellerTerritoriesPanel from "../components/settings/SellerTerritoriesPanel";

type SettingsSection = "kpis" | "discipline" | "users" | "technical-cultures" | "erp-integration" | "seller-territories";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string; description: string; icon: typeof Target }> = [
  {
    id: "kpis",
    label: "KPIs de Atividades",
    description: "Defina metas mensais por vendedor para acompanhar produtividade e execução comercial.",
    icon: Target
  },
  {
    id: "discipline",
    label: "Disciplina Semanal",
    description: "Configure a meta mínima de visitas por semana para monitorar a execução de campo.",
    icon: Settings2
  },
  {
    id: "technical-cultures",
    label: "Catálogo Técnico",
    description: "Edite culturas, faixas de kg/ha e padrões da calculadora do Assistente Técnico.",
    icon: Leaf
  },
  {
    id: "erp-integration",
    label: "Integração ERP",
    description: "Acompanhe conexão e execute sincronizações manuais com o UltraFV3.",
    icon: Database
  },
  {
    id: "seller-territories",
    label: "Territórios Comerciais",
    description: "Defina cidades de atuação por vendedor.",
    icon: MapPinned
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
  if (normalizedSection === "discipline" || normalizedSection === "disciplina") return "discipline";
  if (normalizedSection === "technical-cultures" || normalizedSection === "catalogo-tecnico") return "technical-cultures";
  if (normalizedSection === "erp-integration" || normalizedSection === "integracao-erp") return "erp-integration";
  if (normalizedSection === "seller-territories" || normalizedSection === "territorios-comerciais") return "seller-territories";

  if (normalizedHash === "#usuarios" || normalizedHash === "#users") return "users";
  if (normalizedHash === "#kpis" || normalizedHash === "#kpis-atividades") return "kpis";
  if (normalizedHash === "#disciplina" || normalizedHash === "#discipline") return "discipline";
  if (normalizedHash === "#catalogo-tecnico" || normalizedHash === "#technical-cultures") return "technical-cultures";
  if (normalizedHash === "#integracao-erp" || normalizedHash === "#erp-integration") return "erp-integration";
  if (normalizedHash === "#territorios-comerciais" || normalizedHash === "#seller-territories") return "seller-territories";

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

  const canAccess = user.role === "diretor" || user.role === "gerente" || user.role === "vendedor";
  if (!canAccess) return <Navigate to="/dashboard" replace />;
  if (user.role === "vendedor" && activeSection !== "seller-territories") {
    return <Navigate to="/configurações?section=seller-territories" replace />;
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Configurações</h2>
        <p className="text-sm text-slate-500">Gerencie parâmetros estratégicos e regras da operação comercial.</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <nav className="grid gap-2 md:grid-cols-2 xl:grid-cols-6" aria-label="Seções de configurações">
          {SETTINGS_SECTIONS.filter((section) => user.role !== "vendedor" || section.id === "seller-territories").map((section) => {
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
      ) : activeSection === "discipline" ? (
        <WeeklyVisitMinimumPanel canEdit={user.role === "diretor"} />
      ) : activeSection === "technical-cultures" ? (
        <TechnicalCulturesPanel />
      ) : activeSection === "erp-integration" ? (
        <ErpIntegrationPanel />
      ) : activeSection === "seller-territories" ? (
        <SellerTerritoriesPanel />
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
                  ...(user.role === "diretor" ? [{ value: "diretor", label: "Diretor" }] : []),
                  { value: "gerente", label: "Gerente" },
                  { value: "vendedor", label: "Vendedor" }
                ]
              },
              { key: "region", label: "Região de atuação", placeholder: "Informe a região de atuação" },
              {
                key: "erpCode",
                label: "Vendedor/operador ERP",
                tableLabel: "Vínculo ERP",
                type: "erpSalesman",
                placeholder: "Pesquise pelo nome ou código ERP"
              },
              {
                key: "erpLoginUsername",
                label: "Login FV3 / CPF-CNPJ",
                placeholder: "Documento ou usuário do FV3"
              },
              {
                key: "erpLoginPassword",
                label: "Senha FV3",
                type: "password",
                formOnly: true,
                placeholder: "Preencha apenas para cadastrar/alterar"
              },
              {
                key: "erpLoginConfigured",
                label: "Login FV3 configurado",
                tableOnly: true
              },
              { key: "password", label: "Senha de acesso", placeholder: "Defina uma senha de acesso" }
            ]}
            readOnly={user.role !== "diretor" && user.role !== "gerente"}
          />
        </div>
      )}
    </section>
  );
}
