import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import OpportunityDetailsPage from "./pages/OpportunityDetailsPage";
import ClientDetailsPage from "./pages/ClientDetailsPage";
import LoginPage from "./pages/LoginPage";
import AppLayout from "./layouts/AppLayout";
import ProtectedRoute from "./components/ProtectedRoute";
import DashboardPage from "./pages/DashboardPage";
import HomePage from "./pages/HomePage";
import CrudSimplePage from "./pages/CrudSimplePage";
import OpportunitiesPage from "./pages/OpportunitiesPage";
import ReportsPage from "./pages/ReportsPage";
import ObjectivesPage from "./pages/ObjectivesPage";
import RoleRoute from "./components/RoleRoute";
import { useAuth } from "./context/AuthContext";
import { canAccessRoute } from "./lib/authorization";
import TeamPage from "./pages/TeamPage";
import SettingsPage from "./pages/SettingsPage";
import ActivitiesPage from "./pages/ActivitiesPage";
import AgendaPage from "./pages/AgendaPage";
import CommercialExecutionReportPage from "./pages/CommercialExecutionReportPage";
import CommercialScorePage from "./pages/CommercialScorePage";
import RouteErrorBoundary from "./components/RouteErrorBoundary";

const AssistenteTecnicoPage = lazy(() => import("./pages/AssistenteTecnico"));

function AssistenteTecnicoRoute() {
  return (
    <RouteErrorBoundary
      fallbackTitle="Ops! Não foi possível abrir o Assistente Técnico."
      fallbackMessage="Tente recarregar a página."
    >
      <Suspense fallback={<div className="p-6 text-sm text-slate-600">Carregando Assistente Técnico...</div>}>
        <RoleRoute route="assistenteTecnico">
          <AssistenteTecnicoPage />
        </RoleRoute>
      </Suspense>
    </RouteErrorBoundary>
  );
}

export default function App() {
  const { user } = useAuth();
  const location = useLocation();

  // Mantém compatibilidade: /usuarios e /usuários redirecionam para Configurações (seção Usuários)
  const usersRedirectPath = "/configurações?section=users";

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="dashboard/score-comercial" element={<CommercialScorePage />} />

        <Route path="equipe" element={<RoleRoute route="equipe"><TeamPage /></RoleRoute>} />
        <Route path="objetivos" element={<RoleRoute route="objetivos"><ObjectivesPage /></RoleRoute>} />
        <Route path="metas" element={<Navigate to="/objetivos" replace />} />

        <Route
          path="clientes"
          element={
            <CrudSimplePage
              endpoint="/clients"
              title="Clientes (Cliente 360)"
              detailsPath="/clientes"
              createInModal
              createButtonLabel="Adicionar cliente"
              createModalTitle="Novo cliente"
              fields={[
                { key: "name", label: "Nome" },
                { key: "fantasyName", label: "Nome fantasia", placeholder: "Ex: Agro Rural" },
                { key: "code", label: "Código", placeholder: "Ex: 12345 (ERP)" },
                { key: "city", label: "Cidade" },
                { key: "state", label: "UF" },
                { key: "region", label: "Região" },
                { key: "potentialHa", label: "Potencial (ha)", type: "number" },
                { key: "farmSizeHa", label: "Área total (ha)", type: "number" },
                { key: "clientType", label: "Tipo (PJ/PF)" },
                { key: "cnpj", label: "CNPJ/CPF" },
                { key: "segment", label: "Segmento" },
                { key: "ownerSellerId", label: "Vendedor responsável" }
              ]}
            />
          }
        />

        <Route path="contatos" element={<Navigate to="/clientes?tab=contatos" replace />} />
        <Route path="empresas" element={<Navigate to="/clientes?tab=empresas" replace />} />

        <Route path="oportunidades" element={<OpportunitiesPage />} />
        <Route path="oportunidades/:id" element={<OpportunityDetailsPage />} />

        <Route path="clientes/:id" element={<ClientDetailsPage />} />

        <Route path="atividades" element={<ActivitiesPage />} />
        <Route path="agenda" element={<AgendaPage />} />

        <Route path="assistente-tecnico" element={<AssistenteTecnicoRoute />} />

        <Route path="relatórios" element={<ReportsPage />} />
        <Route path="relatorios" element={<ReportsPage />} />
        <Route path="relatórios/execução-comercial" element={<CommercialExecutionReportPage />} />
        <Route path="relatorios/execucao-comercial" element={<CommercialExecutionReportPage />} />

        {/* Compatibilidade: rota antiga de Usuários redireciona para Configurações */}
        <Route
          path="usuários"
          element={canAccessRoute("usuarios", user?.role) ? <Navigate to={usersRedirectPath} replace /> : <Navigate to="/" replace />}
        />
        <Route
          path="usuarios"
          element={canAccessRoute("usuarios", user?.role) ? <Navigate to={usersRedirectPath} replace /> : <Navigate to="/" replace />}
        />

        <Route path="configurações" element={canAccessRoute("configuracoes", user?.role) ? <SettingsPage /> : <Navigate to="/" replace />} />
        <Route path="configuracoes" element={<Navigate to={`/configurações${location.search}${location.hash}`} replace />} />

        <Route path="configurações/kpis-atividades" element={<Navigate to="/configurações?section=kpis" replace />} />
      </Route>
    </Routes>
  );
}
