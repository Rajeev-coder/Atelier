// src/modules/messaging/adapters/whatsappAdapter.ts
import { InvariantViolationError } from '../../../shared/errors/index.js';

export interface WhatsAppMessagePayload {
  recipientPhone: string;
  templateName: string;
  variables: Record<string, string>;
  providerIdempotencyKey: string;
}

export interface WhatsAppDeliveryReceipt {
  providerMessageId: string;
  providerIdempotencyKey: string;
  status: 'SENT' | 'DELIVERED';
  isDuplicateDispatch: boolean;
}

export interface IWhatsAppAdapter {
  sendMessage(payload: WhatsAppMessagePayload): Promise<WhatsAppDeliveryReceipt>;
  checkStatus(providerIdempotencyKey: string): Promise<WhatsAppDeliveryReceipt | null>;
}

export class MockWhatsAppAdapter implements IWhatsAppAdapter {
  // Simulates external provider idempotency ledger in memory
  private static readonly providerRegistry = new Map<string, WhatsAppDeliveryReceipt>();
  public static dispatchCount = 0;

  public static reset(): void {
    this.providerRegistry.clear();
    this.dispatchCount = 0;
  }

  public async sendMessage(payload: WhatsAppMessagePayload): Promise<WhatsAppDeliveryReceipt> {
    // 1. Crash-Safety Check: If provider has already processed this exact idempotency key, return cached receipt
    if (MockWhatsAppAdapter.providerRegistry.has(payload.providerIdempotencyKey)) {
      const existing = MockWhatsAppAdapter.providerRegistry.get(payload.providerIdempotencyKey)!;
      return {
        ...existing,
        isDuplicateDispatch: true,
      };
    }

    // 2. Dispatch simulated outbound message
    MockWhatsAppAdapter.dispatchCount++;
    const receipt: WhatsAppDeliveryReceipt = {
      providerMessageId: `wamid_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      providerIdempotencyKey: payload.providerIdempotencyKey,
      status: 'DELIVERED',
      isDuplicateDispatch: false,
    };

    MockWhatsAppAdapter.providerRegistry.set(payload.providerIdempotencyKey, receipt);
    return receipt;
  }

  public async checkStatus(providerIdempotencyKey: string): Promise<WhatsAppDeliveryReceipt | null> {
    return MockWhatsAppAdapter.providerRegistry.get(providerIdempotencyKey) || null;
  }
}

