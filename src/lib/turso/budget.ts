/**
 * Turso Database Rows Read and Rows Written Budget Monitoring & Protective Controls
 *
 * Database: duokarma
 *
 * Operational Monthly Targets:
 *   - Rows Read Target:    100,000,000 (100 Million rows / month)
 *   - Rows Written Target:   5,000,000 (5 Million writes / month, established from ~914k/month baseline + production headroom)
 *
 * Baseline Measurement Period:
 *   - Inception: 2026-10-17T06:08:03Z
 *   - Snapshot: 2026-10-25T16:00:00Z (~8.41 days / ~202 hours)
 *   - Baseline Cumulative Rows Read:    1,941,879 (~231,000 reads/day; ~6.93M projected/month)
 *   - Baseline Cumulative Rows Written:   256,388 (~30,486 writes/day; ~914,580 projected/month)
 *   - Storage: 9.9 MB
 *
 * Multi-Tier Alert Thresholds (50%, 70%, 85%, 95%):
 *   - Reads:  50M (INFO), 70M (WARNING), 85M (ELEVATED), 95M (CRITICAL)
 *   - Writes: 2.5M (INFO), 3.5M (WARNING), 4.25M (ELEVATED), 4.75M (CRITICAL)
 *
 * Throttling Policy:
 *   - At ELEVATED (85%): Throttles heavy historical range exports, increases background refresh intervals.
 *   - At CRITICAL (95%): Suspends nonessential background UI polls.
 *   - GUARANTEED ESSENTIAL PATHS:
 *     Location ingestion, heartbeat processing, authentication, sales, payments,
 *     and emergency SOS are STRICTLY PROTECTED and NEVER throttled or disabled.
 */

export type ReadCategory =
  | "telemetry_ingestion"
  | "dashboard_overview"
  | "location_trail"
  | "auth_session"
  | "retention_purge"
  | "other";

export type WriteCategory =
  | "telemetry_locations"
  | "device_heartbeats"
  | "attendance_sessions"
  | "safety_sos_alerts"
  | "audit_logs"
  | "retention_purges"
  | "other";

export interface MetricStat {
  count: number;
  estimatedRows: number;
}

export type BudgetStatus = "NORMAL" | "INFO" | "WARNING" | "ELEVATED" | "CRITICAL";

// Baseline Turso metrics from the dashboard snapshot
export const TURSO_BASELINE = {
  databaseName: "duokarma",
  measurementStart: "2026-10-17T06:08:03.346Z",
  snapshotTimestamp: "2026-10-25T16:00:00.000Z",
  cumulativeRowsRead: 1_941_879,
  cumulativeRowsWritten: 256_388,
  storageMB: 9.9,
  monthlyReadBudget: 100_000_000,
  monthlyWriteBudget: 5_000_000,
};

// Thresholds for alerts and defensive backoff
export const READ_THRESHOLDS = {
  INFO_50M: 50_000_000,
  WARNING_70M: 70_000_000,
  ELEVATED_85M: 85_000_000,
  CRITICAL_95M: 95_000_000,
  MAX_LIMIT_100M: 100_000_000,
};

export const WRITE_THRESHOLDS = {
  INFO_50_PCT: 2_500_000,    // 50% of 5M
  WARNING_70_PCT: 3_500_000, // 70% of 5M
  ELEVATED_85_PCT: 4_250_000,// 85% of 5M
  CRITICAL_95_PCT: 4_750_000,// 95% of 5M
  MAX_LIMIT_5M: 5_000_000,
};

// In-memory diagnostic tracker for application runtime
class TursoBudgetTracker {
  private readStats = new Map<ReadCategory, MetricStat>([
    ["telemetry_ingestion", { count: 0, estimatedRows: 0 }],
    ["dashboard_overview", { count: 0, estimatedRows: 0 }],
    ["location_trail", { count: 0, estimatedRows: 0 }],
    ["auth_session", { count: 0, estimatedRows: 0 }],
    ["retention_purge", { count: 0, estimatedRows: 0 }],
    ["other", { count: 0, estimatedRows: 0 }],
  ]);

