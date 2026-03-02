import type { ChangeEvent } from "react";

export type ClientImportFieldKey = "name" | "city" | "state" | "clientType" | "region" | "potentialHa" | "farmSizeHa" | "cnpj" | "segment" | "ownerSellerId";

export type ClientImportFieldDefinition = {
  key: ClientImportFieldKey;
  label: string;
  required: boolean;
};

type ClientImportColumnMappingStepProps = {
  fields: ClientImportFieldDefinition[];
  excelHeaders: string[];
  mapping: Partial<Record<ClientImportFieldKey, string>>;
  canMapOwnerSeller: boolean;
  onChangeMapping: (field: ClientImportFieldKey, value: string) => void;
  onUseModelHeaders: () => void;
  onSaveMapping: () => void;
  onContinue: () => void;
};

export function ClientImportColumnMappingStep({
  fields,
  excelHeaders,
  mapping,
  canMapOwnerSeller,
  onChangeMapping,
  onUseModelHeaders,
  onSaveMapping,
  onContinue
}: ClientImportColumnMappingStepProps) {
  const visibleFields = canMapOwnerSeller ? fields : fields.filter((field) => field.key !== "ownerSellerId");

  const isRequiredFilled = visibleFields
    .filter((field) => field.required)
    .every((field) => Boolean(mapping[field.key]));

  const handleSelectChange = (fieldKey: ClientImportFieldKey) => (event: ChangeEvent<HTMLSelectElement>) => {
    onChangeMapping(fieldKey, event.target.value);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm text-slate-700">
        Não encontramos todos os cabeçalhos do modelo. Selecione abaixo qual coluna do seu Excel corresponde a cada campo.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {visibleFields.map((field) => (
          <div key={field.key} className="space-y-1">
            <label className="block text-sm font-medium text-slate-700" htmlFor={`map-${field.key}`}>
              {field.label} {field.required ? "*" : "(opcional)"}
            </label>
            <select
              id={`map-${field.key}`}
              className="w-full rounded-lg border border-slate-300 p-2 text-slate-800"
              value={mapping[field.key] ?? ""}
              onChange={handleSelectChange(field.key)}
            >
              <option value="">{field.required ? "— Selecione —" : "— Não informar —"}</option>
              {excelHeaders.map((header) => (
                <option key={`${field.key}-${header}`} value={header}>{header}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onUseModelHeaders} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
          Usar cabeçalhos do modelo (padrão)
        </button>
        <button type="button" onClick={onSaveMapping} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
          Salvar mapeamento
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!isRequiredFilled}
          className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Continuar
        </button>
      </div>
    </div>
  );
}
