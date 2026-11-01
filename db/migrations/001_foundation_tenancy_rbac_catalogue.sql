-- Migration: 001_foundation_tenancy_rbac_catalogue.sql
-- Invariants Enforced:
--  1. PostgreSQL Row-Level Security (RLS) forced on all tenant-partitioned tables.
--  2. Strict composite foreign keys: (tenant_id, ...) guarantees zero cross-tenant entity linkage.
--  3. Money stored exclusively in integer smallest units (paise).
--  4. Explicit check constraints on durations, prices, times, and day of week.
--  5. Non-blocking migration lock and statement timeouts.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ============================================================================
-- 1. TENANCY & PLATFORM
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(63) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PROVISIONING' CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED')),
    timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    provisioning_key VARCHAR(128) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS branches (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_branch_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ============================================================================
-- 2. USERS, ROLES & SCOPED AUTHORIZATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    phone_e164 VARCHAR(20) NOT NULL,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT
);

INSERT INTO roles (id, name, description) VALUES
    ('PLATFORM_ADMIN', 'Platform Administrator', 'Provisions tenants and monitors platform health'),
    ('OWNER', 'Salon Owner', 'Full control over salon settings, staff, services, and billing'),
    ('BRANCH_MANAGER', 'Branch Manager', 'Manages a specific branch: operations, overrides, local staff'),
    ('RECEPTIONIST', 'Receptionist', 'Front desk: appointments, customer check-in, point-of-sale collections'),
    ('PROFESSIONAL', 'Service Professional', 'Performs services, views personal calendar and schedule')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS role_assignments (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    role_id VARCHAR(50) NOT NULL,
    scope_type VARCHAR(20) NOT NULL CHECK (scope_type IN ('TENANT', 'BRANCH', 'SELF')),
    scope_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT uq_role_assignment UNIQUE (tenant_id, user_id, role_id, scope_type, scope_id),
    CONSTRAINT fk_role_assign_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_role_assign_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_role_assign_role FOREIGN KEY (role_id) REFERENCES roles(id),
    CONSTRAINT fk_role_assign_branch FOREIGN KEY (tenant_id, scope_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE
);

-- Staff Profiles (Encapsulating Tier & Base Compensation)
CREATE TABLE IF NOT EXISTS staff_profiles (
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    tier VARCHAR(50) NOT NULL DEFAULT 'STANDARD',
    base_compensation_paise BIGINT NOT NULL DEFAULT 0 CHECK (base_compensation_paise >= 0),
    commission_rate_bps INT NOT NULL DEFAULT 0 CHECK (commission_rate_bps >= 0 AND commission_rate_bps <= 10000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, user_id),
    CONSTRAINT fk_staff_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_staff_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================================
-- 3. CATALOGUE, RESOURCES & 4-AXIS ELIGIBILITY
-- ============================================================================

CREATE TABLE IF NOT EXISTS services (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    duration_minutes INT NOT NULL CHECK (duration_minutes > 0),
    base_price_paise BIGINT NOT NULL CHECK (base_price_paise >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_service_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resources (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    resource_type VARCHAR(50) NOT NULL CHECK (resource_type IN ('ROOM', 'BED', 'CHAIR', 'EQUIPMENT')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_resource_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS service_resource_requirements (
    tenant_id UUID NOT NULL,
    service_id UUID NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    PRIMARY KEY (tenant_id, service_id, resource_type),
    CONSTRAINT fk_srr_service FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE CASCADE
);

-- Axis 4: Service <-> Professional Eligibility Mapping (Independent of Tier/Price)
CREATE TABLE IF NOT EXISTS service_professional_eligibility (
    tenant_id UUID NOT NULL,
    service_id UUID NOT NULL,
    professional_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, service_id, professional_id),
    CONSTRAINT fk_spe_service FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_spe_professional FOREIGN KEY (tenant_id, professional_id) REFERENCES staff_profiles(tenant_id, user_id) ON DELETE CASCADE
);

-- Axis 3: Professional Service Price Adjustments (Independent of Eligibility/Compensation)
CREATE TABLE IF NOT EXISTS professional_service_prices (
    tenant_id UUID NOT NULL,
    service_id UUID NOT NULL,
    professional_id UUID NOT NULL,
    price_adjustment_paise BIGINT NOT NULL DEFAULT 0 CHECK (price_adjustment_paise >= 0),
    PRIMARY KEY (tenant_id, service_id, professional_id),
    CONSTRAINT fk_psp_service FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_psp_professional FOREIGN KEY (tenant_id, professional_id) REFERENCES staff_profiles(tenant_id, user_id) ON DELETE CASCADE
);

-- Working Hours & Availability Baseline
CREATE TABLE IF NOT EXISTS professional_working_hours (
    tenant_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL,
    professional_id UUID NOT NULL,
    day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    CONSTRAINT chk_valid_hours CHECK (start_time < end_time),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_pwh_branch FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_pwh_professional FOREIGN KEY (tenant_id, professional_id) REFERENCES staff_profiles(tenant_id, user_id) ON DELETE CASCADE
);

-- ============================================================================
-- 4. IMMUTABLE AUDIT LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL,
    actor_id UUID,
    actor_type VARCHAR(50) NOT NULL,
    role VARCHAR(50),
    scope_type VARCHAR(20),
    scope_id UUID,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id VARCHAR(255) NOT NULL,
    diff JSONB,
    ip_address VARCHAR(45),
    outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'ERROR')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Revoke mutation rights on audit log
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM PUBLIC;

-- ============================================================================
-- 5. ROW-LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'branches',
        'role_assignments',
        'staff_profiles',
        'services',
        'resources',
        'service_resource_requirements',
        'service_professional_eligibility',
        'professional_service_prices',
        'professional_working_hours',
        'audit_logs'
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

