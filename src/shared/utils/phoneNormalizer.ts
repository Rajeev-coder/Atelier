// src/shared/utils/phoneNormalizer.ts
import { InvariantViolationError } from '../errors/index.js';

export class PhoneNormalizer {
  /**
   * Normalizes arbitrary user-supplied phone formats to strictly validated E.164.
   * Default country code is +91 (India) if standard 10-digit format is supplied.
   */
  public static normalizeE164(input: string, defaultCountryCode = '+91'): string {
    if (!input || typeof input !== 'string') {
      throw new InvariantViolationError('Phone number is required.');
    }

    // Strip whitespace, dashes, parentheses, dots
    let cleaned = input.replace(/[\s\-\(\)\.]/g, '');

    // Handle leading 00 as international +
    if (cleaned.startsWith('00')) {
      cleaned = '+' + cleaned.substring(2);
    }

    // Handle leading 0 for national numbers (e.g. 09800000001 -> 9800000001)
    if (cleaned.startsWith('0') && !cleaned.startsWith('+')) {
      cleaned = cleaned.substring(1);
    }

    // Prepend default country code if missing leading +
    if (!cleaned.startsWith('+')) {
      // National mobile numbers require at least 10 digits before prepending default country code
      if (cleaned.length < 10) {
        throw new InvariantViolationError(
          `Invalid phone number: "${input}". Local numbers require at least 10 digits.`
        );
      }
      const code = defaultCountryCode.startsWith('+') ? defaultCountryCode : `+${defaultCountryCode}`;
      cleaned = `${code}${cleaned}`;
    }

    // Strict E.164 Regex validation: '+' followed by 7 to 15 digits
    const e164Regex = /^\+[1-9]\d{9,14}$/;
    if (!e164Regex.test(cleaned)) {
      throw new InvariantViolationError(`Invalid phone number format: "${input}". Must conform to E.164 standard.`);
    }

    return cleaned;
  }
}
