# Meta WhatsApp Cloud API inbound foundation

This integration adds an omnichannel communication domain for inbound Meta WhatsApp Cloud API webhooks. It stores generic conversations, messages and webhook idempotency events, without sending outbound messages, downloading media, running AI, or changing the existing manual WhatsApp assistant.

## Data and LGPD notes
Stored data is limited to normalized contact identifiers, safe display contact, optional contact name, message text when received, media metadata, provider timestamps, status and sanitized processing metadata. Secrets, signatures, raw payloads, temporary media URLs and full webhook bodies are not stored or logged. Access to the administrative status endpoint is limited to director and manager roles.

## Deploy
First deploy with `COMMUNICATIONS_ENABLED=false` and `WHATSAPP_INTEGRATION_ENABLED=false`, run the additive migration, confirm health, configure secrets, set the Meta webhook URL to `/webhooks/communications/meta-whatsapp`, validate the handshake, then enable both flags and test a controlled inbound message.

## Rollback
Disable `WHATSAPP_INTEGRATION_ENABLED`, optionally disable `COMMUNICATIONS_ENABLED`, restart the API, keep tables/data, pause the webhook in Meta, and rotate secrets if needed.

## Future work
Queue-based processing, manual linking, retention/anonymization workflows, opt-in governance, official templates and outbound sending can be added without changing the generic domain.
