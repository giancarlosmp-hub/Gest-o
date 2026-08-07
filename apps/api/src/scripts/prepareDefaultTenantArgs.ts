export type PrepareDefaultTenantArgs = { apply: boolean };

export function parsePrepareDefaultTenantArgs(args: string[]): PrepareDefaultTenantArgs {
  if (args.length !== 1 || (args[0] !== "--dry-run" && args[0] !== "--apply")) {
    throw new Error("usage: prepareDefaultTenant [--dry-run|--apply]");
  }
  return { apply: args[0] === "--apply" };
}
