# Atelier: Multi-Tenant Salon Operations & Booking Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript: 5.9](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg)](https://www.typescriptlang.org/)
[![Node.js: 22](https://img.shields.io/badge/Node.js-22.x-339933.svg)](https://nodejs.org/)
[![PostgreSQL: 16](https://img.shields.io/badge/PostgreSQL-16-336791.svg)](https://www.postgresql.org/)
[![Tests: 72 Passed](https://img.shields.io/badge/Tests-72%20Passed-brightgreen.svg)](tests/)

**Atelier** is an end-to-end, multi-tenant operations, scheduling, and payment backend built for salons, wellness clinics, and appointment-driven businesses. 

Most booking systems break down in real-world salon environments: stylists get double-booked during walk-in rushes, payments desynchronize when webhooks arrive out of order, front desks struggle with out-of-pocket cash expenses, and client notifications get lost or duplicated during network drops. 

Atelier solves these challenges with **PostgreSQL Row-Level Security (RLS)**, **GiST temporal range exclusion constraints**, **append-only double-entry financial ledgers**, and the **Transactional Outbox pattern**.

---

## What Atelier Solves (The Real-World Problems)

| Challenge in Traditional Booking Systems | How Atelier Solves It |
| :--- | :--- |
| **Stylist & Resource Double-Booking:** Two customers simultaneously book the same stylist or treatment room at 10:00 AM. Naive `SELECT -> IF free -> INSERT` checks fail under race conditions. | **PostgreSQL GiST Range Exclusion (`tstzrange`):** The database engine enforces physical exclusion. Overlapping reservations are rejected at the storage layer (`23P01`), eliminating double-bookings without complex distributed locks. |
| **Multi-Resource Dependencies:** A Balayage treatment requires 1 Stylist + 1 Styling Chair (60m) + 1 Hair Washing Station (30m). Booking just the stylist leads to floor deadlocks. | **Joint Multi-Resource Engine:** The availability engine verifies both staff shifts and required physical assets, including facility maintenance blocks, before issuing a hold. |
| **Data Leaks Across Salons:** Salon A accesses Salon B's client list or services via predictable IDs or missing `WHERE tenant_id` clauses. | **Session-Scoped Row-Level Security (RLS):** Queries execute within isolated transactions setting `SET LOCAL app.tenant_id = $1`. Relational queries missing tenant context return zero rows. |
| **Dual-Write Flaws (Lost/Duplicate WhatsApps):** The database commits an appointment, but the server crashes before sending the WhatsApp confirmation (or vice versa). | **Transactional Outbox Pattern:** Booking inserts and notification events commit in the exact same DB transaction. A background worker drains the outbox with `FOR UPDATE SKIP LOCKED`. |
| **Kacha Khata / Out-of-Pocket Drawer Cash:** Front-desk receptionists buy milk, tea, or cleaning supplies with cash from the drawer, corrupting revenue reporting. | **Cash Drawer Sessions & Petty Cash Vouchers:** Shift custody is decoupled from revenue ledgers. Petty cash vouchers are tracked as provisional expenses reviewed during end-of-shift drawer reconciliation. |
| **Financial Rounding & Modification Leaks:** Float math loses cents/paise over thousands of transactions, and balance records are edited in-place, ruining audit trails. | **Integer-Only Double-Entry Ledgers:** All currency is tracked in integer paise (`BIGINT`). Storage-level triggers block SQL `UPDATE` and `DELETE` on ledgers; adjustments require balanced reversing entries. |

---

## Core Engineering Features

### 1. Hard Multi-Tenancy & Zero-Leak Isolation
* **Session Lifecycle:** Database connection checkout sets `SET LOCAL app.tenant_id = $1` inside an explicit transaction. When the transaction finishes or connection recycles, session variables are wiped, preventing connection pool contamination.
* **Storage-Level RLS:** Tables enforce `FORCE ROW LEVEL SECURITY`. Queries without tenant context evaluate to `NULL`, returning empty sets rather than leaking cross-tenant data.
* **Composite Foreign Keys:** All child foreign keys reference composite `(tenant_id, resource_id)` pairs, preventing cross-tenant resource grafting at the database schema level.
* **Anti-Enumeration Defenses:** Cross-tenant resource probes and non-existent IDs return identical HTTP 404 responses with constant-time latency padding, neutralizing ID harvesting attacks.

### 2. High-Concurrency Scheduling Engine
* **Availability Calculation:** Computes conflict-free 15-minute slot grids by intersecting staff weekly shifts, breaks, approved leaves, active appointments, and unexpired holds.
* **GiST Exclusion Constraints:** Employs PostgreSQL's `btree_gist` extension to enforce overlapping time range exclusion:
  ```sql
  CONSTRAINT no_overlapping_professional_appointments
  EXCLUDE USING gist (
    tenant_id WITH =,
    professional_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'));
  ```
* **Deadlock Prevention:** Multi-resource allocations canonically sort resource UUIDs lexicographically before acquiring locks, preventing circular `40P01` deadlocks during concurrent multi-resource bookings.
* **Atomic Rescheduling:** Releasing the old slot and acquiring the new slot occurs in a single transaction. If the new slot is contested, the transaction rolls back cleanly, and the original booking remains untouched.

### 3. 4-Axis Catalogue & Dynamic Pricing
Most booking systems couple staff seniority to service prices. Atelier decouples the domain into four independent axes:
1. **Staff Experience Tier:** Seniority title (Junior, Senior, Master Stylist).
2. **Service Certification Eligibility:** A many-to-many matrix defining which professionals are certified to perform which services.
3. **Customer Pricing:** Base service prices with optional tier/stylist overrides, calculated server-side.
4. **Staff Compensation:** Internal payroll contracts (base salary, commission basis points, or flat cuts), shielded from front-desk staff via field-level serialization filters.

### 4. Payments, Split Tender & Append-Only Ledgers
* **Integer Currency Units:** Stored as integer **Paise** (`BIGINT` > 0). Floating point types are banned.
* **Multi-Gateway Routing:** Currency-aware routing between Stripe (international cards) and Razorpay (domestic UPI, NetBanking).
* **Late-Payment Reconciler:** If a customer's payment webhook arrives after a 5-minute checkout hold expires:
  * If the slot is still free $\rightarrow$ the appointment is automatically revived and confirmed.
  * If the slot was taken $\rightarrow$ an automated gateway refund is triggered, and a refund ledger entry is posted.
* **Split Tender Checkout:** Allows splitting a single bill across multiple payment methods (e.g., ₹800 Cash + ₹1,200 UPI against a ₹2,000 bill) with floor-remainder preservation so zero paise are lost.
* **Cash Drawer Sessions:** Front desk opens shifts with a declared opening float, tracks provisional vouchers, and reconciles counted cash against expected cash balances at shift end.

### 5. Transactional Outbox Pattern & WhatsApp Dispatches
* **Dual-Write Elimination:** Appointments and customer notifications are written in the same database transaction.
* **Crash-Safe Workers:** Worker instances claim due messages using `SELECT ... FOR UPDATE SKIP LOCKED` to allow horizontal worker scaling without queue contention.
* **Provider Idempotency:** Dispatches use deterministic keys (`${tenant_id}:${booking_id}:${message_type}`). If a worker crashes mid-dispatch, the provider deduplicates on retry.
* **Consent & Opt-Out (STOP):** Inbound opt-outs suppress future WhatsApp dispatches automatically.

---

## Deliberate Non-Goals: What We Intentionally Did Not Build (And Why)

Knowing what **not** to build is just as critical as knowing what to build. We deliberately avoided several common anti-patterns:

### 1. No External Distributed Lock Manager (Redis / Redlock)
* **Why We Avoided It:** Using Redis for 5-minute reservation locks introduces split-brain failure modes and Martin Kleppmann's GC pause lock-expiry hazard (where an application pause causes the lock TTL to expire while the worker is mid-flight, allowing another thread to acquire the lock and write duplicate appointments). Additionally, multi-resource reservations (Stylist + Chair + Sink) create circular distributed deadlocks.
* **What We Did Instead:** We enforce exclusion directly at the ACID database boundary using PostgreSQL `btree_gist` temporal range exclusion constraints (`tstzrange`). Correctness is guaranteed with sub-millisecond serialization latency and zero external lock dependencies.

### 2. No Synchronous External RPCs in Core Request Cycles
* **Why We Avoided It:** Calling third-party APIs (WhatsApp Business API, Twilio, SendGrid) inside the checkout request handler creates dual-write vulnerabilities (DB commits, but HTTP fails; or HTTP succeeds, but DB aborts) and exposes checkout latency to external network blips.
* **What We Did Instead:** Implemented the **Transactional Outbox Pattern**. The notification is committed to `outbox_messages` in the same transaction as the booking, and an asynchronous worker processes it with exponential backoff and provider-level idempotency.

### 3. No In-House Authentication & Password Management
* **Why We Avoided It:** Building custom password hashing, user registration, JWT issuance, and MFA inside a specialized operations engine adds security liabilities and maintenance overhead.
* **What We Did Instead:** Atelier consumes verified `ActorContext` tokens from external identity providers (Auth0, Clerk, or Supabase Auth). Our security layer focuses strictly on **Tenant Isolation**, **Session-Scoped RLS**, **RBAC/ABAC Scopes** (`TENANT`, `BRANCH`, `SELF`), and **Anti-Enumeration 404 Formats**.

### 4. No Client-Side Price or Duration Calculations
* **Why We Avoided It:** Zero-trust architecture. Client payloads cannot be trusted to submit prices or durations.
* **What We Did Instead:** The frontend submits only `serviceId`, `professionalId`, and timestamps. Authoritative pricing, tier overrides, and durations are resolved server-side via the 4-Axis Catalogue Engine within the database transaction.

### 5. No Floating-Point Currency Arithmetic or In-Place Ledger Mutations
* **Why We Avoided It:** Binary float representation accumulates IEEE 754 precision drift over thousands of transactions, and in-place balance updates (`UPDATE balance = balance + x`) permanently destroy audit trails.
* **What We Did Instead:** All money is tracked in integer paise (`BIGINT`). Database triggers physically block SQL `UPDATE` and `DELETE` on `ledger_entries`. Accounting adjustments are made exclusively through immutable reversing entries where $\sum \text{Debits} \equiv \sum \text{Credits}$.

### 6. No Stateful WebSockets for Booking Calendars
* **Why We Avoided It:** Salon bookings happen on human operational tempos (seconds to minutes), not sub-millisecond high-frequency trading. Stateful WebSocket connections introduce connection pool exhaustion, cluster coordination complexity, and memory bloat on mobile networks without solving the underlying slot collision race.
* **What We Did Instead:** Stateless HTTP with fast, indexed range queries, optimistic short-lived slot holds with TTL (`slot_holds`), and deterministic exclusion at commit time.

---

## Tech Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Language & Runtime** | Node.js (v22.x LTS), TypeScript (v5.9) | Strongly typed domain models, branded types (`TenantId`, `Paise`) |
| **Database** | PostgreSQL 16 (with `btree_gist`) | Session-scoped RLS, temporal range types (`tstzrange`), immutability triggers |
| **Connection Pooling** | `pg.Pool` | Connection management with `SET LOCAL app.tenant_id` session guards |
| **Validation** | Zod (v3.25) | Request schema validation & input parsing |
| **Testing** | Vitest (v2.1) | Fast, isolated integration and verification test suite |
| **Containerization** | Docker & Docker Compose | Containerized PostgreSQL 16 environment |

---

## Project Structure

```
├── db/
│   └── migrations/           # Additive-only SQL DDL migrations (001 -> 005)
├── src/
│   ├── modules/
│   │   ├── catalogue/        # 4-Axis service eligibility & price overrides
│   │   ├── customers/        # Customer CRM & E.164 phone normalizer
│   │   ├── messaging/        # Transactional outbox service, WhatsApp adapter & worker
│   │   ├── payments/         # Gateways (Stripe/Razorpay), petty cash & ledger router
│   │   ├── policy/           # Scoped RBAC/ABAC policy engine & privilege escalation guards
│   │   ├── scheduling/       # Availability engine, GiST slot holds & desk booking
│   │   └── tenancy/          # Tenant provisioning & domain resolution
│   └── shared/
│       ├── audit/            # Non-repudiation audit logger
│       ├── database/         # Session-scoped connection client (SET LOCAL)
│       ├── errors/           # Uniform domain errors & constant-time 404 formatter
│       ├── serialization/    # Role-based field sanitization
│       ├── types/            # Branded TypeScript types (TenantId, Paise, UserId)
│       └── utils/            # E.164 phone normalization
├── tests/
│   ├── integration/          # End-to-end slice tests (Slices 1 through 11)
│   └── verification/         # Guardrails (GR-T01..GR-M03), Compound Scenarios (CS-01..CS-08),
│                             # and Unthought Vulnerabilities
└── tools/
    ├── migrate.ts            # Migration execution runner
    └── seed.ts               # Multi-tenant realistic vertical seeder (Gym, Yoga, Salon)
```

---

## Verification & Test Suite

Atelier includes an automated verification test suite verifying tenancy, authorization, GiST concurrency, financial ledger immutability, outbox recovery, and edge-case vulnerabilities:

```bash
# Run the complete test suite
npm test
```

```
 Test Files  8 passed (8)
      Tests  72 passed (72)
   Duration  1.56s
```

### Coverage Highlights:
* **Section 6 Guardrails (GR-T01 to GR-M03):** 22 tests validating RLS session boundaries, uniform anti-enumeration 404s, composite FK rejections, and trigger immutability.
* **Compound Failure Scenarios (CS-01 to CS-08):** 50 concurrent replay webhooks, 3-way race resolution, mid-flight worker crash recovery, and stale hold sweeping.
* **Advanced Edge Cases:** Canonical lexicographical resource lock ordering to prevent `40P01` deadlocks, floor-remainder split tender distribution, and slot hoarding rate limiters.

---

## Getting Started

### Prerequisites
* **Node.js:** v20.x or v22.x
* **PostgreSQL:** 15+ (with `btree_gist` extension) or Docker
* **Package Manager:** npm

### 1. Installation
```bash
npm install
```

### 2. Start PostgreSQL
```bash
docker compose up -d
```

### 3. Run Migrations
```bash
npm run db:migrate
```

### 4. Seed Multi-Tenant Fixture Data
```bash
npm run db:seed
```
Seeds three distinct verticals:
1. `iron-forge-gym` (Fitness / Strength Coaching)
2. `prana-yoga-sanctuary` (Wellness / Yoga Studio)
3. `luxe-salon` (Luxe Salon & Spa)

### 5. Run Tests
```bash
npm test
```

---

## License

This project is licensed under the [MIT License](LICENSE).
