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
import SettingsPage from "./pages/SettingsPage";
import ActivityKpisPage from "./pages/ActivityKpisPage";
import ActivitiesPage from "./pages/ActivitiesPage";


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
        <Route path="clientes" element={<CrudSimplePage endpoint="/clients" title="Clientes (Cliente 360)" detailsPath="/clientes" createInModal createButtonLabel="Adicionar cliente" createModalTitle="Novo cliente" fields={[{ key: "name", label: "Nome" }, { key: "city", label: "Cidade" }, { key: "state", label: "UF" }, { key: "region", label: "Região" }, { key: "potentialHa", label: "Potencial (ha)", type: "number" }, { key: "farmSizeHa", label: "Área total (ha)", type: "number" }, { key: "clientType", label: "Tipo (PJ/PF)" }, { key: "cnpj", label: "CNPJ/CPF" }, { key: "segment", label: "Segmento" }, { key: "ownerSellerId", label: "Vendedor responsável" }]} />} />
        <Route path="contatos" element={<Navigate to="/clientes?tab=contatos" replace />} />
        <Route path="empresas" element={<Navigate to="/clientes?tab=empresas" replace />} />
        <Route path="oportunidades" element={<OpportunitiesPage />} />
        <Route path="oportunidades/:id" element={<OpportunityDetailsPage />} />
        <Route path="clientes/:id" element={<ClientDetailsPage />} />
        <Route path="atividades" element={<ActivitiesPage />} />
        <Route path="relatórios" element={<ReportsPage />} />
        <Route path="relatorios" element={<ReportsPage />} />
        <Route
          path="usuários"
          element={canAccessRoute("usuarios", user?.role) ? <Navigate to="/configurações?secao=usuarios#usuarios" replace /> : <Navigate to="/" replace />}
        />
        <Route
          path="usuarios"
          element={canAccessRoute("usuarios", user?.role) ? <Navigate to="/configurações?secao=usuarios#usuarios" replace /> : <Navigate to="/" replace />}
        />
        <Route path="configurações" element={canAccessRoute("configuracoes", user?.role) ? <SettingsPage /> : <Navigate to="/" replace />} />
        <Route path="configuracoes" element={<Navigate to="/configurações" replace />} />
        <Route path="configurações/kpis-atividades" element={<RoleRoute route="configuracoes"><ActivityKpisPage /></RoleRoute>} />
      </Route>
    </Routes>
  );
}
