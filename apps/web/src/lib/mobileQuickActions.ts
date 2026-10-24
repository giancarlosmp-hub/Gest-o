import { brazilTodayKey } from "./brazilDate";

// Botão "Visita" da barra mobile: abre a Nova atividade de visita no dia de Brasília. toISOString() usaria UTC
// e mandaria o dia seguinte depois das 21h, que a API recusa como data futura.
export const visitQuickActionHref = (now = new Date()) =>
  `/atividades?${new URLSearchParams({ open: "create", type: "visita", date: brazilTodayKey(now) }).toString()}`;
