import type { StopResultForm } from "./routeExecution";

// Check-in, check-out e resultado das paradas do roteiro feitos sem internet: ficam guardados no aparelho, por
// usuário, e são enviados quando a conexão volta, na ordem em que foram feitos, com a hora do aparelho. Mesmo padrão
// do rascunho da visita: toda leitura e gravação passa por try/catch e, com o armazenamento bloqueado, a tela segue
// sem fila. Nada some em silêncio: o que o servidor recusar e o que passar de 72 horas sem conexão vai para
// "Não enviados", com os dados preservados, até o vendedor reenviar, corrigir ou descartar.

export const ROUTE_STOP_QUEUE_TTL_MS = 72 * 3_600_000;
export const ROUTE_STOP_QUEUE_CHANGE_EVENT = "route-stop-queue-change";
export const ROUTE_STOP_EXPIRED_MESSAGE = "Ficou mais de 72 horas sem conexão e não foi enviado.";

export type RouteStopAction = "check-in" | "check-out" | "result";

export type RouteStopGeo = {
  lat?: number;
  lng?: number;
  accuracy?: number;
  timestamp: string;
};

// Corpo de PATCH /agenda-events/:stopId/result (stopResultPayload).
export type RouteStopResultPayload = { status: "realizada" | "nao_realizada"; [key: string]: unknown };

type QueuedBase = {
  stopId: string;
  queuedAt: string;
  // Nome da parada para a lista "Não enviados" (fica só no aparelho).
  stopLabel?: string;
};

export type QueuedRouteStopAction =
  | (QueuedBase & { action: "check-in" | "check-out"; payload: RouteStopGeo })
  // form: o formulário preenchido, para o vendedor corrigir se o servidor recusar.
  | (QueuedBase & { action: "result"; payload: RouteStopResultPayload; form?: StopResultForm });

type WithoutQueuedAt<Item> = Item extends unknown ? Omit<Item, "queuedAt"> : never;
export type NewRouteStopAction = WithoutQueuedAt<QueuedRouteStopAction>;

export type UnsentRouteStopAction = QueuedRouteStopAction & {
  unsentAt: string;
  unsentReason: "refused" | "expired";
  message: string | null;
};

type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type QueueOptions = { storage?: QueueStorage | null; now?: Date };

const keyFor = (userId: string) => `gest-o:route-stop-queue:${userId}`;
const unsentKeyFor = (userId: string) => `gest-o:route-stop-unsent:${userId}`;
const itemKey = (item: { stopId: string; action: RouteStopAction }) => `${item.stopId}:${item.action}`;

const defaultStorage = (): QueueStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const resolveStorage = (options: QueueOptions) => (options.storage === undefined ? defaultStorage() : options.storage);

const notifyChange = () => {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(ROUTE_STOP_QUEUE_CHANGE_EVENT));
  } catch {
    // Sem window ou sem eventos: nada a avisar.
  }
};

const isQueuedAction = (item: any): item is QueuedRouteStopAction => {
  if (!item || typeof item.stopId !== "string" || typeof item.queuedAt !== "string") return false;
  if (item.action === "check-in" || item.action === "check-out") return typeof item.payload?.timestamp === "string";
  if (item.action === "result") return item.payload?.status === "realizada" || item.payload?.status === "nao_realizada";
  return false;
};

const isUnsentAction = (item: any): item is UnsentRouteStopAction =>
  isQueuedAction(item) &&
  typeof (item as UnsentRouteStopAction).unsentAt === "string" &&
  ((item as UnsentRouteStopAction).unsentReason === "refused" || (item as UnsentRouteStopAction).unsentReason === "expired");

const writeList = (key: string, items: unknown[], options: QueueOptions) => {
  try {
    const storage = resolveStorage(options);
    if (!storage) return false;
    if (items.length) storage.setItem(key, JSON.stringify(items));
    else storage.removeItem(key);
  } catch {
    return false;
  }
  notifyChange();
  return true;
};

const readList = (key: string, options: QueueOptions): { items: unknown[]; valid: boolean } | null => {
  let raw: string | null = null;
  try {
    raw = resolveStorage(options)?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (!raw) return { items: [], valid: true };
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? { items: parsed, valid: true } : { items: [], valid: false };
  } catch {
    return { items: [], valid: false };
  }
};

// "Não enviados" do usuário, do mais antigo para o mais novo.
export const loadUnsentRouteStopActions = (userId: string | null | undefined, options: QueueOptions = {}): UnsentRouteStopAction[] => {
  if (!userId) return [];
  const list = readList(unsentKeyFor(userId), options);
  if (!list) return [];
  const items = list.items.filter(isUnsentAction);
  if (!list.valid || items.length !== list.items.length) writeList(unsentKeyFor(userId), items, options);
  return items;
};

// Guarda em "Não enviados"; um novo registro da mesma ação da mesma parada substitui o anterior.
const addUnsent = (userId: string, items: UnsentRouteStopAction[], options: QueueOptions) => {
  if (!items.length) return true;
  const replaced = new Set(items.map(itemKey));
  const current = loadUnsentRouteStopActions(userId, options).filter((item) => !replaced.has(itemKey(item)));
  return writeList(unsentKeyFor(userId), [...current, ...items], options);
};

export const removeUnsentRouteStopAction = (
  userId: string | null | undefined,
  item: { stopId: string; action: RouteStopAction },
  options: QueueOptions = {}
) => {
  if (!userId) return false;
  const current = loadUnsentRouteStopActions(userId, options);
  const remaining = current.filter((queued) => itemKey(queued) !== itemKey(item));
  return remaining.length === current.length ? true : writeList(unsentKeyFor(userId), remaining, options);
};

