import { Menu, Trophy } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../context/AuthContext";

const items = ["Dashboard","Equipe","Objetivos","Clientes","Contatos","Empresas","Oportunidades","Atividades","Relatórios","Usuários","Configurações"];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const hidden = user?.role === "vendedor" ? ["Usuários", "Configurações"] : [];

  const sidebar = (
    <aside className="bg-blue-700 text-white w-64 min-h-screen p-4 space-y-3">
      <h1 className="font-bold text-xl mb-6 flex items-center gap-2"><Trophy size={20}/>SalesForce Pro</h1>
      {items.filter((i) => !hidden.includes(i)).map((item) => {
        const path = "/" + (item === "Dashboard" ? "" : item.toLowerCase());
        const active = location.pathname === path;
        return <Link key={item} to={path} onClick={() => setOpen(false)} className={`block px-3 py-2 rounded ${active ? "bg-white text-blue-700" : "hover:bg-blue-600"}`}>{item}</Link>;
      })}
    </aside>
  );

  return (
    <div className="flex">
      <div className="hidden md:block">{sidebar}</div>
      {open && <div className="fixed inset-0 bg-black/40 md:hidden z-40" onClick={() => setOpen(false)}><div className="w-64" onClick={(e) => e.stopPropagation()}>{sidebar}</div></div>}
      <main className="flex-1">
        <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
          <button className="md:hidden" onClick={() => setOpen(true)}><Menu/></button>
          <div className="ml-auto flex items-center gap-3">
            <div className="text-sm"><strong>{user?.name}</strong> ({user?.role})</div>
            <button className="bg-red-500 text-white px-3 py-1 rounded" onClick={logout}>Logout</button>
          </div>
        </header>
        <div className="p-4"><Outlet /></div>
      </main>
    </div>
  );
}
