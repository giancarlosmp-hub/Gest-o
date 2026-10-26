import assert from "node:assert/strict";
import fs from "node:fs";
import { crudModalHeading } from "../src/lib/crudModalHeading.js";

// Dados fictícios: o modal de cliente mostra "Novo cliente" no cadastro e "Editar cliente" na edição.
const texts = {
  createTitle: "Novo cliente",
  createSubtitle: "Preencha os dados para cadastrar um cliente.",
  editTitle: "Editar cliente",
  editSubtitle: "Atualize os dados do cliente.",
};
assert.deepEqual(crudModalHeading(null, texts), { title: "Novo cliente", subtitle: "Preencha os dados para cadastrar um cliente." });
assert.deepEqual(crudModalHeading("cliente-ficticio-1", texts), { title: "Editar cliente", subtitle: "Atualize os dados do cliente." });

const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(app, /createModalTitle="Novo cliente"\s+editModalTitle="Editar cliente"\s+editModalSubtitle="Atualize os dados do cliente\."/, "Clientes passa os textos de edição");

const page = fs.readFileSync(new URL("../src/pages/CrudSimplePage.tsx", import.meta.url), "utf8");
assert.match(page, /const modalHeading = crudModalHeading\(editing, \{/, "o modal usa o registro em edição");
assert.match(page, /\{modalHeading\.title\}<\/h3>\s*<p className="text-sm text-slate-500">\{modalHeading\.subtitle\}<\/p>/, "título e subtítulo vêm do modalHeading");

console.log("CLIENT_FORM_TITLE=PASS");
