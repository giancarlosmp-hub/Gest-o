import { CalendarPlus, ClipboardCheck, MessageCircle } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

const actionButtonBaseClass =
  "flex min-w-0 min-h-16 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1.5 py-2 text-[11px] font-semibold leading-tight transition active:scale-[0.99]";

const primaryActions = [
  {
    id: "visita",
    label: "Visita",
    to: `/atividades?${new URLSearchParams({ open: "create", type: "visita", date: new Date().toISOString().slice(0, 10) }).toString()}`,
    icon: CalendarPlus
  },
  {
    id: "followup",
    label: "Follow-up",
    to: `/atividades?${new URLSearchParams({ open: "create", type: "followup", date: new Date().toISOString().slice(0, 10) }).toString()}`,
    icon: ClipboardCheck
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    to: "/whatsapp",
    icon: MessageCircle
  }
] as const;

export default function MobileActionBar() {
  const location = useLocation();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-3 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-2 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur md:hidden">
      <div className="mx-auto flex w-full max-w-3xl items-stretch gap-2">
        {primaryActions.map((action) => {
          const Icon = action.icon;
          const isActive = location.pathname.startsWith(action.to.split("?")[0]);

          return (
            <Link
              key={action.id}
              to={action.to}
              className={`${actionButtonBaseClass} ${isActive ? "bg-brand-700 text-white" : "bg-slate-100 text-slate-700"}`}
            >
              <Icon size={18} />
              <span className="truncate">{action.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
