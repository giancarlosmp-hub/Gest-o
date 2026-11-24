import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  MARKETING_CONSENT_NOTE_MAX,
  MARKETING_CONSENT_SOURCE_LABELS,
  MARKETING_CONSENT_SOURCES,
  MARKETING_CONSENT_STATUS_LABELS,
  type MarketingConsentSourceValue,
  type MarketingConsentStatusValue,
} from "@salesforce-pro/shared";
import api from "../../lib/apiClient";
import { getApiErrorMessage } from "../../lib/apiError";

// Card "Boletins WhatsApp" da ficha do cliente (Campanhas WhatsApp Fase 1, sem envio): para cada telefone do
// cliente, a situação atual do aceite dos boletins, os botões de registro e o histórico recolhido; e as
// culturas do cliente (catálogo técnico) para segmentar as campanhas depois. Só recebe boletim o telefone
// cujo registro mais recente é um aceite.

export type BulletinHistoryItem = {
  id: string;
  status: MarketingConsentStatusValue;
  source: MarketingConsentSourceValue;
  note: string | null;
  createdAt: string;
  recordedByName: string | null;
};

export type BulletinPhone = {
  phoneRef: string | null;
  display: string;
  sources: string[];
  current: { status: MarketingConsentStatusValue; source: MarketingConsentSourceValue; createdAt: string } | null;
  canReceive: boolean;
  history: BulletinHistoryItem[];
};

export type CultureOption = { id: string; label: string; category: string };
export type SelectedCulture = { id: string; label: string; isActive: boolean };
export type ClientCultures = { selected: SelectedCulture[]; options: CultureOption[] };

export type ConsentDraft = { phoneRef: string; status: MarketingConsentStatusValue; source: MarketingConsentSourceValue; note: string };

const SOURCE_TAG: Record<string, string> = { erp: "ERP", crm: "Contato" };

