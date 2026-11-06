import type { UserRole } from "../../context/AuthContext";

export type UserAdminField = {
  key: string;
  label: string;
  type?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  tableLabel?: string;
  tableOnly?: boolean;
  formOnly?: boolean;
};

// Campos de Configurações → Usuários (formulário e tabela do CrudSimplePage).
// Só o diretor pode atribuir o perfil Diretor.
export function buildUserAdminFields(viewerRole: UserRole | undefined): UserAdminField[] {
  return [
    { key: "name", label: "Nome completo", placeholder: "Informe o nome completo" },
    { key: "email", label: "E-mail corporativo", placeholder: "Informe o e-mail corporativo" },
    {
      key: "role",
      label: "Perfil de acesso",
      type: "select",
      options: [
        ...(viewerRole === "diretor" ? [{ value: "diretor", label: "Diretor" }] : []),
        { value: "gerente", label: "Gerente" },
        { value: "vendedor", label: "Vendedor" }
      ]
    },
    { key: "region", label: "Região de atuação", placeholder: "Informe a região de atuação" },
    { key: "phone", label: "Celular / WhatsApp", type: "tel", placeholder: "(DDD) 9XXXX-XXXX" },
    // Status da conexão do WhatsApp por QR (Fase A); a coluna só aparece com a integração ligada.
    { key: "whatsappConnection", label: "WhatsApp conectado", tableLabel: "WhatsApp", tableOnly: true },
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
  ];
}
