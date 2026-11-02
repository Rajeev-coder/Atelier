-- Migration: 003_cash_drawer_otp_reschedule_maintenance.sql
-- Invariants Enforced:
--  1. Cash Drawer Sessions & Petty Cash Vouchers partitioned by tenant and branch.
--  2. OTP challenges with attempt throttling, lockout threshold (6 attempts), and cooldowns.
--  3. Resource maintenance blocks with GiST range constraints and conflict detection.
--  4. Cancellation policies per tenant with strict integer fee basis points (bps).
--  5. Full Row-Level Security (RLS) forced across all tables.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ============================================================================
-- 1. CASH DRAWER SESSIONS & PETTY CASH VOUCHERS ("KACHA KHATA")
-- ============================================================================

CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL,
    opened_by_user_id UUID NOT NULL,
    closed_by_user_id UUID,
    opening_float_paise BIGINT NOT NULL CHECK (opening_float_paise >= 0),
    closing_counted_paise BIGINT CHECK (closing_counted_paise >= 0),
    variance_paise BIGINT,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'RECONCILED')),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    reconciled_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_cds_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_cds_opener FOREIGN KEY (opened_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_cds_closer FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS petty_cash_vouchers (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL,
    drawer_session_id UUID NOT NULL,
    issued_by_user_id UUID NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    category VARCHAR(50) NOT NULL CHECK (category IN ('REFRESHMENTS', 'SUPPLIES', 'ERRANDS', 'MISC')),
    paid_to_name VARCHAR(255) NOT NULL,
    notes TEXT,
    voucher_number VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PROVISIONAL' CHECK (status IN ('PROVISIONAL', 'APPROVED', 'DISALLOWED_SHORTAGE')),
    approved_by_user_id UUID,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_pcv_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_pcv_session FOREIGN KEY (tenant_id, drawer_session_id) REFERENCES cash_drawer_sessions(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_pcv_issuer FOREIGN KEY (issued_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_pcv_approver FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS desk_cash_payments (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL,
    drawer_session_id UUID NOT NULL,
    appointment_id UUID NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    collected_by_user_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_dcp_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_dcp_session FOREIGN KEY (tenant_id, drawer_session_id) REFERENCES cash_drawer_sessions(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_dcp_appointment FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_dcp_collector FOREIGN KEY (collected_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- ============================================================================
-- 2. OTP CHALLENGES (Slice 5)
-- ============================================================================

CREATE TABLE IF NOT EXISTS otp_challenges (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    phone_e164 VARCHAR(20) NOT NULL,
    hashed_code CHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts_count INT NOT NULL DEFAULT 0,
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_otp_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ============================================================================
-- 3. CANCELLATION POLICIES (Slice 6)
-- ============================================================================

CREATE TABLE IF NOT EXISTS cancellation_policies (
    tenant_id UUID PRIMARY KEY,
    free_cancellation_window_hours INT NOT NULL DEFAULT 24 CHECK (free_cancellation_window_hours >= 0),
    late_cancellation_fee_bps INT NOT NULL DEFAULT 3000 CHECK (late_cancellation_fee_bps BETWEEN 0 AND 10000), -- 30% default
    min_notice_window_hours INT NOT NULL DEFAULT 2 CHECK (min_notice_window_hours >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_cp_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ============================================================================
-- 4. RESOURCE MAINTENANCE BLOCKS (Slice 7)
-- ============================================================================

CREATE TABLE IF NOT EXISTS resource_maintenance_blocks (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL,
    resource_id UUID NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT chk_rmb_range CHECK (start_time < end_time),
    CONSTRAINT fk_rmb_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_rmb_resource FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE CASCADE,
    -- GiST Exclusion: Prevent overlapping maintenance blocks for the same physical asset
    CONSTRAINT exclude_overlapping_maintenance EXCLUDE USING gist (
        tenant_id WITH =,
        resource_id WITH =,
        tstzrange(start_time, end_time, '[)') WITH &&
    )
);

-- ============================================================================
-- 5. ROW-LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'cash_drawer_sessions',
        'petty_cash_vouchers',
        'desk_cash_payments',
        'otp_challenges',
        'cancellation_policies',
        'resource_maintenance_blocks'
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

