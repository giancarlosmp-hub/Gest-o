router.get("/clients", async (req, res) => {
  // Aceita os dois padrões de query (novo e antigo) para não quebrar nada:
  // Novo (profissional): q, uf, regiao, tipo, vendedorId, page, pageSize, sort
  // Alternativo (codex): q, state, region, clientType, ownerSellerId
  const search = String(req.query.q ?? "").trim();

  const stateRaw = String(req.query.uf ?? req.query.state ?? "").trim();
  const state = stateRaw ? stateRaw.toUpperCase() : "";

  const region = String(req.query.regiao ?? req.query.region ?? "").trim();

  const clientTypeRaw = String(req.query.tipo ?? req.query.clientType ?? "").trim();
  const parsedClientType = clientTypeRaw.toUpperCase();
  const isValidClientType = parsedClientType === ClientType.PF || parsedClientType === ClientType.PJ;

  const sellerIdFilter = String(
    req.query.vendedorId ??
      req.query.ownerSellerId ??
      req.query.ownerId ??
      ""
  ).trim();

  const page = parsePositiveInt(req.query.page, 1);
  const pageSize = Math.min(parsePositiveInt(req.query.pageSize, 20), 100);
  const orderBy = parseClientSort(String(req.query.sort ?? "").trim() || undefined);

  const where: Prisma.ClientWhereInput = {
    ...sellerWhere(req),
    ...(state ? { state: { equals: state, mode: "insensitive" } } : {}),
    ...(region ? { region: { equals: region, mode: "insensitive" } } : {}),
    ...(isValidClientType ? { clientType: parsedClientType } : {}),
    ...(req.user?.role !== "vendedor" && sellerIdFilter ? { ownerSellerId: sellerIdFilter } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { city: { contains: search, mode: "insensitive" } },
            { state: { contains: search, mode: "insensitive" } },
            { region: { contains: search, mode: "insensitive" } },
            { segment: { contains: search, mode: "insensitive" } }
          ]
        }
      : {})
  };

  // Se não veio nada de "busca/filtros/paginação", mantém compatibilidade (retorna array)
  const hasAdvancedQuery = [
    "q",
    "uf",
    "regiao",
    "tipo",
    "vendedorId",
    "page",
    "pageSize",
    "sort",
    "state",
    "region",
    "clientType",
    "ownerSellerId",
    "ownerId"
  ].some((key) => req.query[key] !== undefined);

  if (!hasAdvancedQuery) {
    const data = await prisma.client.findMany({ where, orderBy });
    return res.json(data);
  }

  const [items, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize
    }),
    prisma.client.count({ where })
  ]);

  return res.json({
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  });
});