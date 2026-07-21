# Fundação omnichannel segura

Esta PR adiciona somente recebimento inbound oficial do WhatsApp Cloud API por domínio genérico de comunicações. Não há envio outbound, IA, automação, download de mídia, transcrição nem Inbox.

## Implantação segura

Flags padrão: `COMMUNICATIONS_ENABLED=false` e `WHATSAPP_INTEGRATION_ENABLED=false`. Com flags falsas, o boot não exige secrets, não faz chamadas externas e preserva o Assistente WhatsApp manual. Secrets reais devem ficar no mecanismo protegido do ambiente recuperado, nunca no repositório ou Compose.

Rotas: `GET/POST /webhooks/communications/meta-whatsapp` e `GET /communications/integrations/meta-whatsapp/status`.

## Threat model

- Spoofing: POST exige HMAC SHA-256 `X-Hub-Signature-256` sobre raw body antes de parse/persistência.
- Timing attack: formato/tamanho são validados antes de `timingSafeEqual`.
- Payload grande: webhook usa `express.raw` dedicado com 256 KiB.
- JSON malformado: parse ocorre apenas após assinatura válida e retorna 400.
- Replay/concorrência: índices únicos por provider/evento, provider/mensagem e provider/conversa.
- Logs: sem raw body, payload integral, assinatura, token, telefone completo, nome completo ou texto de mensagem.
- Rate abuse: limiter dedicado do webhook, além dos limites gerais.

## LGPD e retenção

Finalidade: registrar eventos mínimos de atendimento oficial e criar Timeline resumida quando houver vínculo inequívoco a cliente ativo. Dados armazenados: IDs externos, hashes, contato normalizado necessário à associação, metadados de mídia sanitizados e texto inbound no domínio de mensagens. Timeline nunca contém conteúdo, telefone, nome completo ou mídia. Conversas sem cliente ficam sem vínculo automático até revisão por perfil autorizado.

Eventos `CommunicationWebhookEvent` devem ser retidos por 30 dias por padrão (`COMMUNICATIONS_WEBHOOK_RETENTION_DAYS`). Operação recomendada pelo responsável de banco, fora do runtime da API:

```sql
DELETE FROM "CommunicationWebhookEvent"
WHERE "createdAt" < now() - interval '30 days'
  AND "status" IN ('PROCESSED','DUPLICATE','FAILED');
```

Rollback operacional: desabilitar `COMMUNICATIONS_ENABLED` e `WHATSAPP_INTEGRATION_ENABLED`. Não apagar tabelas em rollback emergencial.

## Preview deploy

Não alterar firewall, VPS ou workflows para abrir SSH 22022. O bloqueio de preview deve ser resolvido em PR separada com runner interno, Tailscale ou Zero Trust.
