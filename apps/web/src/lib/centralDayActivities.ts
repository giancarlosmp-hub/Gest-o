import { brazilDayKeyOf, brazilTodayKey } from "./brazilDate";

// Atividades da Central do Dia, em dias de Brasília.

export type CentralDayActivity = { done: boolean; date?: string | null; createdAt: string; dueDate: string };

// Data da execução: a data informada na atividade (date); sem ela, o cadastro ou o vencimento.
const executionDateOf = (activity: CentralDayActivity) => activity.date || activity.createdAt || activity.dueDate;

// Feito hoje: só a atividade concluída, pela data da execução. É o que a Rotina Comercial do Dia conta.
export const isActivityDoneToday = (activity: CentralDayActivity, now = new Date()) =>
  activity.done && brazilDayKeyOf(executionDateOf(activity)) === brazilTodayKey(now);

// Lista do dia: concluídas hoje e pendentes que vencem hoje. Pendente de dia anterior fica fora.
export const isActivityOfToday = (activity: CentralDayActivity, now = new Date()) =>
  activity.done ? isActivityDoneToday(activity, now) : brazilDayKeyOf(activity.dueDate) === brazilTodayKey(now);
