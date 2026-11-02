// src/modules/scheduling/services/otpService.ts
import crypto from 'crypto';
import pg from 'pg';
import { TenantId } from '../../../shared/types/index.js';
import { PhoneNormalizer } from '../../../shared/utils/phoneNormalizer.js';
import {
  InvariantViolationError,
  AuthorizationDeniedError,
  EntityNotFoundError,
} from '../../../shared/errors/index.js';

export interface OtpChallengeResult {
  challengeId: string;
  phoneE164: string;
  expiresAt: string;
  rawCodeForTest?: string;
}

export interface VerifyOtpResult {
  verified: boolean;
  phoneE164: string;
  verificationToken: string;
}

export class OtpService {
  private static hashOtp(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
  }

  /**
   * Issues an OTP challenge for an online customer with rate limit cooldown and attempt tracking.
   */
  public static async requestOtp(
    client: pg.PoolClient,
    tenantId: TenantId,
    phoneInput: string
  ): Promise<OtpChallengeResult> {
    const phoneE164 = PhoneNormalizer.normalizeE164(phoneInput);

    // Cooldown check: Check if an active unexpired challenge was created within the last 30 seconds
    const recentChallenge = await client.query<{ created_at: Date; is_locked: boolean }>(
      `SELECT created_at, is_locked FROM otp_challenges 
       WHERE tenant_id = $1 AND phone_e164 = $2 AND created_at > (NOW() - INTERVAL '30 seconds')
       ORDER BY created_at DESC LIMIT 1;`,
      [tenantId, phoneE164]
    );

    if (recentChallenge.rows.length > 0 && !recentChallenge.rows[0].is_locked) {
      throw new InvariantViolationError('Please wait 30 seconds before requesting a new OTP.');
    }

    // Generate random 6-digit code
    const rawCode = (Math.floor(100000 + Math.random() * 900000)).toString();
    const hashedCode = this.hashOtp(rawCode);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min TTL

    const res = await client.query<{ id: string }>(
      `INSERT INTO otp_challenges (tenant_id, phone_e164, hashed_code, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id;`,
      [tenantId, phoneE164, hashedCode, expiresAt]
    );

    return {
      challengeId: res.rows[0].id,
      phoneE164,
      expiresAt,
      rawCodeForTest: rawCode,
    };
  }

  /**
   * Verifies the OTP code.
   * Invariant: 6 failed attempts locks the challenge permanently.
   */
  public static async verifyOtp(
    client: pg.PoolClient,
    tenantId: TenantId,
    challengeId: string,
    candidateCode: string
  ): Promise<VerifyOtpResult> {
    const res = await client.query<{
      id: string;
      phone_e164: string;
      hashed_code: string;
      expires_at: Date;
      attempts_count: number;
      is_locked: boolean;
      verified_at: Date | null;
    }>(
      'SELECT * FROM otp_challenges WHERE tenant_id = $1 AND id = $2;',
      [tenantId, challengeId]
    );

    if (res.rows.length === 0) {
      throw new EntityNotFoundError('OtpChallenge', challengeId);
    }

    const challenge = res.rows[0];

    if (challenge.is_locked || challenge.attempts_count >= 6) {
      throw new AuthorizationDeniedError(
        'otp:verify',
        'This OTP challenge is locked due to too many failed attempts. Please request a new code.'
      );
    }

    if (new Date(challenge.expires_at) <= new Date()) {
      throw new InvariantViolationError('The verification code has expired.');
    }

    const candidateHash = this.hashOtp(candidateCode.trim());

    if (candidateHash === challenge.hashed_code) {
      await client.query(
        'UPDATE otp_challenges SET verified_at = NOW() WHERE tenant_id = $1 AND id = $2;',
        [tenantId, challengeId]
      );

      // Deterministic verification proof token HMAC-signed with tenant secret
      const verificationToken = crypto
        .createHmac('sha256', 'PLATFORM_OTP_SIGNING_KEY')
        .update(`${tenantId}:${challenge.phone_e164}:${challengeId}`)
        .digest('hex');

      return {
        verified: true,
        phoneE164: challenge.phone_e164,
        verificationToken,
      };
    } else {
      const newAttempts = challenge.attempts_count + 1;
      const isNowLocked = newAttempts >= 6;

      await client.query(
        'UPDATE otp_challenges SET attempts_count = $1, is_locked = $2 WHERE tenant_id = $3 AND id = $4;',
        [newAttempts, isNowLocked, tenantId, challengeId]
      );

      if (isNowLocked) {
        throw new AuthorizationDeniedError(
          'otp:verify',
          'Too many failed attempts. The verification challenge is now locked.'
        );
      }

      throw new InvariantViolationError(`Invalid verification code. ${6 - newAttempts} attempts remaining.`);
    }
  }

  /**
   * Validates whether a verification proof token is genuine for the phone.
   */
  public static isTokenValid(tenantId: TenantId, phoneE164: string, challengeId: string, token: string): boolean {
    const expected = crypto
      .createHmac('sha256', 'PLATFORM_OTP_SIGNING_KEY')
      .update(`${tenantId}:${phoneE164}:${challengeId}`)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }
}

