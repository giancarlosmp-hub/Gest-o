import { Navigate, Route, Routes } from "react-router-dom";
import OpportunityDetailsPage from "./pages/OpportunityDetailsPage";
import ClientDetailsPage from "./pages/ClientDetailsPage";
import LoginPage from "./pages/LoginPage";
import AppLayout from "./layouts/AppLayout";
import ProtectedRoute from "./components/ProtectedRoute";
import DashboardPage from "./pages/DashboardPage";
import CrudSimplePage from "./pages/CrudSimplePage";
import OpportunitiesPage from "./pages/OpportunitiesPage";
import ReportsPage from "./pages/ReportsPage";
import ObjectivesPage from "./pages/ObjectivesPage";
import RoleRoute from "./components/RoleRoute";
import { useAuth } from "./context/AuthContext";
import { canAccessRoute } from "./lib/authorization";
import TeamPage from "./pages/TeamPage";

const Placeholder = ({ title }: { title: string }) => <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="text-2xl font-bold text-slate-900">{title}</h2><p className="text-slate-500">Em breve.</p></div>;

export default function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route index element={<DashboardPage />} />
        <Route path="dashboard" element={<Navigate to="/" replace />} />
        <Route path="equipe" element={<RoleRoute route="equipe"><TeamPage /></RoleRoute>} />
        <Route path="objetivos" element={<RoleRoute route="objetivos"><ObjectivesPage /></RoleRoute>} />
        <Route path="metas" element={<Navigate to="/objetivos" replace />} />
        <Route path="clientes" element={<CrudSimplePage endpoint="/clients" title="Clientes" detailsPath="/clientes" fields={[{ key: "name", label: "Nome" }, { key: "city", label: "Cidade" }, { key: "state", label: "UF" }, { key: "region", label: "Região" }, { key: "potentialHa", label: "Potencial (ha)", type: "number" }, { key: "farmSizeHa", label: "Área total (ha)", type: "number" }, { key: "ownerSellerId", label: "ID vendedor" }]} />} />
        <Route path="contatos" element={<CrudSimplePage endpoint="/contacts" title="Contatos" fields={[{ key: "name", label: "Nome" }, { key: "phone", label: "Telefone" }, { key: "email", label: "Email" }, { key: "companyId", label: "ID empresa" }, { key: "ownerSellerId", label: "ID vendedor" }]} />} />
        <Route path="empresas" element={<CrudSimplePage endpoint="/companies" title="Empresas" fields={[{ key: "name", label: "Nome" }, { key: "cnpj", label: "CNPJ" }, { key: "segment", label: "Segmento" }, { key: "ownerSellerId", label: "ID vendedor" }]} />} />
        <Route path="oportunidades" element={<OpportunitiesPage />} />
        <Route path="oportunidades/:id" element={<OpportunityDetailsPage />} />
        <Route path="clientes/:id" element={<ClientDetailsPage />} />
        <Route path="atividades" element={<CrudSimplePage endpoint="/activities" title="Atividades" fields={[{ key: "type", label: "Tipo" }, { key: "notes", label: "Notas" }, { key: "dueDate", label: "Vencimento (ISO)" }, { key: "opportunityId", label: "ID oportunidade" }, { key: "ownerSellerId", label: "ID vendedor" }]} />} />
        <Route path="relatórios" element={<ReportsPage />} />
        <Route path="relatorios" element={<ReportsPage />} />
        <Route path="usuários" element={canAccessRoute("usuarios", user?.role) ? <CrudSimplePage endpoint="/users" title="Usuários" fields={[{ key: "name", label: "Nome" }, { key: "email", label: "Email" }, { key: "role", label: "Papel" }, { key: "region", label: "Região" }, { key: "password", label: "Senha" }]} readOnly={user?.role !== "diretor"} /> : <Navigate to="/" replace />} />
        <Route path="configurações" element={canAccessRoute("configuracoes", user?.role) ? <Placeholder title="Configurações" /> : <Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