const formatDateTime = (value: string) =>
  new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function statusBadge(phone: BulletinPhone) {
  if (!phone.current) return { label: "Sem registro", className: "bg-slate-100 text-slate-700 ring-slate-200" };
  return phone.current.status === "ACEITE"
    ? { label: "Aceite", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" }
    : { label: "Descadastro", className: "bg-rose-50 text-rose-700 ring-rose-200" };
}

type ViewProps = {
  phones: BulletinPhone[] | null;
  phonesError?: string | null;
  cultures: ClientCultures | null;
  culturesError?: string | null;
  draft: ConsentDraft | null;
  selectedCultureIds: string[];
  culturesDirty: boolean;
  saving: boolean;
  onStartDraft: (phoneRef: string, status: MarketingConsentStatusValue) => void;
  onDraftChange: (draft: ConsentDraft) => void;
  onCancelDraft: () => void;
  onSubmitDraft: () => void;
  onToggleCulture: (cultureId: string) => void;
  onSaveCultures: () => void;
};

const buttonBase = "inline-flex min-h-11 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-60";

export function ClientWhatsAppBulletinsView(props: ViewProps) {
  const { phones, cultures, draft, saving } = props;
  const cultureChoices = useMemo(() => {
    if (!cultures) return [];
    const inactiveSelected = cultures.selected.filter((item) => !item.isActive).map((item) => ({ id: item.id, label: `${item.label} (inativa)`, inactive: true }));
    return [...cultures.options.map((item) => ({ id: item.id, label: item.label, inactive: false })), ...inactiveSelected];
  }, [cultures]);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-labelledby="client-bulletins-title">
      <h3 id="client-bulletins-title" className="text-lg font-semibold">Boletins WhatsApp</h3>
      <p className="mb-3 text-sm text-slate-600">Só recebe boletim o telefone com aceite registrado. O descadastro vale até um novo aceite.</p>

      {props.phonesError ? <p className="text-sm text-rose-700">{props.phonesError}</p> : null}
      {!props.phonesError && phones === null ? <p className="text-sm text-slate-500">Carregando telefones…</p> : null}
      {phones && phones.length === 0 ? <p className="text-sm text-slate-500">Nenhum telefone do ERP ou dos contatos deste cliente.</p> : null}

      {phones && phones.length > 0 ? (
        <ul className="divide-y divide-slate-100">
          {phones.map((phone) => {
            const badge = statusBadge(phone);
            const editing = draft && phone.phoneRef && draft.phoneRef === phone.phoneRef ? draft : null;
            return (
              <li key={phone.phoneRef ?? phone.display} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{phone.display}</span>
                  {phone.sources.map((source) => (
                    <span key={source} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{SOURCE_TAG[source] ?? source}</span>
                  ))}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${badge.className}`}>{badge.label}</span>
                  {phone.current ? (
                    <span className="text-xs text-slate-500">
                      {MARKETING_CONSENT_SOURCE_LABELS[phone.current.source]} · {formatDateTime(phone.current.createdAt)}
                    </span>
                  ) : null}
                </div>

                {phone.phoneRef ? (
                  editing ? null : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" className={`${buttonBase} bg-emerald-600 text-white hover:bg-emerald-700`} disabled={saving} onClick={() => props.onStartDraft(phone.phoneRef!, "ACEITE")}>
                        Registrar aceite
                      </button>
                      <button type="button" className={`${buttonBase} border border-rose-300 text-rose-700 hover:bg-rose-50`} disabled={saving} onClick={() => props.onStartDraft(phone.phoneRef!, "DESCADASTRO")}>
                        Registrar descadastro
                      </button>
                    </div>
                  )
                ) : (
                  <p className="mt-1 text-xs text-slate-500">Telefone fora do cadastro atual do cliente: só o histórico.</p>
                )}

                {editing ? (
                  <form
                    className="mt-2 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm"
                    onSubmit={(event) => {
                      event.preventDefault();
                      props.onSubmitDraft();
                    }}
                  >
                    <p className="font-semibold">{editing.status === "ACEITE" ? "Registrar aceite dos boletins" : "Registrar descadastro dos boletins"}</p>
                    <label className="grid gap-1">
                      <span>Origem</span>
                      <select
                        className="min-h-11 rounded-lg border border-slate-300 bg-white px-2"
                        value={editing.source}
                        onChange={(event) => props.onDraftChange({ ...editing, source: event.target.value as MarketingConsentSourceValue })}
                      >
                        {MARKETING_CONSENT_SOURCES.map((source) => (
                          <option key={source} value={source}>{MARKETING_CONSENT_SOURCE_LABELS[source]}</option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1">
                      <span>Observação (opcional)</span>
                      <textarea
                        className="min-h-20 rounded-lg border border-slate-300 bg-white p-2"
                        maxLength={MARKETING_CONSENT_NOTE_MAX}
                        value={editing.note}
                        onChange={(event) => props.onDraftChange({ ...editing, note: event.target.value })}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button type="submit" className={`${buttonBase} bg-slate-900 text-white hover:bg-slate-800`} disabled={saving}>
                        {saving ? "Salvando…" : "Salvar"}
                      </button>
                      <button type="button" className={`${buttonBase} border border-slate-300 text-slate-700 hover:bg-white`} disabled={saving} onClick={props.onCancelDraft}>
                        Cancelar
                      </button>
                    </div>
                  </form>
                ) : null}

                {phone.history.length > 0 ? (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-slate-600">Histórico ({phone.history.length})</summary>
                    <ol className="mt-2 space-y-1">
                      {phone.history.map((item) => (
                        <li key={item.id} className="text-slate-700">
                          <span className="font-medium">{MARKETING_CONSENT_STATUS_LABELS[item.status]}</span>
                          {" · "}{MARKETING_CONSENT_SOURCE_LABELS[item.source]}
                          {" · "}{formatDateTime(item.createdAt)}
                          {item.recordedByName ? ` · ${item.recordedByName}` : ""}
                          {item.note ? <span className="block text-xs text-slate-500">{item.note}</span> : null}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="mt-4 border-t border-slate-100 pt-3">
        <h4 className="font-semibold">Culturas do cliente</h4>
        <p className="mb-2 text-sm text-slate-600">Para escolher quem recebe cada boletim. Lista do catálogo técnico.</p>
        {props.culturesError ? <p className="text-sm text-rose-700">{props.culturesError}</p> : null}
        {!props.culturesError && cultures === null ? <p className="text-sm text-slate-500">Carregando culturas…</p> : null}
        {cultures ? (
          <>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Culturas do cliente">
              {cultureChoices.map((choice) => {
                const checked = props.selectedCultureIds.includes(choice.id);
                return (
                  <label
                    key={choice.id}
                    className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm ${checked ? "border-emerald-400 bg-emerald-50 text-emerald-800" : "border-slate-300 text-slate-700"}`}
                  >
                    <input type="checkbox" className="h-4 w-4" checked={checked} disabled={saving} onChange={() => props.onToggleCulture(choice.id)} />
                    {choice.label}
                  </label>
                );
              })}
            </div>
            {props.culturesDirty ? (
              <button type="button" className={`${buttonBase} mt-2 bg-slate-900 text-white hover:bg-slate-800`} disabled={saving} onClick={props.onSaveCultures}>
                {saving ? "Salvando…" : "Salvar culturas"}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

export default function ClientWhatsAppBulletinsCard({ clientId }: { clientId: string }) {
  const [phones, setPhones] = useState<BulletinPhone[] | null>(null);
  const [phonesError, setPhonesError] = useState<string | null>(null);
  const [cultures, setCultures] = useState<ClientCultures | null>(null);
  const [culturesError, setCulturesError] = useState<string | null>(null);
  const [selectedCultureIds, setSelectedCultureIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<ConsentDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const base = `/whatsapp/bulletins/clients/${encodeURIComponent(clientId)}`;

  const applyCultures = useCallback((data: ClientCultures) => {
    setCultures(data);
    setSelectedCultureIds(data.selected.map((item) => item.id));
  }, []);

  useEffect(() => {
    let active = true;
    setPhones(null);
    setCultures(null);
    setPhonesError(null);
    setCulturesError(null);
    setDraft(null);
    api.get<{ phones: BulletinPhone[] }>(`${base}/consent`)
      .then((response) => active && setPhones(response.data.phones))
      .catch((error) => active && setPhonesError(getApiErrorMessage(error, "Não foi possível carregar os boletins deste cliente.")));
    api.get<ClientCultures>(`${base}/cultures`)
      .then((response) => active && applyCultures(response.data))
      .catch((error) => active && setCulturesError(getApiErrorMessage(error, "Não foi possível carregar as culturas do cliente.")));
    return () => {
      active = false;
    };
  }, [base, applyCultures]);

  const submitDraft = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await api.post<{ phones: BulletinPhone[] }>(`${base}/consent`, {
        phoneRef: draft.phoneRef,
        status: draft.status,
        source: draft.source,
        ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      });
      setPhones(response.data.phones);
      setDraft(null);
      toast.success(draft.status === "ACEITE" ? "Aceite registrado." : "Descadastro registrado.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível registrar."));
    } finally {
      setSaving(false);
    }
  };

  const saveCultures = async () => {
    setSaving(true);
    try {
      const response = await api.put<ClientCultures>(`${base}/cultures`, { cultureIds: selectedCultureIds });
      applyCultures(response.data);
      toast.success("Culturas salvas.");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Não foi possível salvar as culturas."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ClientWhatsAppBulletinsView
      phones={phones}
      phonesError={phonesError}
      cultures={cultures}
      culturesError={culturesError}
      draft={draft}
      selectedCultureIds={selectedCultureIds}
      culturesDirty={Boolean(cultures) && !sameSet(selectedCultureIds, cultures?.selected.map((item) => item.id) ?? [])}
      saving={saving}
      onStartDraft={(phoneRef, status) => setDraft({ phoneRef, status, source: "VENDEDOR_MANUAL", note: "" })}
      onDraftChange={setDraft}
      onCancelDraft={() => setDraft(null)}
      onSubmitDraft={submitDraft}
      onToggleCulture={(cultureId) =>
        setSelectedCultureIds((current) => (current.includes(cultureId) ? current.filter((id) => id !== cultureId) : [...current, cultureId]))
      }
      onSaveCultures={saveCultures}
    />
  );
}
