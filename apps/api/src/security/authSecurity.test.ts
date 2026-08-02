import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import ts from "typescript";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { login } from "../controllers/authController.js";
import { authMiddleware } from "../middlewares/auth.js";
import { hashPassword } from "../utils/password.js";

const fixtureEmail = "security.user@example.test";
const fixturePassword = "Fictitious-password-42!";
const fixtureId = "fixture-user-id";

const captureConsole = async (run: () => Promise<unknown>) => {
  const entries: unknown[][] = [];
  const originals = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  for (const method of Object.keys(originals) as Array<keyof typeof originals>) {
    console[method] = (...args: unknown[]) => { entries.push(args); };
  }
  try { await run(); } finally { Object.assign(console, originals); }
  return JSON.stringify(entries);
};

const response = () => {
  const state = { status: 200, body: undefined as unknown, headersSent: false, cookie: undefined as unknown };
  const res = {
    get headersSent() { return state.headersSent; },
    status(code: number) { state.status = code; return res; },
    json(body: unknown) { state.body = body; state.headersSent = true; return res; },
    cookie(_name: string, value: unknown) { state.cookie = value; return res; },
  };
  return { res, state };
};

test("diagnóstico administrativo não existe, inclusive com barra final", async () => {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    for (const path of ["/debug/admin", "/debug/admin/"]) {
      const result: globalThis.Response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      assert.equal(result.status, 404);
      const body = await result.text();
      assert.doesNotMatch(body, /security\.user|password|hash|credential/i);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("login preserva sucesso e torna falhas de credencial equivalentes sem logs sensíveis", async () => {
  const passwordHash = await hashPassword(fixturePassword);
  const originalFindUnique = prisma.user.findUnique;
  const user = { id: fixtureId, email: fixtureEmail, name: "Fixture User", role: "diretor", region: "Nacional", isActive: true, passwordHash };

  try {
    for (const scenario of [
      { password: fixturePassword, found: user, status: 200, event: "auth_login_success" },
      { password: "incorrect-password", found: user, status: 401, event: "auth_login_failure" },
      { password: "incorrect-password", found: null, status: 401, event: "auth_login_failure" },
    ]) {
      (prisma.user as any).findUnique = async () => scenario.found;
      const { res, state } = response();
      const logs = await captureConsole(() => login({ body: { email: fixtureEmail, password: scenario.password }, requestId: "req-fixture" } as any, res as any));
      assert.equal(state.status, scenario.status);
      assert.match(logs, new RegExp(scenario.event));
      for (const forbidden of [fixtureEmail, fixtureId, fixturePassword, scenario.password, passwordHash, passwordHash.slice(0, 4), "accessToken", "refreshToken", "authorization", "cookie", "passwordMatches", "compare_result"]) {
        assert.equal(logs.toLowerCase().includes(forbidden.toLowerCase()), false, `logs contêm valor proibido: ${forbidden}`);
      }
      if (scenario.status === 200) {
        assert.equal(typeof (state.body as any).accessToken, "string");
        assert.equal(typeof state.cookie, "string");
      } else {
        assert.deepEqual(state.body, { message: "Credenciais inválidas" });
      }
    }
  } finally {
    prisma.user.findUnique = originalFindUnique;
  }
});

test("erro interno de login permanece sanitizado", async () => {
  const originalFindUnique = prisma.user.findUnique;
  (prisma.user as any).findUnique = async () => { throw new Error(`database rejected ${fixtureEmail} ${fixturePassword}`); };
  try {
    const { res, state } = response();
    const logs = await captureConsole(() => login({ body: { email: fixtureEmail, password: fixturePassword }, requestId: "req-error" } as any, res as any));
    assert.equal(state.status, 503);
    assert.deepEqual(state.body, { message: "LOGIN_RUNTIME_ERROR" });
    assert.doesNotMatch(logs, /security\.user|Fictitious-password|database rejected/i);
  } finally {
    prisma.user.findUnique = originalFindUnique;
  }
});

test("middleware autenticado mantém negação sem credencial", () => {
  const { res, state } = response();
  let nextCalled = false;
  authMiddleware({ headers: {}, method: "GET", path: "/clients", requestId: "req-rbac" } as any, res as any, (() => { nextCalled = true; }) as any);
  assert.equal(state.status, 401);
  assert.equal(nextCalled, false);
});

test("AST impede reintrodução de diagnósticos e logs de autenticação perigosos", async () => {
  const files = [
    "src/app.ts",
    "src/controllers/authController.ts",
    "src/bootstrap/ensureAdminBootstrap.ts",
    "src/scripts/adminEnsureUser.ts",
    "src/scripts/seedDefaultUsers.ts",
  ];
  const sensitive = /(email|password|passwordhash|hashprefix|hashlength|userid|accesstoken|refreshtoken|authorization|cookie|compare(result)?|passwordmatches)/i;

  for (const relative of files) {
    const sourceText = await readFile(new URL(`../${relative.replace(/^src\//, "")}`, import.meta.url), "utf8");
    const source = ts.createSourceFile(relative, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node)) assert.notEqual(node.text.toLowerCase(), "/debug/admin", `${relative}: rota proibida`);
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        if (relative !== "src/app.ts" && /^(console\.(log|info|warn|error)|logApiEvent)$/.test(callee)) {
          for (const argument of node.arguments) {
            const identifiers: string[] = [];
            const collect = (child: ts.Node) => {
              if (ts.isIdentifier(child) || ts.isPropertyAccessExpression(child)) identifiers.push(child.getText(source));
              ts.forEachChild(child, collect);
            };
            collect(argument);
            assert.equal(identifiers.some((value) => sensitive.test(value)), false, `${relative}: dado sensível em log: ${identifiers.join(", ")}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const appSource = await readFile(new URL("../app.ts", import.meta.url), "utf8");
  assert.match(appSource, /authLoginRateLimit/);
  assert.match(appSource, /authMiddleware|authRoutes/);
});
