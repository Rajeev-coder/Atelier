// src/modules/messaging/workers/messagingOutboxWorker.ts
import pg from 'pg';
import { TenantId } from '../../../shared/types/index.js';
import { IWhatsAppAdapter, MockWhatsAppAdapter } from '../adapters/whatsappAdapter.js';
import { AuditLogger } from '../../../shared/audit/auditLogger.js';

export interface WorkerBatchResult {
  claimedCount: number;
  sentCount: number;
  suppressedCount: number;
  failedCount: number;
}

export class MessagingOutboxWorker {
  private readonly adapter: IWhatsAppAdapter;

  constructor(adapter?: IWhatsAppAdapter) {
    this.adapter = adapter || new MockWhatsAppAdapter();
  }

  /**
   * Claims and dispatches due outbox messages using PostgreSQL FOR UPDATE SKIP LOCKED.
   * Guarantees crash resilience, template validation, and STOP opt-out suppression.
   */
  public async processBatch(
    client: pg.PoolClient,
    tenantId: TenantId,
    batchSize = 10
  ): Promise<WorkerBatchResult> {
    // 1. Claim pending due messages atomically using FOR UPDATE SKIP LOCKED
    const claimRes = await client.query<{
      id: string;
      booking_id: string;
      message_type: string;
      recipient_phone_e164: string;
      template_name: string;
      template_variables: Record<string, string>;
      provider_idempotency_key: string;
      attempts: number;
    }>(
      `SELECT id, booking_id, message_type, recipient_phone_e164, template_name, template_variables, provider_idempotency_key, attempts
       FROM outbox_messages
       WHERE tenant_id = $1 AND status = 'QUEUED' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED;`,
      [tenantId, batchSize]
    );

    let sentCount = 0;
    let suppressedCount = 0;
    let failedCount = 0;

    for (const msg of claimRes.rows) {
      // 2. Consent Check: Inspect customer's current consent_whatsapp state
      const custRes = await client.query<{ consent_whatsapp: boolean }>(
        'SELECT consent_whatsapp FROM customers WHERE tenant_id = $1 AND phone_e164 = $2;',
        [tenantId, msg.recipient_phone_e164]
      );

      const hasConsent = custRes.rows[0]?.consent_whatsapp ?? false;

      if (!hasConsent) {
        // Customer has revoked consent via STOP -> Suppress message and bypass provider
        await client.query(
          "UPDATE outbox_messages SET status = 'SUPPRESSED', last_error = 'Customer opted out via STOP', updated_at = NOW() WHERE tenant_id = $1 AND id = $2;",
          [tenantId, msg.id]
        );
        suppressedCount++;
        continue;
      }

      // 3. Template Validation: Template must be APPROVED and have all variables resolved
      const templateRes = await client.query<{
        status: string;
        body_template: string;
        approved_variables: string[];
      }>(
        'SELECT status, body_template, approved_variables FROM whatsapp_templates WHERE tenant_id = $1 AND template_name = $2;',
        [tenantId, msg.template_name]
      );

      if (templateRes.rows.length === 0 || templateRes.rows[0].status !== 'APPROVED') {
        await client.query(
          "UPDATE outbox_messages SET status = 'FAILED', last_error = 'Template not approved or missing' WHERE tenant_id = $1 AND id = $2;",
          [tenantId, msg.id]
        );
        failedCount++;
        continue;
      }

      // Check unresolved placeholders in template
      const templateBody = templateRes.rows[0].body_template;
      const placeholderRegex = /\{\{([^}]+)\}\}/g;
      let match;
      let hasUnresolvedVar = false;

      while ((match = placeholderRegex.exec(templateBody)) !== null) {
        const varName = match[1].trim();
        if (!msg.template_variables[varName]) {
          hasUnresolvedVar = true;
          break;
        }
      }

      if (hasUnresolvedVar) {
        await client.query(
          "UPDATE outbox_messages SET status = 'FAILED', last_error = 'Unresolved template placeholder variables' WHERE tenant_id = $1 AND id = $2;",
          [tenantId, msg.id]
        );
        failedCount++;
        continue;
      }

      // 4. Crash Recovery Invariant: Check if provider already received this idempotency key
      const existingStatus = await this.adapter.checkStatus(msg.provider_idempotency_key);
      if (existingStatus) {
        // Provider already processed earlier -> mark SENT without duplicate external dispatch
        await client.query(
          "UPDATE outbox_messages SET status = 'SENT', sent_at = NOW() WHERE tenant_id = $1 AND id = $2;",
          [tenantId, msg.id]
        );
        sentCount++;
        continue;
      }

      // 5. Send through WhatsApp Gateway Adapter
      try {
        const receipt = await this.adapter.sendMessage({
          recipientPhone: msg.recipient_phone_e164,
          templateName: msg.template_name,
          variables: msg.template_variables,
          providerIdempotencyKey: msg.provider_idempotency_key,
        });

        // 6. Update Outbox Record to SENT
        await client.query(
          "UPDATE outbox_messages SET status = 'SENT', sent_at = NOW(), attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2;",
          [tenantId, msg.id]
        );

        // 7. Write Audit Log
        await AuditLogger.log(client, {
          tenantId,
          actorId: null,
          actorType: 'SYSTEM',
          action: 'messaging:outbox_sent',
          resourceType: 'outbox_messages',
          resourceId: msg.id,
          diff: {
            messageType: msg.message_type,
            recipient: msg.recipient_phone_e164,
            providerReceipt: receipt.providerMessageId,
          },
          outcome: 'SUCCESS',
        });

        sentCount++;
      } catch (err: any) {
        await client.query(
          "UPDATE outbox_messages SET status = 'FAILED', attempts = attempts + 1, last_error = $1 WHERE tenant_id = $2 AND id = $3;",
          [err.message || 'Dispatch error', tenantId, msg.id]
        );
        failedCount++;
      }
    }

    return {
      claimedCount: claimRes.rows.length,
      sentCount,
      suppressedCount,
      failedCount,
    };
  }
}

