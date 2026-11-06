import assert from "node:assert/strict";
import { once } from "node:events";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { createAsyncRouter } from "./asyncRouter.js";

// Rotas fictícias: rejeição de handler async vira next(err); o resto do comportamento do Express não muda.
const router = createAsyncRouter();
const handledErrors: string[] = [];

router.get("/sync-ok", (_req, res) => {
  res.json({ ok: true });
});
router.get("/sync-throw", () => {
  throw new Error("falha-sincrona");
});
router.get("/async-ok", async (_req, res) => {
  await Promise.resolve();
  res.json({ ok: true });
});
router.get("/async-reject", async () => {
  await Promise.resolve();
  throw new Error("falha-async");
});
router.get("/async-reject-empty", async () => {
  await Promise.resolve();
  return Promise.reject(undefined);
});
router.get("/async-middleware", [async (_req: Request, _res: Response, _next: NextFunction) => {
  await Promise.resolve();
  throw new Error("falha-middleware");
}], (_req: Request, res: Response) => res.json({ ok: true }));
router.get("/next-twice-guard", async (_req, _res, next) => {
  next();
});
router.get("/next-twice-guard", (_req, res) => res.json({ reached: "segundo handler" }));

const scoped = createAsyncRouter();
scoped.use(async () => {
  await Promise.resolve();
  throw new Error("falha-use");
});
router.use("/scoped", scoped);

// Sub-router comum montado sem embrulho: a própria função do router fica na pilha.
const plainSubRouter = Router();
plainSubRouter.get("/ping", (_req, res) => res.json({ pong: true }));
router.use("/plain", plainSubRouter);

// Handler de erro async (aridade 4) que rejeita: o erro segue para o próximo handler de erro.
const errorChain = createAsyncRouter();
errorChain.get("/", async () => {
  throw new Error("falha-original");
});
errorChain.use(async (err: Error, _req: Request, _res: Response, _next: NextFunction) => {
  handledErrors.push(`primeiro:${err.message}`);
  throw new Error("falha-no-handler-de-erro");
});
router.use("/error-chain", errorChain);

const app = express();
app.use(router);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  handledErrors.push(message);
  res.status(500).json({ handled: message });
});

const plainLayer = (router as unknown as { stack: Array<{ handle: unknown; regexp: RegExp }> }).stack.find((layer) => layer.regexp.test("/plain"));
assert.equal(plainLayer?.handle, plainSubRouter, "sub-router comum não é embrulhado");
const errorLayer = (errorChain as unknown as { stack: Array<{ handle: { length: number } }> }).stack.at(-1);
assert.equal(errorLayer?.handle.length, 4, "handler de erro mantém aridade 4");

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const call = async (path: string) => {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(2000) });
  return { status: response.status, body: await response.json(), elapsedMs: Date.now() - startedAt };
};

try {
  const syncOk = await call("/sync-ok");
  assert.equal(syncOk.status, 200);
  assert.deepEqual(syncOk.body, { ok: true });
  assert.deepEqual((await call("/sync-throw")).body, { handled: "falha-sincrona" });
  assert.deepEqual((await call("/async-ok")).body, { ok: true });

  const rejected = await call("/async-reject");
  assert.equal(rejected.status, 500);
  assert.deepEqual(rejected.body, { handled: "falha-async" });
  assert.ok(rejected.elapsedMs < 1000, `rejeição async responde rápido (${rejected.elapsedMs} ms)`);

  assert.deepEqual((await call("/async-reject-empty")).body, { handled: "Handler async rejeitado sem motivo." });
  assert.deepEqual((await call("/async-middleware")).body, { handled: "falha-middleware" });
  assert.deepEqual((await call("/next-twice-guard")).body, { reached: "segundo handler" });
  assert.deepEqual((await call("/scoped/qualquer")).body, { handled: "falha-use" });
  assert.deepEqual((await call("/plain/ping")).body, { pong: true });

  handledErrors.length = 0;
  assert.deepEqual((await call("/error-chain")).body, { handled: "falha-no-handler-de-erro" });
  assert.deepEqual(handledErrors, ["primeiro:falha-original", "falha-no-handler-de-erro"]);

  console.log("asyncRouter.test.ts: ok");
} finally {
  server.close();
}
