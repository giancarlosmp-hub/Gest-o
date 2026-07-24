import { randomUUID, createHash } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { decryptErpCredential } from "./erpCredentialCrypto.js";
import {
  requestUltraFv3ReadOnlyWithCredentialsRetry,
  pickUltraFv3PartnerCode,
} from "./ultraFv3SyncService.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const normalizeInvestigatedErpCode = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(/^0+(?=\d)/, "");

const toInvestigationArray = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of [
      "data",
      "items",
      "rows",
      "result",
      "results",
      "content",
    ]) {
      const value = (payload as Record<string, unknown>)[key];
      const nested = toInvestigationArray(value);
      if (nested.length) return nested;
    }
  }
  return [];
};

export type ErpPartnerInvestigationReport = Awaited<
  ReturnType<typeof investigateErpPartnerReadOnly>
>;

export async function investigateErpPartnerReadOnly(input: {
  erpCode: unknown;
  correlationId?: string;
}) {
  const target = normalizeInvestigatedErpCode(input.erpCode || "5050");
  if (!target) {
    throw Object.assign(new Error("Informe um ERP Code para investigação."), {
      status: 400,
    });
  }

  const sellers = await prisma.user.findMany({
    where: { role: "vendedor", isActive: true },
    select: {
      id: true,
      erpCode: true,
      erpOperatorCode: true,
      erpLoginUsername: true,
      erpLoginPasswordEncrypted: true,
    },
    orderBy: [{ name: "asc" }],
  });
  const crmMatches = await prisma.client.findMany({
    where: { code: target },
    select: {
      id: true,
      code: true,
      isArchived: true,
      ownerSellerId: true,
      createdAt: true,
      _count: {
        select: {
          opportunities: true,
          timelineEvents: true,
          activities: true,
        },
      },
    },
    orderBy: [{ isArchived: "asc" }, { createdAt: "asc" }],
  });
  const report = {
    mode: "READ_ONLY_SANITIZED",
    erpCodeHash: hash(target),
    targetCodePreservedForOperator: target,
    correlationId: input.correlationId ?? randomUUID(),
    steps: [] as string[],
    sellers: [] as Array<Record<string, unknown>>,
    crm: {
      CRM_MATCH_FOUND: crmMatches.length > 0,
      CRM_MATCH_BY_ERP_CODE: crmMatches.length > 0,
      activeCount: crmMatches.filter((client) => !client.isArchived).length,
      archivedCount: crmMatches.filter((client) => client.isArchived).length,
      ambiguous: crmMatches.length > 1,
      primaryClientIdHash: crmMatches[0]?.id ? hash(crmMatches[0].id) : null,
      ownerCurrentHash: crmMatches[0]?.ownerSellerId
        ? hash(crmMatches[0].ownerSellerId)
        : null,
    },
    uiSearch: {
      getClientsSearchesErpCode: true,
      clientSelectSearchesCodeNameFantasyName: true,
    },
  };

  for (const seller of sellers) {
    const item = {
      userIdHash: hash(seller.id),
      sellerErpCodeHash: seller.erpCode ? hash(seller.erpCode) : null,
      operatorCodeHash: seller.erpOperatorCode
        ? hash(seller.erpOperatorCode)
        : null,
      hasErpLink: Boolean(seller.erpCode),
      hasFv3Login: Boolean(
        seller.erpLoginUsername && seller.erpLoginPasswordEncrypted,
      ),
      credentialDecrypted: false,
      partnersCalled: false,
      ERP_RETURNED: false,
      page: null as number | null,
      codeField: null as string | null,
      NORMALIZED: false,
      WOULD_CREATE: false,
      WOULD_UPDATE: false,
      WOULD_CHANGE_OWNER: false,
      ARCHIVED_MATCH: false,
      AMBIGUOUS_MATCH: false,
      NOT_RETURNED_BY_ERP: false,
      errorReasonCode: null as string | null,
    };
    try {
      if (!seller.erpLoginUsername || !seller.erpLoginPasswordEncrypted) {
        item.errorReasonCode = "AUTH_ERROR";
        report.sellers.push(item);
        continue;
      }
      const password = decryptErpCredential(seller.erpLoginPasswordEncrypted);
      item.credentialDecrypted = true;
      const payload =
        await requestUltraFv3ReadOnlyWithCredentialsRetry<unknown>(
          "/partners",
          { username: seller.erpLoginUsername, password },
          report.correlationId,
        );
      item.partnersCalled = true;
      const rows = toInvestigationArray(payload);
      const found = rows.find(
        (row) =>
          row &&
          typeof row === "object" &&
          pickUltraFv3PartnerCode(row as Record<string, unknown>) === target,
      ) as Record<string, unknown> | undefined;
      if (found) {
        item.ERP_RETURNED = true;
        item.page = 1;
        item.NORMALIZED = pickUltraFv3PartnerCode(found) === target;
        item.codeField =
          Object.keys(found).find(
            (key) => normalizeInvestigatedErpCode(found[key]) === target,
          ) || null;
        item.WOULD_UPDATE = crmMatches.length > 0;
        item.WOULD_CREATE = crmMatches.length === 0;
        item.WOULD_CHANGE_OWNER = Boolean(
          crmMatches[0]?.ownerSellerId &&
          crmMatches[0].ownerSellerId !== seller.id,
        );
        item.ARCHIVED_MATCH = crmMatches.some((client) => client.isArchived);
        item.AMBIGUOUS_MATCH = crmMatches.length > 1;
      } else {
        item.NOT_RETURNED_BY_ERP = true;
      }
    } catch (error) {
      item.errorReasonCode = /auth|login|credencial/i.test(String(error))
        ? "AUTH_ERROR"
        : "ERP_HTTP_ERROR";
    }
    report.sellers.push(item);
  }

  report.steps = report.sellers.some((seller) => seller.ERP_RETURNED)
    ? [
        "ERP_RETURNED",
        "NORMALIZED",
        report.crm.CRM_MATCH_FOUND
          ? "CRM_MATCH_FOUND"
          : "NOT_FOUND_IN_CRM_SEARCH",
      ]
    : ["NOT_RETURNED_BY_ERP"];
  return report;
}
