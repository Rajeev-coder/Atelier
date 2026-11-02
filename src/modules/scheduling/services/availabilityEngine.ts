// src/modules/scheduling/services/availabilityEngine.ts
import pg from 'pg';
import { TenantId, BranchId, ServiceId, UserId } from '../../../shared/types/index.js';
import { EntityNotFoundError } from '../../../shared/errors/index.js';

export interface AvailableSlot {
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  professionalId: string;
  professionalName: string;
  assignedResourceIds: string[];
}

export interface QueryAvailabilityInput {
  tenantId: TenantId;
  branchId: BranchId;
  serviceId: ServiceId;
  date: string; // YYYY-MM-DD
  professionalId?: UserId;
  slotIntervalMinutes?: number; // default: 15
}

interface WorkingShift {
  professionalId: string;
  professionalName: string;
  dayOfWeek: number;
  startTime: string; // HH:mm:ss
  endTime: string;   // HH:mm:ss
}

interface TimeRange {
  start: Date;
  end: Date;
}

export class AvailabilityEngine {
  /**
   * Computes strictly conflict-free slots across staff shifts, breaks, appointments,
   * active unexpired holds, and multi-resource requirements.
   */
  public static async computeAvailableSlots(
    client: pg.PoolClient,
    input: QueryAvailabilityInput
  ): Promise<AvailableSlot[]> {
    const { tenantId, branchId, serviceId, date, slotIntervalMinutes = 15 } = input;

    // 1. Fetch Service Details & Duration
    const serviceRes = await client.query<{ duration_minutes: number; is_active: boolean }>(
      'SELECT duration_minutes, is_active FROM services WHERE tenant_id = $1 AND id = $2;',
      [tenantId, serviceId]
    );

    if (serviceRes.rows.length === 0 || !serviceRes.rows[0].is_active) {
      throw new EntityNotFoundError('Service', serviceId);
    }
    const durationMinutes = serviceRes.rows[0].duration_minutes;

    // 2. Fetch Required Resource Types for this Service
    const reqRes = await client.query<{ resource_type: string; quantity: number }>(
      'SELECT resource_type, quantity FROM service_resource_requirements WHERE tenant_id = $1 AND service_id = $2;',
      [tenantId, serviceId]
    );
    const requiredResources = reqRes.rows;

    // 3. Resolve Target Day of Week (0 = Sunday, 6 = Saturday)
    const targetDate = new Date(`${date}T00:00:00Z`);
    const dayOfWeek = targetDate.getUTCDay();

    // 4. Query Eligible Professionals for this Service
    let profQuery = `
      SELECT 
        pwh.professional_id as "professionalId",
        u.name as "professionalName",
        pwh.day_of_week as "dayOfWeek",
        pwh.start_time as "startTime",
        pwh.end_time as "endTime"
      FROM professional_working_hours pwh
      JOIN service_professional_eligibility spe 
        ON spe.tenant_id = pwh.tenant_id 
       AND spe.professional_id = pwh.professional_id 
       AND spe.service_id = $2
      JOIN users u ON u.id = pwh.professional_id
      WHERE pwh.tenant_id = $1 
        AND pwh.branch_id = $3 
        AND pwh.day_of_week = $4
    `;
    const profParams: unknown[] = [tenantId, serviceId, branchId, dayOfWeek];

    if (input.professionalId) {
      profQuery += ' AND pwh.professional_id = $5';
      profParams.push(input.professionalId);
    }

    const shiftsRes = await client.query<WorkingShift>(profQuery, profParams);
    if (shiftsRes.rows.length === 0) {
      return [];
    }

    // 5. Query All Branch Resources Matching Required Types
    const branchResourcesRes = await client.query<{ id: string; resource_type: string }>(
      `SELECT id, resource_type 
       FROM resources 
       WHERE tenant_id = $1 AND branch_id = $2 AND is_active = TRUE;`,
      [tenantId, branchId]
    );
    const branchResources = branchResourcesRes.rows;

    // 6. Query Existing Busy Windows for Resources on the Target Date (Appointments, Holds & Maintenance Blocks)
    const dayStart = new Date(`${date}T00:00:00Z`);
    const dayEnd = new Date(`${date}T23:59:59Z`);

    const busyResourcesRes = await client.query<{ resource_id: string; start_time: Date; end_time: Date }>(
      `SELECT resource_id, start_time, end_time
       FROM appointment_resources
       WHERE tenant_id = $1 
         AND status IN ('HELD', 'CONFIRMED')
         AND tstzrange(start_time, end_time, '[)') && tstzrange($2, $3, '[)')
       UNION ALL
       SELECT resource_id, start_time, end_time
       FROM resource_maintenance_blocks
       WHERE tenant_id = $1
         AND tstzrange(start_time, end_time, '[)') && tstzrange($2, $3, '[)');`,
      [tenantId, dayStart.toISOString(), dayEnd.toISOString()]
    );

    // Group busy ranges by resourceId
    const busyResourceMap = new Map<string, TimeRange[]>();
    for (const r of busyResourcesRes.rows) {
      const list = busyResourceMap.get(r.resource_id) || [];
      list.push({ start: new Date(r.start_time), end: new Date(r.end_time) });
      busyResourceMap.set(r.resource_id, list);
    }

    const availableSlots: AvailableSlot[] = [];

    // 7. Evaluate Slots for Each Eligible Professional
    for (const shift of shiftsRes.rows) {
      // Query Breaks for Professional on this day
      const breaksRes = await client.query<{ start_time: string; end_time: string }>(
        `SELECT start_time, end_time 
         FROM professional_breaks 
         WHERE tenant_id = $1 AND branch_id = $2 AND professional_id = $3 AND day_of_week = $4;`,
        [tenantId, branchId, shift.professionalId, dayOfWeek]
      );
      const breaks: TimeRange[] = breaksRes.rows.map((b) => ({
        start: new Date(`${date}T${b.start_time}Z`),
        end: new Date(`${date}T${b.end_time}Z`),
      }));

      // Query Confirmed Appointments for Professional
      const apptsRes = await client.query<{ start_time: Date; end_time: Date }>(
        `SELECT start_time, end_time
         FROM appointments
         WHERE tenant_id = $1 
           AND professional_id = $2 
           AND status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN')
           AND tstzrange(start_time, end_time, '[)') && tstzrange($3, $4, '[)');`,
        [tenantId, shift.professionalId, dayStart.toISOString(), dayEnd.toISOString()]
      );
      const appts: TimeRange[] = apptsRes.rows.map((a) => ({
        start: new Date(a.start_time),
        end: new Date(a.end_time),
      }));

      // Query Active Unexpired Slot Holds for Professional
      const holdsRes = await client.query<{ start_time: Date; end_time: Date }>(
        `SELECT start_time, end_time
         FROM slot_holds
         WHERE tenant_id = $1
           AND professional_id = $2
           AND status = 'ACTIVE'
           AND expires_at > NOW()
           AND tstzrange(start_time, end_time, '[)') && tstzrange($3, $4, '[)');`,
        [tenantId, shift.professionalId, dayStart.toISOString(), dayEnd.toISOString()]
      );
      const holds: TimeRange[] = holdsRes.rows.map((h) => ({
        start: new Date(h.start_time),
        end: new Date(h.end_time),
      }));

      const busyProfessionalTimes: TimeRange[] = [...breaks, ...appts, ...holds];

      // Parse shift start and end
      const shiftStartTime = new Date(`${date}T${shift.startTime}Z`);
      const shiftEndTime = new Date(`${date}T${shift.endTime}Z`);

      // Iterate grid intervals
      let currentSlotStart = new Date(shiftStartTime);

      while (true) {
        const currentSlotEnd = new Date(currentSlotStart.getTime() + durationMinutes * 60 * 1000);

        // Shift boundary check: slot must complete before or at shift end
        if (currentSlotEnd.getTime() > shiftEndTime.getTime()) {
          break;
        }

        // Check if professional collides with breaks, appts, or holds
        const hasProfCollision = busyProfessionalTimes.some((busy) =>
          AvailabilityEngine.rangesOverlap(currentSlotStart, currentSlotEnd, busy.start, busy.end)
        );

        if (!hasProfCollision) {
          // Check Required Resources Availability
          const assignedResourceIds: string[] = [];
          let allResourcesSatisfied = true;

          for (const req of requiredResources) {
            const candidateResources = branchResources.filter((br) => br.resource_type === req.resource_type);
            let freeFound = false;

            for (const cand of candidateResources) {
              const busyRanges = busyResourceMap.get(cand.id) || [];
              const collides = busyRanges.some((b) =>
                AvailabilityEngine.rangesOverlap(currentSlotStart, currentSlotEnd, b.start, b.end)
              );

              if (!collides) {
                assignedResourceIds.push(cand.id);
                freeFound = true;
                break;
              }
            }

            if (!freeFound) {
              allResourcesSatisfied = false;
              break;
            }
          }

          if (allResourcesSatisfied) {
            availableSlots.push({
              startTime: currentSlotStart.toISOString(),
              endTime: currentSlotEnd.toISOString(),
              professionalId: shift.professionalId,
              professionalName: shift.professionalName,
              assignedResourceIds,
            });
          }
        }

        // Advance by slot interval
        currentSlotStart = new Date(currentSlotStart.getTime() + slotIntervalMinutes * 60 * 1000);
      }
    }

    return availableSlots;
  }

  /**
   * Determines if half-open intervals [startA, endA) and [startB, endB) overlap.
   */
  public static rangesOverlap(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
    return startA.getTime() < endB.getTime() && endA.getTime() > startB.getTime();
  }
}

