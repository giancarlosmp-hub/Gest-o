import assert from "node:assert/strict";
import { env } from "../../config/env.js";
import { isWhatsAppTranscriptionEnabled } from "../whatsappConnection/config.js";

// Transcrição dos áudios do WhatsApp: desligada por padrão e só ligada com a gravação das conversas e a chave.
// Chave fictícia.

assert.equal(env.whatsappTranscriptionEnabled, false, "WHATSAPP_TRANSCRIPTION_ENABLED nasce false");
assert.equal(env.whatsappTranscriptionBaseUrl, "https://api.groq.com/openai/v1");
assert.equal(env.whatsappTranscriptionApiKey, "");
assert.equal(env.whatsappTranscriptionModel, "whisper-large-v3");
assert.equal(env.whatsappTranscriptionMaxSeconds, 600);
assert.equal(env.whatsappTranscriptionDailyMaxMinutes, 180);
assert.equal(isWhatsAppTranscriptionEnabled(), false);

env.communicationsEnabled = true;
env.whatsappEvolutionEnabled = true;
env.whatsappEvolutionMessagesEnabled = true;
env.whatsappTranscriptionEnabled = true;
assert.equal(isWhatsAppTranscriptionEnabled(), false, "sem chave continua desligada");
env.whatsappTranscriptionApiKey = "chave-ficticia";
assert.equal(isWhatsAppTranscriptionEnabled(), true);
env.whatsappEvolutionMessagesEnabled = false;
assert.equal(isWhatsAppTranscriptionEnabled(), false, "sem a gravação das conversas não transcreve");

console.log("whatsappTranscriptionConfig.test.ts: ok");
