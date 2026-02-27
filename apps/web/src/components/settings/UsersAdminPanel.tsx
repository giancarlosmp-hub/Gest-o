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
      readOnly={user?.role !== "diretor"}
    />
  );
}
