import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { toast } from "sonner";

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("diretor@empresa.com");
  const [password, setPassword] = useState("123456");

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
      nav("/");
    } catch {
      toast.error("Login inválido");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-700 p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-lg">
        <img src="/brand/demetra-logo-dark.svg" alt="Logo Demetra Agro" className="h-12 w-auto" />
        <p className="text-sm text-slate-600">Acesse o painel comercial.</p>
        <input className="w-full rounded-lg border p-2" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="w-full rounded-lg border p-2" type="password" placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="w-full rounded-lg bg-brand-700 py-2 font-medium text-white hover:bg-brand-800">Entrar</button>
      </form>
    </div>
  );
}
