const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const httpClass = (status) => Number.isInteger(status) ? `${Math.floor(status / 100)}xx` : "none";
const exactHttpStatus = (status) => {
  if (!Number.isInteger(status)) return "none";
  return String(status);
};
const responseOrigin = (response) => {
  const get = response?.headers?.get?.bind(response.headers);
  if (!get) return "unknown";
  if (get("x-gestao-response-origin") === "api") return "api";
  const server = get("server")?.toLowerCase?.() ?? "";
  return get("cf-ray") || /cloudflare|nginx/.test(server) ? "reverse_proxy" : "unknown";
};

export async function validateAuthenticatedRecovery({
  baseUrl, email, password, attempts = 7, delayMs = 3000, fetchImpl = fetch,
}) {
  let lastPass = "api_health";
  let lastHttpClass = "none";
  let lastHttpStatus = "none";
  let authenticatedRole = "none";
  let httpOrigin = "unknown";
  let routeReached = "NO";
  const recordStatus = (status) => {
    lastHttpClass = httpClass(status);
    lastHttpStatus = exactHttpStatus(status);
  };
  const fail = (category, retryable = false) => ({
    ok: false, category, lastPass, httpClass: lastHttpClass,
    httpStatus: lastHttpStatus, httpOrigin, routeReached, authenticatedRole, retryable,
  });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const login = await fetchImpl(`${baseUrl}/auth/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      recordStatus(login.status);
      if (login.status !== 200) return fail("login_http");
      let loginBody;
      try { loginBody = await login.json(); } catch { return fail("login_schema"); }
      if (typeof loginBody?.accessToken !== "string" || !loginBody.accessToken) return fail("token_contract");
      lastPass = "login";

      const headers = { authorization: `Bearer ${loginBody.accessToken}` };
      const me = await fetchImpl(`${baseUrl}/auth/me`, { headers });
      recordStatus(me.status);
      if (me.status !== 200) return fail("authenticated_identity_http");
      let identity;
      try { identity = await me.json(); } catch { return fail("authenticated_identity_schema"); }
      authenticatedRole = typeof identity?.role === "string" ? identity.role : "none";
      if (!identity || typeof identity !== "object" || !["diretor", "gerente", "vendedor"].includes(authenticatedRole)) {
        return fail("authenticated_identity_schema");
      }
      lastPass = "authenticated_identity";

      // This is the API's dedicated, canonical scheduler-state contract. Keep the
      // same RBAC as the operational ERP routes; the Recovery identity must be
      // diretor or gerente rather than weakening authorization here.
      const status = await fetchImpl(`${baseUrl}/erp/ultrafv3/scheduler/status`, { method: "GET", headers });
      httpOrigin = responseOrigin(status);
      routeReached = status.headers?.get?.("x-gestao-canonical-route") === "erp-scheduler-status-v1" ? "YES" : "NO";
      recordStatus(status.status);
      if (status.status !== 200) return fail("protected_endpoint_http");
      let body;
      try { body = await status.json(); } catch { return fail("protected_endpoint_schema"); }
      if (!body || typeof body !== "object" || !body.automaticSync || typeof body.automaticSync !== "object") return fail("protected_endpoint_schema");
      lastPass = "protected_endpoint";
      const automatic = body.automaticSync;
      const delayed = automatic.initialized !== true || !automatic.nextRunAt;
      if (delayed && attempt < attempts) { await sleep(delayMs); continue; }
      if (automatic.initialized !== true) return fail("scheduler_not_initialized", true);
      lastPass = "scheduler_initialized";
      if (!(automatic.enabled === true && automatic.enabledByEnv === true)) return fail("scheduler_disabled");
      lastPass = "scheduler_enabled";
      if (automatic.configurationOk !== true) return fail("scheduler_configuration");
      lastPass = "scheduler_configuration";
      if (!(automatic.authMode === "global" || automatic.authMode === "seller_reference")) return fail("erp_auth_mode");
      lastPass = "erp_auth_mode";
      if (!automatic.nextRunAt) return fail("next_run_at_absent", true);
      return { ok: true, lastPass: "next_run_at", httpClass: lastHttpClass, httpStatus: lastHttpStatus, httpOrigin, routeReached, authenticatedRole, automatic };
    } catch {
      if (attempt < attempts) { await sleep(delayMs); continue; }
      return fail("transport_timeout", true);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await validateAuthenticatedRecovery({
    baseUrl: process.env.API_BASE, email: process.env.AUTH_TEST_EMAIL,
    password: process.env.AUTH_TEST_PASSWORD,
    attempts: Number(process.env.ERP_AUTH_VALIDATION_ATTEMPTS || 7),
    delayMs: Number(process.env.ERP_AUTH_VALIDATION_DELAY_MS || 3000),
  });
  if (!result.ok) {
    console.log(`FAILURE=${result.category}`);
    console.log(`LAST_PASS=${result.lastPass}`);
    console.log(`HTTP_CLASS=${result.httpClass}`);
    console.log(`HTTP_STATUS=${result.httpStatus}`);
    console.log(`HTTP_ORIGIN=${result.httpOrigin}`);
    console.log(`ROUTE_REACHED=${result.routeReached}`);
    console.log(`AUTHENTICATED_ROLE=${result.authenticatedRole}`);
    process.exitCode = 1;
  } else {
    const a = result.automatic;
    console.log(`LAST_PASS=${result.lastPass}`);
    console.log(`HTTP_CLASS=${result.httpClass}`);
    console.log(`HTTP_STATUS=${result.httpStatus}`);
    console.log(`HTTP_ORIGIN=${result.httpOrigin}`);
    console.log(`ROUTE_REACHED=${result.routeReached}`);
    console.log(`AUTHENTICATED_ROLE=${result.authenticatedRole}`);
    console.log(`INITIALIZED=${a.initialized === true}`);
    console.log(`ENABLED=${a.enabled === true && a.enabledByEnv === true}`);
    console.log(`CONFIG_OK=${a.configurationOk === true}`);
    console.log(`AUTH_MODE=${a.authMode || "none"}`);
    console.log(`NEXT_RUN_AT=${a.nextRunAt || ""}`);
  }
}
