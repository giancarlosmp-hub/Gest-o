import { Settings2, Target, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import CrudSimplePage from "./CrudSimplePage";

export default function SettingsPage() {
  const { user, loading } = useAuth();

  // Mantém compatibilidade com as duas abordagens:
  // - ?section=users (rota/redirect que já usamos)
  // - ?secao=usuarios#usuarios (tentativa anterior do main)
  const [searchParams] = useSearchParams();
  const location = useLocation();

  const usersSectionRef = useRef<HTMLDivElement | null>(null);
  const [showUsersSection, setShowUsersSection] = useState(false);

  const section = (searchParams.get("section") || "").toLowerCase();
  const secao = (searchParams.get("secao") || "").toLowerCase();
  const shouldOpenUsersSection =
    location.hash === "#usuarios" ||
    section === "users" ||
    section === "usuarios" ||
    secao === "usuarios";

  useEffect(() => {
    if (!shouldOpenUsersSection) return;
    setShowUsersSection(true);
  }, [shouldOpenUsersSection]);

  useEffect(() => {
    if (!showUsersSection || !usersSectionRef.current) return;
    usersSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [showUsersSection]);

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

      <div className="grid gap-4 md:grid-cols-2">
        <Link
          to="/configurações?section=users#usuarios"
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

        {/* Card “Usuários” embutido na página (sem depender de componente externo) */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-brand-50 p-2 text-brand-700">
              <Users size={20} />
            </div>
            <h3 className="text-lg font-semibold text-slate-900">Usuários</h3>
          </div>
          <p className="mt-3 text-sm text-slate-600">
            Cadastre, edite e organize os acessos dos usuários que atuam na operação comercial.
          </p>
          <button
            type="button"
            onClick={() => setShowUsersSection(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-800"
          >
            <Settings2 size={16} />
            Gerenciar usuários
          </button>
        </div>
      </div>

      {showUsersSection ? (
        <div ref={usersSectionRef} id="usuarios" className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
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
      ) : null}
    </section>
  );
}
