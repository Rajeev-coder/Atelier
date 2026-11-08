-- Migration: 005_outlet_messaging_outbox.sql
-- Invariants Enforced:
--  1. Appointment balance fields: deposit_paid_paise, outstanding_balance_paise, payment_status, overpayment_amount_paise.
--  2. Expanded ledger_entries accounts: includes BAD_DEBT_EXPENSE.
--  3. Transactional outbox table with UNIQUE(tenant_id, booking_id, message_type) guaranteeing at-most-once creation.
--  4. WhatsApp template registry with approved variable whitelists.
--  5. Full Row-Level Security (RLS) forced across all new tables.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

-- ============================================================================
-- 1. EXTEND APPOINTMENTS & LEDGER
-- ============================================================================

ALTER TABLE appointments 
    ADD COLUMN IF NOT EXISTS deposit_paid_paise BIGINT NOT NULL DEFAULT 0 CHECK (deposit_paid_paise >= 0),
    ADD COLUMN IF NOT EXISTS outstanding_balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (outstanding_balance_paise >= 0),
    ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'UNPAID' CHECK (
        payment_status IN ('UNPAID', 'PARTIAL', 'PAID', 'OVERPAID')
    ),
    ADD COLUMN IF NOT EXISTS overpayment_amount_paise BIGINT NOT NULL DEFAULT 0 CHECK (overpayment_amount_paise >= 0);

-- Update ledger_entries account check constraint to permit BAD_DEBT_EXPENSE
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_account_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_check CHECK (
    account IN ('ACCOUNTS_RECEIVABLE', 'CASH_DRAWER', 'GATEWAY_CLEARING', 'CUSTOMER_REFUNDS', 'SALON_REVENUE', 'BAD_DEBT_EXPENSE')
);

-- ============================================================================
-- 2. WHATSAPP TEMPLATES REGISTRY
-- ============================================================================

CREATE TABLE IF NOT EXISTS whatsapp_templates (
    tenant_id UUID NOT NULL,
    template_name VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED')),
    body_template TEXT NOT NULL,
    approved_variables TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, template_name),
    CONSTRAINT fk_wt_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ============================================================================
-- 3. TRANSACTIONAL OUTBOX MESSAGES
-- ============================================================================

CREATE TABLE IF NOT EXISTS outbox_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    booking_id UUID NOT NULL,
    message_type VARCHAR(50) NOT NULL CHECK (
        message_type IN ('BOOKING_CONFIRMATION', 'APPOINTMENT_REMINDER', 'CANCELLATION_NOTICE')
    ),
    recipient_phone_e164 VARCHAR(20) NOT NULL,
    template_name VARCHAR(100) NOT NULL,
    template_variables JSONB NOT NULL DEFAULT '{}',
    provider_idempotency_key VARCHAR(128) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED' CHECK (
        status IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SUPPRESSED', 'CANCELLED')
    ),
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    -- Invariant: At-most-once message creation per booking per message type
    CONSTRAINT uq_outbox_booking_type UNIQUE (tenant_id, booking_id, message_type),
    CONSTRAINT fk_om_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_om_booking FOREIGN KEY (tenant_id, booking_id) REFERENCES appointments(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outbox_queue ON outbox_messages (tenant_id, status, scheduled_at)
WHERE status = 'QUEUED';

-- ============================================================================
-- 4. ROW-LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'whatsapp_templates',
        'outbox_messages'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON %I;', t);
        EXECUTE format('
            CREATE POLICY tenant_isolation_policy ON %I
            AS RESTRICTIVE
            USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid);
        ', t);
    END LOOP;
END $$;

