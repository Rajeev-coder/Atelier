-- Migration: 004_payments_ledger_gateways.sql
-- Invariants Enforced:
--  1. Tenant payment configurations with encrypted credentials and webhook secrets.
--  2. Payments state machine tracking (UNPAID -> PENDING -> PAID / FAILED -> REFUNDED).
--  3. Replay-safe deduplication table: UNIQUE(tenant_id, gateway, gateway_event_id).
--  4. Double-Entry, Append-Only Ledger: Database trigger forbids UPDATE and DELETE operations.
--  5. Full Row-Level Security (RLS) forced across all payment and ledger tables.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

-- ============================================================================
-- 1. TENANT PAYMENT CONFIGURATIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_payment_configs (
    tenant_id UUID PRIMARY KEY,
    default_currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    enabled_gateways TEXT[] NOT NULL DEFAULT ARRAY['RAZORPAY'],
    credentials_encrypted JSONB NOT NULL DEFAULT '{}',
    webhook_secret_encrypted TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_tpc_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ============================================================================
-- 2. PAYMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS payments (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    appointment_id UUID NOT NULL,
    gateway VARCHAR(30) NOT NULL CHECK (gateway IN ('STRIPE', 'RAZORPAY', 'OUTLET_CASH', 'OUTLET_UPI')),
    gateway_order_id VARCHAR(255),
    gateway_payment_id VARCHAR(255),
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    status VARCHAR(30) NOT NULL DEFAULT 'UNPAID' CHECK (
        status IN ('UNPAID', 'PENDING', 'AUTHORIZED', 'PARTIAL', 'PAID', 'FAILED', 'REFUNDED')
    ),
    idempotency_key VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT uq_payment_idempotency UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT fk_payment_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_payment_appointment FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments(tenant_id, id) ON DELETE RESTRICT
);

-- ============================================================================
-- 3. PAYMENT EVENTS (DEDUPLICATION STORE)
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_events (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    gateway VARCHAR(30) NOT NULL,
    gateway_event_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT uq_payment_event UNIQUE (tenant_id, gateway, gateway_event_id),
    CONSTRAINT fk_pe_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ============================================================================
-- 4. LEDGER ENTRIES (APPEND-ONLY DOUBLE ENTRY)
-- ============================================================================

CREATE TABLE IF NOT EXISTS ledger_entries (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    appointment_id UUID NOT NULL,
    payment_id UUID,
    entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
    account VARCHAR(50) NOT NULL CHECK (
        account IN ('ACCOUNTS_RECEIVABLE', 'CASH_DRAWER', 'GATEWAY_CLEARING', 'CUSTOMER_REFUNDS', 'SALON_REVENUE')
    ),
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_le_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_le_appointment FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_le_payment FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id) ON DELETE RESTRICT
);

-- ============================================================================
-- 5. IMMUTABLE LEDGER TRIGGER ENFORCEMENT
-- ============================================================================

CREATE OR REPLACE FUNCTION enforce_ledger_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CRITICAL INVARIANT VIOLATION: ledger_entries is strictly append-only. UPDATE and DELETE operations are forbidden.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_ledger_update ON ledger_entries;
CREATE TRIGGER trg_prevent_ledger_update
BEFORE UPDATE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION enforce_ledger_immutability();

DROP TRIGGER IF EXISTS trg_prevent_ledger_delete ON ledger_entries;
CREATE TRIGGER trg_prevent_ledger_delete
BEFORE DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION enforce_ledger_immutability();

-- ============================================================================
-- 6. ROW-LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'tenant_payment_configs',
        'payments',
        'payment_events',
        'ledger_entries'
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

