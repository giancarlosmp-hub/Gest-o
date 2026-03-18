import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { toast } from "sonner";
import BrandLogo from "../components/BrandLogo";

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (sessionStorage.getItem("session-expired") === "1") {
      sessionStorage.removeItem("session-expired");
      toast.error("Sua sessão expirou. Faça login novamente.");
    }
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    const submittedEmail = String(formData.get("email") ?? "");
    const submittedPassword = String(formData.get("password") ?? "");

    setEmail(submittedEmail);
    setPassword(submittedPassword);

    try {
      await login(submittedEmail, submittedPassword);
      nav("/");
    } catch {
      toast.error("Login inválido");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-700 p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-lg">
        <BrandLogo size="login" variant="light" className="mb-1" />
        <p className="text-sm text-slate-600">Acesse o painel comercial.</p>
        <input
          className="w-full rounded-lg border p-2"
          type="email"
          name="email"
          autoComplete="username"
          placeholder="Email"
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="w-full rounded-lg border p-2"
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Senha"
          defaultValue=""
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="w-full rounded-lg bg-brand-700 py-2 font-medium text-white hover:bg-brand-800">Entrar</button>
      </form>
    </div>
  );
}
