// src/modules/payments/adapters/paymentGateway.ts
import crypto from 'crypto';
import { TenantId, Paise } from '../../../shared/types/index.js';
import { InvariantViolationError, AuthorizationDeniedError } from '../../../shared/errors/index.js';

export type GatewayType = 'STRIPE' | 'RAZORPAY' | 'OUTLET_CASH' | 'OUTLET_UPI';

export type PaymentStatus =
  | 'UNPAID'
  | 'PENDING'
  | 'AUTHORIZED'
  | 'PARTIAL'
  | 'PAID'
  | 'FAILED'
  | 'REFUNDED';

export interface TenantPaymentConfig {
  tenantId: TenantId;
  defaultCurrency: string;
  enabledGateways: GatewayType[];
  credentialsEncrypted: Record<string, string>;
  webhookSecret: string;
}

export interface CreateIntentInput {
  amountPaise: Paise;
  currency: string;
  appointmentId: string;
  customerPhone: string;
}

export interface IntentResult {
  gateway: GatewayType;
  gatewayOrderId: string;
  clientSecret?: string;       // Stripe Elements client secret
  upiIntentString?: string;   // Razorpay UPI Intent Deep Link / QR
}

export interface WebhookEventData {
  gateway: GatewayType;
  eventId: string;
  eventType: string;
  gatewayPaymentId: string;
  gatewayOrderId?: string;
  appointmentId?: string;
  amountPaise: Paise;
  currency: string;
  status: PaymentStatus;
}

export interface RefundResult {
  refundId: string;
  gatewayPaymentId: string;
  amountPaise: Paise;
  status: 'PROCESSED' | 'FAILED';
}

export interface IPaymentGateway {
  readonly gatewayType: GatewayType;
  createIntent(config: TenantPaymentConfig, input: CreateIntentInput): Promise<IntentResult>;
  verifyWebhookSignature(config: TenantPaymentConfig, rawBody: string, signatureHeader: string): Promise<WebhookEventData>;
  fetchStatus(config: TenantPaymentConfig, gatewayPaymentId: string): Promise<PaymentStatus>;
  refund(config: TenantPaymentConfig, gatewayPaymentId: string, amountPaise: Paise, reason: string): Promise<RefundResult>;
}

// ============================================================================
// STRIPE ADAPTER
// ============================================================================

export class StripeAdapter implements IPaymentGateway {
  public readonly gatewayType: GatewayType = 'STRIPE';

  public async createIntent(config: TenantPaymentConfig, input: CreateIntentInput): Promise<IntentResult> {
    const orderId = `pi_${crypto.randomBytes(12).toString('hex')}`;
    const clientSecret = `${orderId}_secret_${crypto.randomBytes(12).toString('hex')}`;

    return {
      gateway: 'STRIPE',
      gatewayOrderId: orderId,
      clientSecret,
    };
  }

  public async verifyWebhookSignature(
    config: TenantPaymentConfig,
    rawBody: string,
    signatureHeader: string
  ): Promise<WebhookEventData> {
    // In production: Stripe.webhooks.constructEvent(rawBody, signatureHeader, secret)
    // Deterministic HMAC verification against tenant webhook secret
    const expectedSig = crypto
      .createHmac('sha256', config.webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (signatureHeader !== expectedSig && !signatureHeader.includes(expectedSig)) {
      throw new AuthorizationDeniedError('webhook:stripe', 'Invalid Stripe webhook signature.');
    }

    const parsed = JSON.parse(rawBody);
    const intent = parsed.data?.object || parsed;

    let status: PaymentStatus = 'PENDING';
    if (parsed.type === 'payment_intent.succeeded') {
      status = 'PAID';
    } else if (parsed.type === 'payment_intent.payment_failed') {
      status = 'FAILED';
    } else if (parsed.type === 'charge.refunded') {
      status = 'REFUNDED';
    }

    return {
      gateway: 'STRIPE',
      eventId: parsed.id || `evt_stripe_${Date.now()}`,
      eventType: parsed.type,
      gatewayPaymentId: intent.id || intent.payment_id || `py_stripe_${Date.now()}`,
      gatewayOrderId: intent.id,
      appointmentId: intent.metadata?.appointmentId,
      amountPaise: BigInt(intent.amount || 0) as Paise,
      currency: (intent.currency || 'USD').toUpperCase(),
      status,
    };
  }

  public async fetchStatus(_config: TenantPaymentConfig, _gatewayPaymentId: string): Promise<PaymentStatus> {
    return 'PAID';
  }

  public async refund(
    _config: TenantPaymentConfig,
    gatewayPaymentId: string,
    amountPaise: Paise,
    _reason: string
  ): Promise<RefundResult> {
    return {
      refundId: `re_${crypto.randomBytes(12).toString('hex')}`,
      gatewayPaymentId,
      amountPaise,
      status: 'PROCESSED',
    };
  }
}

// ============================================================================
// RAZORPAY / UPI ADAPTER
// ============================================================================

export class RazorpayAdapter implements IPaymentGateway {
  public readonly gatewayType: GatewayType = 'RAZORPAY';

  public async createIntent(config: TenantPaymentConfig, input: CreateIntentInput): Promise<IntentResult> {
    const orderId = `order_${crypto.randomBytes(10).toString('hex')}`;
    const amountInRupees = (Number(input.amountPaise) / 100).toFixed(2);
    const upiIntentString = `upi://pay?pa=service.payments@okhdfcbank&pn=ServicePlatform&am=${amountInRupees}&cu=INR&tr=${orderId}`;

    return {
      gateway: 'RAZORPAY',
      gatewayOrderId: orderId,
      upiIntentString,
    };
  }

  public async verifyWebhookSignature(
    config: TenantPaymentConfig,
    rawBody: string,
    signatureHeader: string
  ): Promise<WebhookEventData> {
    // In production: crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    const expectedSig = crypto
      .createHmac('sha256', config.webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (signatureHeader !== expectedSig && !signatureHeader.includes(expectedSig)) {
      throw new AuthorizationDeniedError('webhook:razorpay', 'Invalid Razorpay webhook signature.');
    }

    const parsed = JSON.parse(rawBody);
    const payment = parsed.payload?.payment?.entity || parsed;

    let status: PaymentStatus = 'PENDING';
    if (parsed.event === 'order.paid' || parsed.event === 'payment.captured') {
      status = 'PAID';
    } else if (parsed.event === 'payment.failed') {
      status = 'FAILED';
    } else if (parsed.event === 'refund.processed') {
      status = 'REFUNDED';
    }

    return {
      gateway: 'RAZORPAY',
      eventId: parsed.id || `evt_rzp_${Date.now()}`,
      eventType: parsed.event,
      gatewayPaymentId: payment.id || `pay_${crypto.randomBytes(8).toString('hex')}`,
      gatewayOrderId: payment.order_id,
      appointmentId: payment.notes?.appointmentId,
      amountPaise: BigInt(payment.amount || 0) as Paise,
      currency: (payment.currency || 'INR').toUpperCase(),
      status,
    };
  }

  public async fetchStatus(_config: TenantPaymentConfig, _gatewayPaymentId: string): Promise<PaymentStatus> {
    return 'PAID';
  }

  public async refund(
    _config: TenantPaymentConfig,
    gatewayPaymentId: string,
    amountPaise: Paise,
    _reason: string
  ): Promise<RefundResult> {
    return {
      refundId: `rfnd_${crypto.randomBytes(10).toString('hex')}`,
      gatewayPaymentId,
      amountPaise,
      status: 'PROCESSED',
    };
  }
}

