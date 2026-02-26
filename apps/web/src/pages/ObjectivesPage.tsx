import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function ObjectivesPage() {
  const { user, loading } = useAuth();

  if (loading) return <div className="p-8">Carregando...</div>;
  if (!user) return <Navigate to="/login" replace />;

  const canAccess = user.role === "diretor" || user.role === "gerente";
  if (!canAccess) return <Navigate to="/dashboard" replace />;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-2xl font-bold text-slate-900">Objetivos foram movidos para Equipe</h2>
      <p className="mt-2 text-slate-600">A partir de agora, o gerenciamento de objetivos por vendedor será feito na tela Equipe.</p>
      <Link
        to="/equipe"
        className="mt-4 inline-flex items-center rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-800"
      >
        Ir para Equipe
      </Link>
    </div>
  );
}
