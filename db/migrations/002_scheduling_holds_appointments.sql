-- Migration: 002_scheduling_holds_appointments.sql
-- Invariants Enforced:
--  1. PostgreSQL Range Exclusion Constraints (GiST) with btree_gist on appointments and slot_holds.
--  2. Joint multi-resource exclusion constraint on appointment_resources.
--  3. Half-open intervals '[)' for all tstzrange scheduling.
--  4. Customers partitioned by tenant with UNIQUE(tenant_id, phone_e164).
--  5. Scoped idempotency table with request payload hashing.
--  6. Row-Level Security (RLS) forced across all tables.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ============================================================================
-- 1. CUSTOMERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS customers (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL DEFAULT '',
    phone_e164 VARCHAR(20) NOT NULL,
    email VARCHAR(255),
    consent_whatsapp BOOLEAN NOT NULL DEFAULT FALSE,
    consent_timestamp TIMESTAMPTZ,
    consent_wording_version VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT uq_customer_tenant_phone UNIQUE (tenant_id, phone_e164),
    CONSTRAINT fk_customer_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ============================================================================
-- 2. STAFF BREAKS & TIME-OFF
-- ============================================================================

CREATE TABLE IF NOT EXISTS professional_breaks (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL,
    professional_id UUID NOT NULL,
    day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    CONSTRAINT chk_break_hours CHECK (start_time < end_time),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_pb_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_pb_professional FOREIGN KEY (tenant_id, professional_id) REFERENCES staff_profiles(tenant_id, user_id) ON DELETE CASCADE
);

-- ============================================================================
-- 3. SLOT HOLDS (With GiST Exclusion)
-- ============================================================================

CREATE TABLE IF NOT EXISTS slot_holds (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL,
    service_id UUID NOT NULL,
    professional_id UUID NOT NULL,
    customer_phone_e164 VARCHAR(20) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'RELEASED')),
    created_by_role VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT chk_hold_range CHECK (start_time < end_time),
    CONSTRAINT fk_hold_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_hold_service FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_hold_prof FOREIGN KEY (tenant_id, professional_id) REFERENCES staff_profiles(tenant_id, user_id) ON DELETE CASCADE,
    -- GiST Exclusion: Prevent overlapping active holds for the same professional
    CONSTRAINT exclude_overlapping_holds EXCLUDE USING gist (
        tenant_id WITH =,
        professional_id WITH =,
        tstzrange(start_time, end_time, '[)') WITH &&
    ) WHERE (status = 'ACTIVE')
);

-- ============================================================================
-- 4. APPOINTMENTS (With GiST Exclusion & OCC)
-- ============================================================================

CREATE TABLE IF NOT EXISTS appointments (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL,
    customer_id UUID NOT NULL,
    service_id UUID NOT NULL,
    professional_id UUID NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED' CHECK (
        status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'RESCHEDULED', 'EXPIRED')
    ),
    locked_price_paise BIGINT NOT NULL CHECK (locked_price_paise >= 0),
    idempotency_key VARCHAR(128),
    is_manager_override BOOLEAN NOT NULL DEFAULT FALSE,
    override_reason TEXT,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT chk_appointment_range CHECK (start_time < end_time),
    CONSTRAINT fk_appt_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_appt_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_appt_service FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_appt_prof FOREIGN KEY (tenant_id, professional_id) REFERENCES staff_profiles(tenant_id, user_id) ON DELETE RESTRICT,
    -- GiST Exclusion: Prevent overlapping active appointments for the same professional
    CONSTRAINT exclude_overlapping_appointments EXCLUDE USING gist (
        tenant_id WITH =,
        professional_id WITH =,
        tstzrange(start_time, end_time, '[)') WITH &&
    ) WHERE (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'))
);

-- ============================================================================
-- 5. APPOINTMENT RESOURCES (Joint Resource Exclusion)
-- ============================================================================

CREATE TABLE IF NOT EXISTS appointment_resources (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    appointment_id UUID,
    hold_id UUID,
    resource_id UUID NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('HELD', 'CONFIRMED', 'RELEASED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT chk_app_res_range CHECK (start_time < end_time),
    CONSTRAINT fk_ar_resource FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_ar_appointment FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_ar_hold FOREIGN KEY (tenant_id, hold_id) REFERENCES slot_holds(tenant_id, id) ON DELETE CASCADE,
    -- GiST Exclusion: Prevent concurrent resource double-booking across holds and appointments
    CONSTRAINT exclude_overlapping_resources EXCLUDE USING gist (
        tenant_id WITH =,
        resource_id WITH =,
        tstzrange(start_time, end_time, '[)') WITH &&
    ) WHERE (status IN ('HELD', 'CONFIRMED'))
);

-- ============================================================================
-- 6. IDEMPOTENCY REGISTRY
-- ============================================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
    tenant_id UUID NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status_code INT NOT NULL,
    response_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    PRIMARY KEY (tenant_id, idempotency_key),
    CONSTRAINT fk_ik_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ============================================================================
-- 7. ROW-LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'customers',
        'professional_breaks',
        'slot_holds',
        'appointments',
        'appointment_resources',
        'idempotency_keys'
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

