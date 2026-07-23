import { CommunicationChannelType, CommunicationProviderType, Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { logApiEvent } from "../../utils/logger.js";
import { hashContact } from "./phoneNormalization.js";

export type CommunicationTenantResolution = {
  tenantId: string;
  integrationAccountId: string;
  status: "active";
};

export class CommunicationTenantResolver {
  constructor(private readonly prisma = defaultPrisma) {}

  async resolve(params: {
    provider: CommunicationProviderType;
    channel: CommunicationChannelType;
    externalAccountId: string;
  }): Promise<CommunicationTenantResolution | { status: "unknown" | "disabled"; reason: string }> {
    const account = await this.prisma.communicationIntegrationAccount.findFirst({
      where: {
        provider: params.provider,
        channel: params.channel,
        externalAccountId: params.externalAccountId,
      },
      select: { id: true, tenantId: true, enabled: true, status: true, configurationState: true },
      orderBy: { createdAt: "asc" },
    });

    if (!account) {
      logApiEvent("WARN", "[communications] integration account not found", {
        provider: params.provider,
        channel: params.channel,
        externalAccountHash: hashContact(params.externalAccountId),
      });
      return { status: "unknown", reason: "integration_account_not_found" };
    }
    if (!account.enabled || account.status === "disabled") {
      logApiEvent("WARN", "[communications] integration account disabled", {
        provider: params.provider,
        channel: params.channel,
        integrationAccountId: account.id,
      });
      return { status: "disabled", reason: "integration_account_disabled" };
    }
    return { status: "active", tenantId: account.tenantId, integrationAccountId: account.id };
  }
}

export const communicationTenantResolver = new CommunicationTenantResolver();
