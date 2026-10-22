// Cliente em cobrança (decisão da diretoria, 22/10/2026): qualquer título de venda vencido há mais de 30 dias
// (dia de Brasília), de qualquer valor. Ele sai de todas as sugestões de venda e vai para a lista "Em cobrança".
// Os dias vêm do título vencido mais antigo com saldo (o mesmo cálculo do "Maior atraso em aberto" da API);
// só contam os tipos de receita de venda (isSalesReceivableTitle). Bordas: 30 dias ainda não é cobrança; 31 é.
export const COLLECTION_OVERDUE_DAYS = 30;

export const CLIENT_IN_COLLECTION_LABEL = "Em cobrança";

// Recomendação fixa para o cliente em cobrança: nunca reativação nem oferta.
export const CLIENT_IN_COLLECTION_RECOMMENDATION = "Cliente em cobrança: não ofertar venda; apoiar a regularização com o financeiro";

export const isClientInCollection = (oldestOverdueDays: number | null | undefined): boolean =>
  typeof oldestOverdueDays === "number" && Number.isFinite(oldestOverdueDays) && oldestOverdueDays > COLLECTION_OVERDUE_DAYS;
