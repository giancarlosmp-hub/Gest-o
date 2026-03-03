const cardClass = "rounded-2xl border border-dashed border-slate-300 bg-white p-6 shadow-sm";

export default function AssistenteTecnico() {
  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Assistente Técnico</h1>
        <p className="text-sm text-slate-600">Ferramentas para apoio técnico e regulagem de plantio.</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <article className={cardClass}>
          <h2 className="text-base font-semibold text-slate-800">Calculadora de Semeadura</h2>
          <p className="mt-2 text-sm text-slate-500">Em breve.</p>
        </article>

        <article className={cardClass}>
          <h2 className="text-base font-semibold text-slate-800">Indicação de Plantio (kg/ha)</h2>
          <p className="mt-2 text-sm text-slate-500">Em breve.</p>
        </article>
      </div>
    </section>
  );
}
