import { Navigate } from "react-router-dom";
import CrudSimplePage from "./CrudSimplePage";
import { useAuth } from "../context/AuthContext";

const fields = [
  { key: "month", label: "Mês YYYY-MM" },
  { key: "targetValue", label: "Objetivo", type: "number" },
  { key: "sellerId", label: "ID vendedor" },
];

export default function ObjectivesPage() {
  const { user, loading } = useAuth();

  if (loading) return <div className="p-8">Carregando...</div>;
  if (!user) return <Navigate to="/login" replace />;

  const canAccess = user.role === "diretor" || user.role === "gerente";
  if (!canAccess) return <Navigate to="/dashboard" replace />;

  return <CrudSimplePage endpoint="/goals" title="Objetivos" fields={fields} />;
}
