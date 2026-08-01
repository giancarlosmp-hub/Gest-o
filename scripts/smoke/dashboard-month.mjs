const DASHBOARD_TIME_ZONE = "America/Sao_Paulo";

export const getDashboardMonth = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DASHBOARD_TIME_ZONE,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Não foi possível determinar o mês comercial do dashboard");
  return `${year}-${month}`;
};
