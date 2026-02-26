import { LogOut, Menu } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import BrandLogo from "../components/BrandLogo";

const items = ["Dashboard", "Equipe", "Objetivos", "Clientes", "Contatos", "Empresas", "Oportunidades", "Atividades", "Relatórios", "Usuários", "Configurações"];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const hidden = user?.role === "vendedor" ? ["Objetivos", "Usuários", "Configurações"] : [];

  const sidebar = (
    <aside className="bg-brand-700 text-white w-64 min-h-screen p-4 space-y-3">
      <h1 className="mb-6">
        <BrandLogo size="sidebar" textClassName="text-white" />
      </h1>
      {items.filter((i) => !hidden.includes(i)).map((item) => {
        const path = "/" + (item === "Dashboard" ? "" : item.toLowerCase());
        const active = location.pathname === path;
        return (
          <Link
            key={item}
            to={path}
            onClick={() => setOpen(false)}
            className={`block rounded-lg px-3 py-2 text-sm font-medium transition ${active ? "bg-white text-brand-700" : "hover:bg-brand-600"}`}
          >
            {item}
          </Link>
        );
      })}
    </aside>
  );

  return (
    <div className="flex">
      <div className="hidden md:block">{sidebar}</div>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setOpen(false)}>
          <div className="w-64" onClick={(e) => e.stopPropagation()}>{sidebar}</div>
        </div>
      )}
      <main className="flex-1">
        <header className="border-b border-brand-100 bg-white px-4 py-3 flex items-center justify-between">
          <button className="rounded-md p-1 text-brand-700 md:hidden" onClick={() => setOpen(true)} aria-label="Abrir menu">
            <Menu />
          </button>
          <BrandLogo size="header" textClassName="text-brand-700" className="md:hidden" />
          <div className="ml-auto flex items-center gap-3">
            <div className="text-sm text-slate-700"><strong>{user?.name}</strong> ({user?.role})</div>
            <button className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800" onClick={logout}>
              <LogOut size={16} />
              Logout
            </button>
          </div>
        </header>
        <div className="p-4"><Outlet /></div>
      </main>
    </div>
  );
}
