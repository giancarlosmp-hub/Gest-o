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

  return <div className="min-h-screen bg-blue-700 flex items-center justify-center p-4"><form onSubmit={onSubmit} className="bg-white p-6 rounded-xl w-full max-w-sm space-y-3"><h1 className="text-2xl font-bold">Demetra Agro Performance</h1><input className="w-full border p-2 rounded" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}/><input className="w-full border p-2 rounded" type="password" placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)}/><button className="w-full bg-blue-700 text-white py-2 rounded">Entrar</button></form></div>;
}
