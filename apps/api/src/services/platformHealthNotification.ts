export type PlatformHealthNotificationChannel = "slack" | "teams" | "email" | "webhook";
export type PlatformHealthNotification = { title: string; message: string; severity: "healthy" | "warning" | "critical"; occurredAt: string; metadata?: Record<string, string | number | boolean | null> };
export interface PlatformHealthNotificationProvider { readonly channel: PlatformHealthNotificationChannel; send(notification: PlatformHealthNotification): Promise<{ accepted: boolean; reason?: string }>; }
/** Registry intentionally starts empty: external delivery requires a separately approved adapter and credentials. */
export class PlatformHealthNotificationRegistry {
  private providers = new Map<PlatformHealthNotificationChannel, PlatformHealthNotificationProvider>();
  register(provider: PlatformHealthNotificationProvider) { this.providers.set(provider.channel, provider); }
  channels() { return [...this.providers.keys()]; }
  async notify(channels: PlatformHealthNotificationChannel[], notification: PlatformHealthNotification) { return Promise.all(channels.map(async channel => ({ channel, ...(this.providers.has(channel) ? await this.providers.get(channel)!.send(notification) : { accepted: false, reason: "provider_not_configured" }) }))); }
}
export const platformHealthNotifications = new PlatformHealthNotificationRegistry();
