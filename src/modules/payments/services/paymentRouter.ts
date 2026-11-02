// src/modules/payments/services/paymentRouter.ts
import {
  GatewayType,
  IPaymentGateway,
  StripeAdapter,
  RazorpayAdapter,
  TenantPaymentConfig,
} from '../adapters/paymentGateway.js';
import { InvariantViolationError } from '../../../shared/errors/index.js';

export class PaymentRouter {
  private static readonly stripe = new StripeAdapter();
  private static readonly razorpay = new RazorpayAdapter();

  /**
   * Dynamically resolves the appropriate payment gateway adapter based on
   * tenant configuration, customer method preference, and transaction currency.
   */
  public static getGateway(
    config: TenantPaymentConfig,
    preferredGateway?: GatewayType,
    currency?: string
  ): IPaymentGateway {
    const targetCurrency = (currency || config.defaultCurrency || 'INR').toUpperCase();

    // 1. If preferred gateway is explicitly requested and enabled by tenant
    if (preferredGateway && config.enabledGateways.includes(preferredGateway)) {
      if (preferredGateway === 'STRIPE') return this.stripe;
      if (preferredGateway === 'RAZORPAY') return this.razorpay;
    }

    // 2. Multi-Currency Intelligent Default Routing:
    // INR transactions route to Razorpay UPI / Cards
    if (targetCurrency === 'INR' && config.enabledGateways.includes('RAZORPAY')) {
      return this.razorpay;
    }

    // USD, EUR, GBP transactions route to Stripe
    if (['USD', 'EUR', 'GBP'].includes(targetCurrency) && config.enabledGateways.includes('STRIPE')) {
      return this.stripe;
    }

    // 3. Fallback to first enabled gateway
    if (config.enabledGateways.includes('RAZORPAY')) {
      return this.razorpay;
    }
    if (config.enabledGateways.includes('STRIPE')) {
      return this.stripe;
    }

    throw new InvariantViolationError(
      `No enabled payment gateway available for tenant: ${config.tenantId} with currency: ${targetCurrency}`
    );
  }
}

