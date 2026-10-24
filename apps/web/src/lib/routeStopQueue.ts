// Check-in e check-out das paradas do roteiro feitos sem internet: ficam guardados no aparelho, por usuário, e são
// enviados quando a conexão volta, com a hora do aparelho. Mesmo padrão do rascunho da visita: toda leitura e
// gravação passa por try/catch e, com o armazenamento bloqueado, a tela segue sem fila.

export const ROUTE_STOP_QUEUE_TTL_MS = 24 * 3_600_000;
export const ROUTE_STOP_QUEUE_CHANGE_EVENT = "route-stop-queue-change";

export type RouteStopAction = "check-in" | "check-out";

export type RouteStopGeo = {
  lat?: number;
  lng?: number;
  accuracy?: number;
  timestamp: string;
};

export type QueuedRouteStopAction = {
  stopId: string;
  action: RouteStopAction;
  payload: RouteStopGeo;
  queuedAt: string;
};

type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type QueueOptions = { storage?: QueueStorage | null; now?: Date };

const keyFor = (userId: string) => `gest-o:route-stop-queue:${userId}`;

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

const isQueuedAction = (item: any): item is QueuedRouteStopAction =>
  Boolean(item) &&
  typeof item.stopId === "string" &&
  (item.action === "check-in" || item.action === "check-out") &&
  typeof item.payload?.timestamp === "string" &&
  typeof item.queuedAt === "string";

const writeQueue = (userId: string, items: QueuedRouteStopAction[], options: QueueOptions) => {
  try {
    const storage = resolveStorage(options);
    if (!storage) return false;
    if (items.length) storage.setItem(keyFor(userId), JSON.stringify(items));
    else storage.removeItem(keyFor(userId));
  } catch {
    return false;
  }
  notifyChange();
  return true;
};

// Ações pendentes do usuário, na ordem em que foram feitas. As com mais de 24 horas são descartadas.
export const loadRouteStopQueue = (userId: string | null | undefined, options: QueueOptions = {}): QueuedRouteStopAction[] => {
  if (!userId) return [];
  let raw: string | null = null;
  try {
    raw = resolveStorage(options)?.getItem(keyFor(userId)) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeQueue(userId, [], options);
    return [];
  }
  const items = Array.isArray(parsed) ? parsed.filter(isQueuedAction) : [];
  const now = (options.now ?? new Date()).getTime();
  const fresh = items.filter((item) => {
    const queuedAt = Date.parse(item.queuedAt);
    return Number.isFinite(queuedAt) && now - queuedAt < ROUTE_STOP_QUEUE_TTL_MS;
  });
  if (!Array.isArray(parsed) || fresh.length !== parsed.length) writeQueue(userId, fresh, options);
  return fresh;
};

// Guarda a ação. Repetir a mesma ação da mesma parada não duplica: vale a primeira, como no servidor.
export const enqueueRouteStopAction = (
  userId: string | null | undefined,
  item: Omit<QueuedRouteStopAction, "queuedAt">,
  options: QueueOptions = {}
) => {
  if (!userId) return false;
  const current = loadRouteStopQueue(userId, options);
  if (current.some((queued) => queued.stopId === item.stopId && queued.action === item.action)) return true;
  return writeQueue(userId, [...current, { ...item, queuedAt: (options.now ?? new Date()).toISOString() }], options);
};

export const pendingRouteStopActions = (queue: QueuedRouteStopAction[], stopId: string) =>
  queue.filter((item) => item.stopId === stopId).map((item) => item.action);

// Erro de rede (sem resposta do servidor): a ação fica na fila. Recusa do servidor (4xx) sai da fila.
export const isNetworkError = (error: unknown) => {
  const candidate = error as { response?: unknown; request?: unknown; code?: string } | null;
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.response) return false;
  return Boolean(candidate.request) || candidate.code === "ERR_NETWORK" || candidate.code === "ECONNABORTED";
};

type FlushResult = { sent: QueuedRouteStopAction[]; refused: QueuedRouteStopAction[]; remaining: number };

// Envia a fila em ordem (check-in antes do check-out). Para no primeiro erro de rede; o que o servidor recusar sai.
export const flushRouteStopQueue = async (
  userId: string | null | undefined,
  send: (item: QueuedRouteStopAction) => Promise<unknown>,
  options: QueueOptions = {}
): Promise<FlushResult> => {
  const queue = loadRouteStopQueue(userId, options);
  const sent: QueuedRouteStopAction[] = [];
  const refused: QueuedRouteStopAction[] = [];
  let index = 0;
  for (; index < queue.length; index += 1) {
    try {
      await send(queue[index]);
      sent.push(queue[index]);
    } catch (error) {
      if (isNetworkError(error)) break;
      refused.push(queue[index]);
    }
  }
  if (userId && (sent.length || refused.length)) {
    // Relê a fila: ações novas guardadas durante o envio continuam nela.
    const handled = new Set([...sent, ...refused].map((item) => `${item.stopId}:${item.action}`));
    const latest = loadRouteStopQueue(userId, options).filter((item) => !handled.has(`${item.stopId}:${item.action}`));
    writeQueue(userId, latest, options);
    return { sent, refused, remaining: latest.length };
  }
  return { sent, refused, remaining: queue.length - index };
};
