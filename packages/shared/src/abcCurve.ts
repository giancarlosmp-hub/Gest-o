// Curva ABC de clientes pelo faturamento da janela (ganhos efetivos do CRM nos últimos 90 dias).
// Só entra quem faturou mais que zero: os primeiros 20% (arredondado para cima) são A, até 50% são B e o
// resto é C. Cliente sem faturamento na janela não tem classe. Empate de valor desempata pelo id do
// cliente, para a lista de clientes e o gráfico do Dashboard darem a mesma classe.
export type AbcClass = "A" | "B" | "C";

export const ABC_CLASSES: AbcClass[] = ["A", "B", "C"];

export const ABC_WINDOW_DAYS = 90;

export const isAbcClass = (value: unknown): value is AbcClass =>
  typeof value === "string" && (ABC_CLASSES as string[]).includes(value);

export const classifyAbcCurve = (revenueByClient: Map<string, number>): Map<string, AbcClass> => {
  const ranked = [...revenueByClient.entries()]
    .filter(([, revenue]) => revenue > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const limitA = Math.ceil(ranked.length * 0.2);
  const limitB = Math.ceil(ranked.length * 0.5);
  return new Map(ranked.map(([clientId], index) => [clientId, index < limitA ? "A" : index < limitB ? "B" : "C"]));
};
