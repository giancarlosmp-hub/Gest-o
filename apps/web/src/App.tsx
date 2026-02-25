import { Navigate, Route, Routes } from "react-router-dom";
import OpportunityDetailsPage from "./pages/OpportunityDetailsPage";
import LoginPage from "./pages/LoginPage";
import AppLayout from "./layouts/AppLayout";
import ProtectedRoute from "./components/ProtectedRoute";
import DashboardPage from "./pages/DashboardPage";
import CrudSimplePage from "./pages/CrudSimplePage";
import OpportunitiesPage from "./pages/OpportunitiesPage";
import ReportsPage from "./pages/ReportsPage";
import { useAuth } from "./context/AuthContext";

const Placeholder = ({ title }: { title: string }) => <div className="bg-white p-6 rounded-xl shadow"><h2 className="text-2xl font-bold">{title}</h2><p className="text-slate-500">Em breve.</p></div>;

export default function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route index element={<DashboardPage />} />
        <Route path="equipe" element={<Placeholder title="Equipe" />} />
        <Route path="metas" element={<CrudSimplePage endpoint="/goals" title="Objetivos" fields={[{ key: "month", label: "Mês YYYY-MM" }, { key: "targetValue", label: "Objetivo", type: "number" }, { key: "sellerId", label: "ID vendedor" }]} readOnly={user?.role === "vendedor"} />} />
        <Route path="clientes" element={<CrudSimplePage endpoint="/clients" title="Clientes" fields={[{ key: "name", label: "Nome" }, { key: "city", label: "Cidade" }, { key: "state", label: "UF" }, { key: "region", label: "Região" }, { key: "potentialHa", label: "Potencial (ha)", type: "number" }, { key: "farmSizeHa", label: "Área total (ha)", type: "number" }, { key: "ownerSellerId", label: "ID vendedor" }]} />} />
        <Route path="contatos" element={<CrudSimplePage endpoint="/contacts" title="Contatos" fields={[{ key: "name", label: "Nome" }, { key: "phone", label: "Telefone" }, { key: "email", label: "Email" }, { key: "companyId", label: "ID empresa" }, { key: "ownerSellerId", label: "ID vendedor" }]} />} />
        <Route path="empresas" element={<CrudSimplePage endpoint="/companies" title="Empresas" fields={[{ key: "name", label: "Nome" }, { key: "cnpj", label: "CNPJ" }, { key: "segment", label: "Segmento" }, { key: "ownerSellerId", label: "ID vendedor" }]} />} />
        <Route path="oportunidades" element={<OpportunitiesPage />} />
        <Route path="oportunidades/:id" element={<OpportunityDetailsPage />} />
        <Route path="atividades" element={<CrudSimplePage endpoint="/activities" title="Atividades" fields={[{ key: "type", label: "Tipo" }, { key: "notes", label: "Notas" }, { key: "dueDate", label: "Vencimento (ISO)" }, { key: "opportunityId", label: "ID oportunidade" }, { key: "ownerSellerId", label: "ID vendedor" }]} />} />
        <Route path="relatórios" element={<ReportsPage />} />
        <Route path="relatorios" element={<ReportsPage />} />
        <Route path="usuários" element={user?.role === "vendedor" ? <Navigate to="/"/> : <CrudSimplePage endpoint="/users" title="Usuários" fields={[{ key: "name", label: "Nome" }, { key: "email", label: "Email" }, { key: "role", label: "Papel" }, { key: "region", label: "Região" }, { key: "password", label: "Senha" }]} readOnly={user?.role !== "diretor"} />} />
        <Route path="configurações" element={user?.role === "vendedor" ? <Navigate to="/"/> : <Placeholder title="Configurações" />} />
      </Route>
    </Routes>
  );
}
