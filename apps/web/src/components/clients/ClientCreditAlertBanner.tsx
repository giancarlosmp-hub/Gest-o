export type ClientCreditAlert = {
  level: "ok" | "atencao" | "risco";
  reasons: string[];
};

type Props = {
  alert?: ClientCreditAlert | null;
  className?: string;
};

// Faixa de crédito calculada pela API (creditAlert). Com "ok" ou sem dado, não mostra nada.
export default function ClientCreditAlertBanner({ alert, className = "" }: Props) {
  if (!alert || alert.level === "ok") return null;
  const isRisk = alert.level === "risco";

  return (
    <div
      role={isRisk ? "alert" : "status"}
      className={`rounded-xl border px-4 py-3 text-sm ${isRisk ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"} ${className}`}
    >
      <p className="font-semibold">{isRisk ? "Risco de crédito: confira com o financeiro antes de vender a prazo." : "Atenção ao crédito deste cliente."}</p>
      {alert.reasons.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {alert.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
