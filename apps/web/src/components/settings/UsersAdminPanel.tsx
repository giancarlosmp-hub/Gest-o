import { Navigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { canAccessRoute } from "../../lib/authorization";
import CrudSimplePage from "../../pages/CrudSimplePage";

export default function UsersAdminPanel() {
  const { user } = useAuth();

  if (!canAccessRoute("usuarios", user?.role)) return <Navigate to="/" replace />;

  return (
    <CrudSimplePage
      endpoint="/users"
      title="Usuários"
      fields={[
        { key: "name", label: "Nome" },
        { key: "email", label: "Email" },
        { key: "role", label: "Papel" },
        { key: "region", label: "Região" },
        { key: "password", label: "Senha" }
      ]}
      readOnly={user?.role !== "diretor"}
    />
  );
}
