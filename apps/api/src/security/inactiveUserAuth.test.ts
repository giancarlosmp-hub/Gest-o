import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { createAuthMiddleware } from "../middlewares/auth.js";
import { signAccessToken } from "../utils/jwt.js";

const activeId = "active-user";
const middleware = createAuthMiddleware(async (decoded) =>
  decoded.id === activeId ? decoded : null,
);
const app = express();
app.get("/protected", middleware, (_req, res) => res.json({ ok: true }));
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const call = (id: string) =>
  fetch(`http://127.0.0.1:${address.port}/protected`, {
    headers: {
      authorization: `Bearer ${signAccessToken({ id, email: `${id}@test.invalid`, role: "vendedor" })}`,
    },
  });

try {
  assert.equal(
    (await call(activeId)).status,
    200,
    "usuário ativo real resolvido deve autenticar",
  );
  assert.equal(
    (await call("deactivated-user")).status,
    401,
    "token antigo de usuário desativado deve ser rejeitado",
  );
  const failing = createAuthMiddleware(async () => {
    throw new Error("database unavailable");
  });
  const response = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  await failing(
    {
      headers: {
        authorization: `Bearer ${signAccessToken({ id: activeId, email: "a@test.invalid", role: "vendedor" })}`,
      },
    } as any,
    response as any,
    () => assert.fail("resolvedor indisponível não pode autorizar"),
  );
  assert.equal(
    response.statusCode,
    401,
    "resolvedor produtivo deve falhar fechado",
  );
  console.log("INACTIVE_USER_AUTH=PASS");
} finally {
  server.close();
}
