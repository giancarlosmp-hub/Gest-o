import type { CommunicationChannelType } from "@prisma/client";
const BRAZIL_DDDS = new Set(["11","12","13","14","15","16","17","18","19","21","22","24","27","28","31","32","33","34","35","37","38","41","42","43","44","45","46","47","48","49","51","53","54","55","61","62","63","64","65","66","67","68","69","71","73","74","75","77","79","81","82","83","84","85","86","87","88","89","91","92","93","94","95","96","97","98","99"]);
export interface PhoneNormalizationInput { rawValue: string; defaultCountryCode?: string; channelType: CommunicationChannelType; }
export interface PhoneNormalizationResult { rawValue: string; normalizedValue: string | null; countryCode: string | null; areaCode: string | null; nationalNumber: string | null; contactType: "mobile"|"landline"|"unknown"; valid: boolean; warnings: string[]; }
export class PhoneNormalizationService {
  normalize(input: PhoneNormalizationInput): PhoneNormalizationResult {
    const rawValue = input.rawValue ?? ""; const warnings: string[] = []; let digits = rawValue.replace(/\D/g, "");
    if (!digits) return { rawValue, normalizedValue: null, countryCode: null, areaCode: null, nationalNumber: null, contactType: "unknown", valid: false, warnings: ["empty"] };
    if (digits.startsWith("00")) digits = digits.slice(2);
    const defaultCountryCode = input.defaultCountryCode || "55";
    let countryCode = digits.startsWith(defaultCountryCode) ? defaultCountryCode : (digits.length === 10 || digits.length === 11 ? defaultCountryCode : null);
    let national = countryCode && digits.startsWith(countryCode) ? digits.slice(countryCode.length) : digits;
    if (countryCode !== "55") warnings.push("unsupported_country");
    if (national.length !== 10 && national.length !== 11) warnings.push("invalid_length");
    const areaCode = national.length >= 2 ? national.slice(0,2) : null;
    if (!areaCode || !BRAZIL_DDDS.has(areaCode)) warnings.push("invalid_area_code");
    const subscriber = national.slice(2); let contactType: PhoneNormalizationResult["contactType"] = "unknown";
    if (subscriber.length === 9 && subscriber.startsWith("9")) contactType = "mobile"; else if (subscriber.length === 8) contactType = "landline"; else warnings.push("ambiguous_or_invalid_subscriber");
    const valid = countryCode === "55" && (national.length === 10 || national.length === 11) && !!areaCode && BRAZIL_DDDS.has(areaCode) && contactType !== "unknown";
    return { rawValue, normalizedValue: valid ? `+${countryCode}${national}` : null, countryCode: countryCode ?? null, areaCode, nationalNumber: subscriber || null, contactType, valid, warnings };
  }
}
export class CommunicationContactNormalizationService { constructor(private phones = new PhoneNormalizationService()) {} normalizePhone(input: PhoneNormalizationInput) { return this.phones.normalize(input); } }
