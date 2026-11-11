import { env } from "../../config/env.js";

// Conta Groq para IA de texto. Reaproveita a chave e o endereço da transcrição dos áudios do WhatsApp (mesma conta
// Groq, variáveis que o Compose de produção já repassa): nenhuma variável nova. Não depende de a transcrição estar
// ligada, só de a chave existir. Sem chave (ou sem endereço), null: quem usa fica no provedor de IA do CRM.
// Os limites da Groq são por organização e por modelo: a transcrição (whisper) não divide a cota dos modelos de texto.

export type GroqTextConfig = { baseUrl: string; apiKey: string };

type GroqTextEnv = Pick<typeof env, "whatsappTranscriptionBaseUrl" | "whatsappTranscriptionApiKey">;

export function groqTextConfig(source: GroqTextEnv = env): GroqTextConfig | null {
  const baseUrl = source.whatsappTranscriptionBaseUrl.trim();
  const apiKey = source.whatsappTranscriptionApiKey.trim();
  return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}
