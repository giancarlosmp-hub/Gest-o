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
            ...(user?.role === "diretor" ? [{ value: "diretor", label: "Diretor" }] : []),
            { value: "gerente", label: "Gerente" },
            { value: "vendedor", label: "Vendedor" }
          ]
        },
        { key: "region", label: "Região de atuação", placeholder: "Informe a região de atuação" },
        { key: "isActive", label: "Status", tableOnly: true },
        {
          key: "erpCode",
          label: "Vendedor/operador ERP",
          tableLabel: "Vínculo ERP",
          type: "erpSalesman",
          placeholder: "Pesquise pelo nome ou código ERP"
        },
        {
          key: "erpLoginUsername",
          label: "Login FV3 / CPF-CNPJ",
          placeholder: "Documento ou usuário do FV3"
        },
        {
          key: "erpLoginPassword",
          label: "Senha FV3",
          type: "password",
          formOnly: true,
          placeholder: "Preencha apenas para cadastrar/alterar"
        },
        {
          key: "erpLoginConfigured",
          label: "Login FV3 configurado",
          tableOnly: true
        },
        { key: "password", label: "Senha de acesso", placeholder: "Defina uma senha de acesso" }
      ]}
      readOnly={user?.role !== "diretor" && user?.role !== "gerente"}
    />
  );
}