const toUnsent = (
  item: QueuedRouteStopAction,
  unsentReason: UnsentRouteStopAction["unsentReason"],
  message: string | null,
  now: Date
): UnsentRouteStopAction => ({ ...item, unsentAt: now.toISOString(), unsentReason, message });

// Ações pendentes do usuário, na ordem em que foram feitas. As com mais de 72 horas vão para "Não enviados".
export const loadRouteStopQueue = (userId: string | null | undefined, options: QueueOptions = {}): QueuedRouteStopAction[] => {
  if (!userId) return [];
  const list = readList(keyFor(userId), options);
  if (!list) return [];
  const items = list.items.filter(isQueuedAction);
  const now = options.now ?? new Date();
  const isFresh = (item: QueuedRouteStopAction) => {
    const queuedAt = Date.parse(item.queuedAt);
    return Number.isFinite(queuedAt) && now.getTime() - queuedAt < ROUTE_STOP_QUEUE_TTL_MS;
  };
  const fresh = items.filter(isFresh);
  const expired = items.filter((item) => !isFresh(item));
  if (expired.length) addUnsent(userId, expired.map((item) => toUnsent(item, "expired", ROUTE_STOP_EXPIRED_MESSAGE, now)), options);
  if (!list.valid || fresh.length !== list.items.length) writeList(keyFor(userId), fresh, options);
  return fresh;
};

// Guarda a ação. Repetir a mesma ação da mesma parada não duplica: vale a primeira, como no servidor.
export const enqueueRouteStopAction = (userId: string | null | undefined, item: NewRouteStopAction, options: QueueOptions = {}) => {
  if (!userId) return false;
  const current = loadRouteStopQueue(userId, options);
  if (current.some((queued) => itemKey(queued) === itemKey(item))) return true;
  return writeList(keyFor(userId), [...current, { ...item, queuedAt: (options.now ?? new Date()).toISOString() }], options);
};

export const pendingRouteStopActions = (queue: QueuedRouteStopAction[], stopId: string) =>
  queue.filter((item) => item.stopId === stopId).map((item) => item.action);

// Resultado guardado da parada, se houver.
export const queuedRouteStopResult = (queue: QueuedRouteStopAction[], stopId: string) => {
  const item = queue.find((queued) => queued.stopId === stopId && queued.action === "result");
  return item?.action === "result" ? item.payload : null;
};

// Erro de rede (sem resposta do servidor): a ação fica na fila. Recusa do servidor (4xx) vai para "Não enviados".
export const isNetworkError = (error: unknown) => {
  const candidate = error as { response?: unknown; request?: unknown; code?: string } | null;
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.response) return false;
  return Boolean(candidate.request) || candidate.code === "ERR_NETWORK" || candidate.code === "ECONNABORTED";
};

const serverMessage = (error: unknown) => {
  const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
};

// O servidor já tinha um resultado para a parada: o envio não foi aplicado (vale o primeiro).
const wasNotApplied = (response: unknown) => (response as { data?: { applied?: unknown } } | null)?.data?.applied === false;

type FlushResult = {
  sent: QueuedRouteStopAction[];
  refused: QueuedRouteStopAction[];
  notApplied: QueuedRouteStopAction[];
  remaining: number;
};

// Envia a fila em ordem (check-in, check-out e resultado). Para no primeiro erro de rede; o que o servidor recusar sai
// da fila e vai para "Não enviados".
export const flushRouteStopQueue = async (
  userId: string | null | undefined,
  send: (item: QueuedRouteStopAction) => Promise<unknown>,
  options: QueueOptions = {}
): Promise<FlushResult> => {
  const queue = loadRouteStopQueue(userId, options);
  const sent: QueuedRouteStopAction[] = [];
  const refused: UnsentRouteStopAction[] = [];
  const notApplied: QueuedRouteStopAction[] = [];
  let index = 0;
  for (; index < queue.length; index += 1) {
    try {
      const response = await send(queue[index]);
      sent.push(queue[index]);
      if (wasNotApplied(response)) notApplied.push(queue[index]);
    } catch (error) {
      if (isNetworkError(error)) break;
      refused.push(toUnsent(queue[index], "refused", serverMessage(error), options.now ?? new Date()));
    }
  }
  if (userId && (sent.length || refused.length)) {
    addUnsent(userId, refused, options);
    // Relê a fila: ações novas guardadas durante o envio continuam nela.
    const handled = new Set([...sent, ...refused].map(itemKey));
    const latest = loadRouteStopQueue(userId, options).filter((item) => !handled.has(itemKey(item)));
    writeList(keyFor(userId), latest, options);
    return { sent, refused, notApplied, remaining: latest.length };
  }
  return { sent, refused, notApplied, remaining: queue.length - index };
};

export type RetryResult = { status: "sent" | "not_applied" | "network" | "refused"; message: string | null };

// "Reenviar" de um item de "Não enviados": enviado sai da lista; recusado fica com a nova mensagem; sem rede, fica.
export const retryUnsentRouteStopAction = async (
  userId: string | null | undefined,
  item: UnsentRouteStopAction,
  send: (item: QueuedRouteStopAction) => Promise<unknown>,
  options: QueueOptions = {}
): Promise<RetryResult> => {
  try {
    const response = await send(item);
    removeUnsentRouteStopAction(userId, item, options);
    return { status: wasNotApplied(response) ? "not_applied" : "sent", message: null };
  } catch (error) {
    if (isNetworkError(error)) return { status: "network", message: null };
    const message = serverMessage(error);
    if (userId) addUnsent(userId, [toUnsent(item, "refused", message, options.now ?? new Date())], options);
    return { status: "refused", message };
  }
};
