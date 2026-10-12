// Link do WhatsApp: só prefixa 55 quando o número ainda não vem com o código do país.
// A normalização completa de telefones fica para um PR próprio.
export const buildWhatsAppUrl = (phone: string | null | undefined, text: string) => {
  const digits = String(phone || "").replace(/\D/g, "");
  const encodedText = encodeURIComponent(text);
  if (!digits) return `https://web.whatsapp.com/send?text=${encodedText}`;
  const withCountryCode = digits.startsWith("55") && digits.length >= 12 ? digits : `55${digits}`;
  return `https://wa.me/${withCountryCode}?text=${encodedText}`;
};
