import { Settings2, Target, Users } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import UsersAdminPanel from "../components/settings/UsersAdminPanel";
import { useAuth } from "../context/AuthContext";

export default function SettingsPage() {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();

  if (loading) return <div className="p-8">Carregando...</div>;
  if (!user) return <Navigate to="/login" replace />;

  const canAccess = user.role === "diretor" || user.role === "gerente";
  if (!canAccess) return <Navigate to="/dashboard" replace />;

  const section = (searchParams.get("section") || "").toLowerCase();
  const isUsersSection = section === "users" || section === "usuarios";

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Configurações</h2>
        <p className="text-sm text-slate-500">Gerencie parâmetros estratégicos e regras da operação comercial.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Link
          to="/configurações?section=users"
          className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-brand-50 p-2 text-brand-700">
              <Users size={20} />
            </div>
            <h3 className="text-lg font-semibold text-slate-900">Usuários</h3>
          </div>
          <p className="mt-3 text-sm text-slate-600">Gerencie cadastro, permissões e manutenção de contas da operação comercial.</p>
          <div className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-brand-700">
            <Settings2 size={16} />
            Gerenciar usuários
          </div>
        </Link>

        <Link
          to="/configurações/kpis-atividades"
          className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-brand-50 p-2 text-brand-700">
              <Target size={20} />
            </div>
            <h3 className="text-lg font-semibold text-slate-900">KPIs de Atividades</h3>
          </div>
          <p className="mt-3 text-sm text-slate-600">
            Defina metas mensais por vendedor para ligações, WhatsApp, reuniões, envio de proposta, visita técnica e cliente novo (prospecção).
          </p>
          <div className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-brand-700">
            <Settings2 size={16} />
            Configurar KPIs
          </div>
        </Link>
      </div>

      {isUsersSection ? (
        <div id="usuarios" className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          <UsersAdminPanel />
        </div>
      ) : null}
    </section>
  );
}