  private writeStats = new Map<WriteCategory, MetricStat>([
    ["telemetry_locations", { count: 0, estimatedRows: 0 }],
    ["device_heartbeats", { count: 0, estimatedRows: 0 }],
    ["attendance_sessions", { count: 0, estimatedRows: 0 }],
    ["safety_sos_alerts", { count: 0, estimatedRows: 0 }],
    ["audit_logs", { count: 0, estimatedRows: 0 }],
    ["retention_purges", { count: 0, estimatedRows: 0 }],
    ["other", { count: 0, estimatedRows: 0 }],
  ]);

  private sessionStartedAt = Date.now();
  private mockReadOffset = 0;   // For test simulation
  private mockWriteOffset = 0;  // For test simulation

  /**
   * Diagnostic instrumentation: records estimated rows read.
   */
  public recordQuery(category: ReadCategory, estimatedRows: number = 1): void {
    const stat = this.readStats.get(category) || { count: 0, estimatedRows: 0 };
    stat.count += 1;
    stat.estimatedRows += Math.max(0, estimatedRows);
    this.readStats.set(category, stat);
  }

  /**
   * Diagnostic instrumentation: records estimated rows written.
   */
  public recordWrite(category: WriteCategory, estimatedWrites: number = 1): void {
    const stat = this.writeStats.get(category) || { count: 0, estimatedRows: 0 };
    stat.count += 1;
    stat.estimatedRows += Math.max(0, estimatedWrites);
    this.writeStats.set(category, stat);
  }

  /**
   * For testing and simulation: inject offset into projected usage.
   */
  public setMockUsageOffset(readOffset: number, writeOffset: number = 0): void {
    this.mockReadOffset = readOffset;
    this.mockWriteOffset = writeOffset;
  }

