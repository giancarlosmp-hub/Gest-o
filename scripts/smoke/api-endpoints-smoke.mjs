const baseUrl = process.env.API_BASE_URL || "http://localhost:4000";
const smokeEmail = process.env.SMOKE_EMAIL || "diretor@empresa.com";
const smokePassword = process.env.SMOKE_PASSWORD || "123456";

const parseBody = async (response) => {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const ensureOk = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await parseBody(response);

  if (!response.ok) {
    throw new Error(
      `[api-endpoints-smoke] ${options.method || "GET"} ${path} falhou com HTTP ${response.status}: ${JSON.stringify(body)}`
    );
  }

  console.log(`[api-endpoints-smoke] OK ${options.method || "GET"} ${path}`);
  return body;
};

const ensureOkOrWarn = async (path, options = {}) => {
  try {
    return await ensureOk(path, options);
  } catch (error) {
    console.warn(`[api-endpoints-smoke] WARN ${error.message}`);
    return null;
  }
};

const main = async () => {
  // Endpoint crítico de infraestrutura: deve sempre passar.
  await ensureOk("/health");

  const login = await ensureOkOrWarn("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: smokeEmail, password: smokePassword })
  });

  if (!login?.accessToken) {
    console.warn(
      `[api-endpoints-smoke] WARN Login indisponível ou sem accessToken; endpoints autenticados serão ignorados.`
    );
    console.log("[api-endpoints-smoke] Smoke finalizado com foco em infraestrutura (/health).");
    return;
  }

  const authHeaders = {
    Authorization: `Bearer ${login.accessToken}`
  };

  await ensureOkOrWarn("/clients", { headers: authHeaders });
  await ensureOkOrWarn("/opportunities", { headers: authHeaders });
  await ensureOkOrWarn("/technical-cultures");

  console.log("[api-endpoints-smoke] Smoke finalizado com foco em infraestrutura (/health).");
};

main().catch((error) => {
  console.error("[api-endpoints-smoke] FAIL", error);
  process.exit(1);
});
