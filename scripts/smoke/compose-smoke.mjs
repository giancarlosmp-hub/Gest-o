const baseUrl = process.env.API_BASE_URL || "http://localhost:4000";

const now = new Date();
const month = now.toISOString().slice(0, 7);
const todayIso = now.toISOString();
const tomorrowIso = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
const yesterdayIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
const uniqueTag = `ci-smoke-${Date.now()}`;
const opportunityValue = 12345;
const smokeEmail = process.env.SMOKE_EMAIL || "diretor@empresa.com";
const smokePassword = process.env.SMOKE_PASSWORD || "123456";

const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} on ${path}: ${JSON.stringify(body)}`);
  }

  return body;
};

const assert = (condition, message, details) => {
  if (!condition) {
    const suffix = details ? `\nDetails: ${JSON.stringify(details, null, 2)}` : "";
    throw new Error(`${message}${suffix}`);
  }
};

const main = async () => {
  console.log("[compose-smoke] Login com usuário seed");
  const login = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: smokeEmail, password: smokePassword })
  });
  const token = login?.accessToken;
  assert(Boolean(token), "Falha ao obter access token no login", login);

  const authHeaders = { Authorization: `Bearer ${token}` };

  console.log("[compose-smoke] Buscar vendedor seed");
  const users = await request("/users", { headers: authHeaders });
  const seller = users.find((user) => user.role === "vendedor");
  assert(Boolean(seller?.id), "Nenhum vendedor encontrado no seed", users);

  console.log("[compose-smoke] Buscar cliente do vendedor");
  const clients = await request(`/clients?ownerSellerId=${seller.id}`, { headers: authHeaders });
  const client = Array.isArray(clients) ? clients[0] : clients.items?.[0];
  assert(Boolean(client?.id), "Nenhum cliente encontrado para o vendedor", clients);

  const summaryOpenBefore = await request(`/opportunities/summary?status=open&ownerSellerId=${seller.id}`, { headers: authHeaders });
  const summaryClosedBefore = await request(`/opportunities/summary?status=closed&ownerSellerId=${seller.id}`, { headers: authHeaders });
  const dashboardBefore = await request(`/dashboard/summary?month=${month}&sellerId=${seller.id}`, { headers: authHeaders });

  console.log("[compose-smoke] Criar oportunidade aberta");
  const title = `Smoke Opportunity ${uniqueTag}`;
  const summaryScopedBefore = await request(`/opportunities/summary?status=open&ownerSellerId=${seller.id}&search=${encodeURIComponent(uniqueTag)}`, { headers: authHeaders });
  const created = await request("/opportunities", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      title,
      value: opportunityValue,
      stage: "prospeccao",
      proposalDate: todayIso,
      followUpDate: tomorrowIso,
      expectedCloseDate: tomorrowIso,
      probability: 50,
      clientId: client.id,
      ownerSellerId: seller.id
    })
  });
  assert(Boolean(created?.id), "Falha ao criar oportunidade", created);

  const summaryScopedAfterCreate = await request(`/opportunities/summary?status=open&ownerSellerId=${seller.id}&search=${encodeURIComponent(uniqueTag)}`, { headers: authHeaders });
  assert(summaryScopedAfterCreate.totalCount === summaryScopedBefore.totalCount + 1, "Summary scoped não incluiu a oportunidade criada", { before: summaryScopedBefore, after: summaryScopedAfterCreate, createdId: created.id });
  assert(Number(summaryScopedAfterCreate.pipelineTotalValue || 0) >= opportunityValue, "pipelineTotalValue ausente ou inválido", summaryScopedAfterCreate);
  assert(Number(summaryScopedAfterCreate.weightedValue || 0) > 0, "weightedValue ausente ou inválido", summaryScopedAfterCreate);
  assert(summaryScopedAfterCreate.overdueCount === 0, "Oportunidade recém criada não deveria estar atrasada", summaryScopedAfterCreate);

  console.log("[compose-smoke] Tornar follow-up atrasado e validar summary");
  await request(`/opportunities/${created.id}`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ followUpDate: yesterdayIso })
  });

  const summaryScopedAfterFollowUp = await request(`/opportunities/summary?status=open&ownerSellerId=${seller.id}&search=${encodeURIComponent(uniqueTag)}`, { headers: authHeaders });
  assert(summaryScopedAfterFollowUp.overdueCount === 1, "Summary não refletiu overdueCount após atualizar followUpDate", summaryScopedAfterFollowUp);
  assert(Number(summaryScopedAfterFollowUp.overdueValue || 0) >= opportunityValue, "Summary não refletiu overdueValue após atualizar followUpDate", summaryScopedAfterFollowUp);

  console.log("[compose-smoke] Encerrar oportunidade como ganho");
  await request(`/opportunities/${created.id}/close`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ stage: "ganho", reason: "compose-smoke" })
  });

  const summaryOpenAfterClose = await request(`/opportunities/summary?status=open&ownerSellerId=${seller.id}`, { headers: authHeaders });
  assert(
    summaryOpenAfterClose.totalCount === summaryOpenBefore.totalCount,
    "Summary status=open não voltou ao valor esperado após encerrar como ganho",
    {
      expected: summaryOpenBefore.totalCount,
      actual: summaryOpenAfterClose.totalCount,
      createdId: created.id
    }
  );

  const summaryClosedAfterClose = await request(`/opportunities/summary?status=closed&ownerSellerId=${seller.id}`, { headers: authHeaders });
  assert(
    summaryClosedAfterClose.totalCount === summaryClosedBefore.totalCount + 1,
    "Summary status=closed não incluiu a oportunidade encerrada",
    {
      before: summaryClosedBefore.totalCount,
      after: summaryClosedAfterClose.totalCount,
      createdId: created.id
    }
  );
  const wonBefore = Number(summaryClosedBefore.countByStage?.ganho || 0);
  const wonAfter = Number(summaryClosedAfterClose.countByStage?.ganho || 0);
  assert(
    wonAfter === wonBefore + 1,
    "Summary status=closed não refletiu incremento em ganho",
    { wonBefore, wonAfter, createdId: created.id }
  );

  const dashboardAfter = await request(`/dashboard/summary?month=${month}&sellerId=${seller.id}`, { headers: authHeaders });
  assert(
    dashboardAfter.totalSales === dashboardBefore.totalSales + 1,
    "Dashboard mensal não refletiu o ganho em totalSales",
    {
      before: dashboardBefore.totalSales,
      after: dashboardAfter.totalSales,
      createdId: created.id
    }
  );
  assert(
    Number(dashboardAfter.totalRevenue) >= Number(dashboardBefore.totalRevenue) + opportunityValue,
    "Dashboard mensal não refletiu aumento esperado de receita",
    {
      before: dashboardBefore.totalRevenue,
      after: dashboardAfter.totalRevenue,
      opportunityValue,
      createdId: created.id
    }
  );

  console.log("[compose-smoke] OK - fluxo validado", { createdId: created.id, sellerId: seller.id, clientId: client.id, month });
};

main().catch((error) => {
  console.error("[compose-smoke] FAIL", error);
  process.exit(1);
});
