import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrismaClient } from "@prisma/client";

// Apoio dos testes da Fase A do WhatsApp (não é carregado pela aplicação): Prisma em memória para User e
// WhatsAppConnection, um Evolution falso e a captura de tudo o que vai para o console.
// Só dados fictícios.

type Row = Record<string, any>;

export const FAKE_QR =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const baseUsers = [
  { id: "director-a", name: "Diretor Ficticio", email: "director-a@test.invalid", role: "diretor", phone: null },
  { id: "manager-a", name: "Gerente Ficticio", email: "manager-a@test.invalid", role: "gerente", phone: null },
  { id: "seller-a", name: "Vendedor Ficticio A", email: "seller-a@test.invalid", role: "vendedor", phone: "5511900000001" },
  { id: "seller-b", name: "Vendedor Ficticio B", email: "seller-b@test.invalid", role: "vendedor", phone: "5521900000002" },
  { id: "seller-c", name: "Vendedor Ficticio C", email: "seller-c@test.invalid", role: "vendedor", phone: "5511900000001" },
  { id: "seller-d", name: "Vendedor Ficticio D", email: "seller-d@test.invalid", role: "vendedor", phone: "5531980000004" },
  { id: "seller-nophone", name: "Vendedor Ficticio Sem Celular", email: "seller-nophone@test.invalid", role: "vendedor", phone: null }
];

const project = (row: Row | undefined, select?: Row) =>
  !row ? null : select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]])) : { ...row };

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === "NOT") return !matches(row, value as Row);
    return row[key] === value;
  });

export function createWhatsAppTestHarness(prisma: PrismaClient) {
  const users: Row[] = baseUsers.map((user) => ({ isActive: true, region: null, ...user }));
  const connections: Row[] = [];
  let sequence = 0;

  const setModel = (model: string, methods: Record<string, unknown>) => {
    const target = (prisma as any)[model];
    for (const [key, value] of Object.entries(methods)) target[key] = value;
  };
  setModel("user", {
    findFirst: async ({ where, select }: any) => project(users.find((row) => row.id === where?.id && row.isActive), select),
    findUnique: async ({ where, select }: any) => project(users.find((row) => row.id === where?.id), select)
  });
  const findConnection = (where: Row) => connections.find((row) => matches(row, where));
  setModel("whatsAppConnection", {
    findUnique: async ({ where }: any) => project(findConnection(where)),
    findFirst: async ({ where, select }: any) => project(findConnection(where), select),
    findMany: async () => connections.map((row) => project(row)),
    upsert: async ({ where, create, update }: any) => {
      const existing = findConnection(where);
      const now = new Date();
      if (existing) {
        Object.assign(existing, update, { updatedAt: now });
        return project(existing);
      }
      const row = { id: `conn-${++sequence}`, tenantId: null, provider: "evolution", createdAt: now, updatedAt: now, ...create };
      connections.push(row);
      return project(row);
    },
    update: async ({ where, data }: any) => {
      const row = findConnection(where);
      if (!row) throw new Error("registro inexistente");
      Object.assign(row, data, { updatedAt: new Date() });
      return project(row);
    }
  });

  // Evolution falso: instâncias em memória; "down" simula o container fora do ar.
  const instances = new Map<string, { state: "connecting" | "open" | "close"; ownerJid: string | null }>();
  const requests: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: any }> = [];
  const evolution = {
    instances,
    requests,
    down: false,
    open(name: string, ownerJid: string) {
      instances.set(name, { state: "open", ownerJid });
    },
    close(name: string) {
      const instance = instances.get(name);
      if (instance) instance.state = "close";
    },
    async handler(req: IncomingMessage, res: ServerResponse) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const send = (status: number, payload: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      if (evolution.down) return send(500, { error: "fora do ar" });
      if (req.headers.apikey !== "chave-ficticia-evolution") return send(401, { error: "Unauthorized" });
      const url = new URL(req.url!, "http://evolution.invalid");
      const name = decodeURIComponent(url.pathname.split("/").pop() || "");
      const missing = () => send(404, { response: { message: [`The "${name}" instance does not exist`] } });
      if (req.method === "POST" && url.pathname === "/instance/create") {
        instances.set(body.instanceName, { state: "connecting", ownerJid: null });
        return send(201, { instance: { instanceName: body.instanceName, status: "connecting" }, hash: "token-ficticio", qrcode: { base64: FAKE_QR } });
      }
      if (req.method === "GET" && url.pathname.startsWith("/instance/connect/")) {
        const instance = instances.get(name);
        if (!instance) return missing();
        return instance.state === "open" ? send(200, { instance: { instanceName: name, state: "open" } }) : send(200, { base64: FAKE_QR, count: 1 });
      }
      if (req.method === "GET" && url.pathname.startsWith("/instance/connectionState/")) {
        const instance = instances.get(name);
        return instance ? send(200, { instance: { instanceName: name, state: instance.state } }) : missing();
      }
      if (req.method === "GET" && url.pathname === "/instance/fetchInstances") {
        const instance = instances.get(url.searchParams.get("instanceName") || "");
        return send(200, instance ? [{ name: url.searchParams.get("instanceName"), ownerJid: instance.ownerJid, connectionStatus: instance.state }] : []);
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/instance/delete/")) {
        if (!instances.delete(name)) return missing();
        return send(200, { status: "SUCCESS" });
      }
      return send(404, { error: "rota inexistente no Evolution falso" });
    }
  };

  // Tudo o que a aplicação escrever no console fica guardado para os testes de log.
  const logs: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => {
    logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  const restoreConsole = () => Object.assign(console, original);

  return { users, connections, evolution, logs, restoreConsole, FAKE_QR };
}