  /**
   * Computes current budget status and daily/monthly projections for both reads and writes.
   */
  public getBudgetReport() {
    const now = Date.now();
    const baselineStartMs = new Date(TURSO_BASELINE.measurementStart).getTime();
    const baselineSnapshotMs = new Date(TURSO_BASELINE.snapshotTimestamp).getTime();

    const baselineDays = Math.max(0.1, (baselineSnapshotMs - baselineStartMs) / (1000 * 60 * 60 * 24));
    const baselineDailyReads = Math.round(TURSO_BASELINE.cumulativeRowsRead / baselineDays);
    const baselineMonthlyProjectedReads = Math.round(baselineDailyReads * 30);

    const baselineDailyWrites = Math.round(TURSO_BASELINE.cumulativeRowsWritten / baselineDays);
    const baselineMonthlyProjectedWrites = Math.round(baselineDailyWrites * 30);

    const runtimeHours = Math.max(0.01, (now - this.sessionStartedAt) / (1000 * 60 * 60));

    // Aggregate Diagnostic Reads
    let totalDiagnosticReads = 0;
    let totalDiagnosticQueries = 0;
    const readBreakdown: Record<string, MetricStat> = {};
    for (const [cat, stat] of this.readStats.entries()) {
      readBreakdown[cat] = { ...stat };
      totalDiagnosticReads += stat.estimatedRows;
      totalDiagnosticQueries += stat.count;
    }

    const runtimeDailyReadRate = Math.round((totalDiagnosticReads / runtimeHours) * 24);
    const estimatedMonthlyReads = this.mockReadOffset > 0
      ? this.mockReadOffset
      : Math.round(Math.max(baselineMonthlyProjectedReads, runtimeDailyReadRate * 30));

    // Aggregate Diagnostic Writes
    let totalDiagnosticWrites = 0;
    let totalDiagnosticWriteOps = 0;
    const writeBreakdown: Record<string, MetricStat> = {};
    for (const [cat, stat] of this.writeStats.entries()) {
      writeBreakdown[cat] = { ...stat };
      totalDiagnosticWrites += stat.estimatedRows;
      totalDiagnosticWriteOps += stat.count;
    }

    const runtimeDailyWriteRate = Math.round((totalDiagnosticWrites / runtimeHours) * 24);
    const estimatedMonthlyWrites = this.mockWriteOffset > 0
      ? this.mockWriteOffset
      : Math.round(Math.max(baselineMonthlyProjectedWrites, runtimeDailyWriteRate * 30));

    // Determine Read Status
    let readStatus: BudgetStatus = "NORMAL";
    if (estimatedMonthlyReads >= READ_THRESHOLDS.CRITICAL_95M) {
      readStatus = "CRITICAL";
    } else if (estimatedMonthlyReads >= READ_THRESHOLDS.ELEVATED_85M) {
      readStatus = "ELEVATED";
    } else if (estimatedMonthlyReads >= READ_THRESHOLDS.WARNING_70M) {
      readStatus = "WARNING";
    } else if (estimatedMonthlyReads >= READ_THRESHOLDS.INFO_50M) {
      readStatus = "INFO";
    }

    // Determine Write Status
    let writeStatus: BudgetStatus = "NORMAL";
    if (estimatedMonthlyWrites >= WRITE_THRESHOLDS.CRITICAL_95_PCT) {
      writeStatus = "CRITICAL";
    } else if (estimatedMonthlyWrites >= WRITE_THRESHOLDS.ELEVATED_85_PCT) {
      writeStatus = "ELEVATED";
    } else if (estimatedMonthlyWrites >= WRITE_THRESHOLDS.WARNING_70_PCT) {
      writeStatus = "WARNING";
    } else if (estimatedMonthlyWrites >= WRITE_THRESHOLDS.INFO_50_PCT) {
      writeStatus = "INFO";
    }

    // Overall Status is highest severity between read and write
    const severityOrder: BudgetStatus[] = ["NORMAL", "INFO", "WARNING", "ELEVATED", "CRITICAL"];
    const overallStatus: BudgetStatus =
      severityOrder[Math.max(severityOrder.indexOf(readStatus), severityOrder.indexOf(writeStatus))];

    const readPercentage = Math.min(100, Number(((estimatedMonthlyReads / READ_THRESHOLDS.MAX_LIMIT_100M) * 100).toFixed(2)));
    const writePercentage = Math.min(100, Number(((estimatedMonthlyWrites / WRITE_THRESHOLDS.MAX_LIMIT_5M) * 100).toFixed(2)));

    return {
      status: overallStatus,
      reads: {
        status: readStatus,
        percentageUsed: readPercentage,
        targetLimitMonthly: READ_THRESHOLDS.MAX_LIMIT_100M,
        thresholds: READ_THRESHOLDS,
        estimatedDailyRate: runtimeDailyReadRate,
        estimatedMonthlyProjected: estimatedMonthlyReads,
        breakdown: readBreakdown,
      },
      writes: {
        status: writeStatus,
        percentageUsed: writePercentage,
        targetLimitMonthly: WRITE_THRESHOLDS.MAX_LIMIT_5M,
        thresholds: WRITE_THRESHOLDS,
        estimatedDailyRate: runtimeDailyWriteRate,
        estimatedMonthlyProjected: estimatedMonthlyWrites,
        breakdown: writeBreakdown,
      },
      baseline: {
        ...TURSO_BASELINE,
        daysMeasured: Number(baselineDays.toFixed(2)),
        baselineDailyReads,
        baselineMonthlyProjectedReads,
        baselineDailyWrites,
        baselineMonthlyProjectedWrites,
      },
      diagnostic: {
        notice: "Application-level diagnostic counters are estimates and not authoritative Turso billing meters.",
        runtimeHours: Number(runtimeHours.toFixed(2)),
        totalQueries: totalDiagnosticQueries,
        totalEstimatedRowsRead: totalDiagnosticReads,
        totalWriteOperations: totalDiagnosticWriteOps,
        totalEstimatedRowsWritten: totalDiagnosticWrites,
      },
      throttling: {
        isElevated: overallStatus === "ELEVATED" || overallStatus === "CRITICAL",
        isCritical: overallStatus === "CRITICAL",
        throttleOptionalReports: overallStatus === "ELEVATED" || overallStatus === "CRITICAL",
        throttleNonessentialRefreshes: overallStatus === "CRITICAL",
        // Strict Protective Guarantees
        essentialTrackingGuaranteed: true,
        heartbeatGuaranteed: true,
        authenticationGuaranteed: true,
        sosSafetyGuaranteed: true,
      },
    };
  }
}

// Global singleton instance
export const tursoBudgetTracker = new TursoBudgetTracker();
export const THRESHOLDS = READ_THRESHOLDS; // Backward-compatible alias
