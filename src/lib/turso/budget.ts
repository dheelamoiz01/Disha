/**
 * Turso Database Rows Read Budget Monitoring & Throttling Infrastructure
 *
 * Database: duokarma
 * Monthly Rows Read Budget: 100,000,000 (100 Million rows)
 *
 * Baseline Measurement Period:
 *   - Inception: 2026-10-17T06:08:03Z
 *   - Turso Dashboard Cumulative Snapshot: 1,941,879 Rows Read, 256,388 Rows Written, 9.9 MB Storage
 *   - Elapsed Baseline Window: ~8.41 days (~202 hours)
 *   - Historical Baseline Rate: ~231,000 rows/day (~6.93M rows/month baseline)
 *
 * Thresholds:
 *   - 50M (50%): INFO
 *   - 70M (70%): WARNING
 *   - 85M (85%): ELEVATED — Throttles heavy historical range queries & increases refresh intervals
 *   - 95M (95%): CRITICAL — Suspends nonessential background UI polls while keeping 100% of
 *                           essential GPS ingestion, heartbeats, auth, and emergency SOS active.
 *
 * NOTE: Application-level counters are diagnostic estimates and clearly designated as such.
 */

export type QueryCategory =
  | "telemetry_ingestion"
  | "dashboard_overview"
  | "location_trail"
  | "auth_session"
  | "retention_purge"
  | "other";

export interface CategoryMetrics {
  queryCount: number;
  estimatedRowsRead: number;
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
  monthlyBudget: 100_000_000, // 100M Limit
};

// Thresholds for alerts and defensive backoff
export const THRESHOLDS = {
  INFO_50M: 50_000_000,
  WARNING_70M: 70_000_000,
  ELEVATED_85M: 85_000_000,
  CRITICAL_95M: 95_000_000,
  MAX_LIMIT_100M: 100_000_000,
};

// In-memory diagnostic tracker for application runtime
class TursoBudgetTracker {
  private categoryStats = new Map<QueryCategory, CategoryMetrics>([
    ["telemetry_ingestion", { queryCount: 0, estimatedRowsRead: 0 }],
    ["dashboard_overview", { queryCount: 0, estimatedRowsRead: 0 }],
    ["location_trail", { queryCount: 0, estimatedRowsRead: 0 }],
    ["auth_session", { queryCount: 0, estimatedRowsRead: 0 }],
    ["retention_purge", { queryCount: 0, estimatedRowsRead: 0 }],
    ["other", { queryCount: 0, estimatedRowsRead: 0 }],
  ]);

  private sessionStartedAt = Date.now();
  private mockUsageOffset = 0; // For test simulation

  /**
   * Diagnostic instrumentation: records estimated rows read by query category.
   */
  public recordQuery(category: QueryCategory, estimatedRows: number = 1): void {
    const stat = this.categoryStats.get(category) || { queryCount: 0, estimatedRowsRead: 0 };
    stat.queryCount += 1;
    stat.estimatedRowsRead += Math.max(0, estimatedRows);
    this.categoryStats.set(category, stat);
  }

  /**
   * For testing and simulation: inject offset into projected usage.
   */
  public setMockUsageOffset(offset: number): void {
    this.mockUsageOffset = offset;
  }

  /**
   * Computes current budget status and daily/monthly projections.
   */
  public getBudgetReport() {
    const now = Date.now();
    const baselineStartMs = new Date(TURSO_BASELINE.measurementStart).getTime();
    const baselineSnapshotMs = new Date(TURSO_BASELINE.snapshotTimestamp).getTime();

    const baselineDays = Math.max(0.1, (baselineSnapshotMs - baselineStartMs) / (1000 * 60 * 60 * 24));
    const baselineDailyRows = Math.round(TURSO_BASELINE.cumulativeRowsRead / baselineDays);
    const baselineMonthlyProjected = Math.round(baselineDailyRows * 30);

    // Runtime observed stats
    const runtimeHours = Math.max(0.01, (now - this.sessionStartedAt) / (1000 * 60 * 60));
    let totalDiagnosticRows = 0;
    let totalDiagnosticQueries = 0;
    const categoryBreakdown: Record<string, CategoryMetrics> = {};

    for (const [cat, stat] of this.categoryStats.entries()) {
      categoryBreakdown[cat] = { ...stat };
      totalDiagnosticRows += stat.estimatedRowsRead;
      totalDiagnosticQueries += stat.queryCount;
    }

    // Extrapolate monthly projection based on runtime rate or baseline
    const runtimeDailyRate = Math.round((totalDiagnosticRows / runtimeHours) * 24);
    const estimatedMonthlyTotal = this.mockUsageOffset > 0
      ? this.mockUsageOffset
      : Math.round(Math.max(baselineMonthlyProjected, runtimeDailyRate * 30));

    // Determine Status
    let status: BudgetStatus = "NORMAL";
    if (estimatedMonthlyTotal >= THRESHOLDS.CRITICAL_95M) {
      status = "CRITICAL";
    } else if (estimatedMonthlyTotal >= THRESHOLDS.ELEVATED_85M) {
      status = "ELEVATED";
    } else if (estimatedMonthlyTotal >= THRESHOLDS.WARNING_70M) {
      status = "WARNING";
    } else if (estimatedMonthlyTotal >= THRESHOLDS.INFO_50M) {
      status = "INFO";
    }

    const percentageUsed = Math.min(100, Number(((estimatedMonthlyTotal / THRESHOLDS.MAX_LIMIT_100M) * 100).toFixed(2)));

    return {
      status,
      percentageUsed,
      thresholds: THRESHOLDS,
      baseline: {
        ...TURSO_BASELINE,
        daysMeasured: Number(baselineDays.toFixed(2)),
        baselineDailyRate: baselineDailyRows,
        baselineMonthlyProjected,
      },
      diagnostic: {
        notice: "Application-level diagnostic counters are estimates and not authoritative Turso billing meters.",
        runtimeHours: Number(runtimeHours.toFixed(2)),
        totalQueries: totalDiagnosticQueries,
        totalEstimatedRowsRead: totalDiagnosticRows,
        estimatedDailyRate: runtimeDailyRate,
        estimatedMonthlyProjected: estimatedMonthlyTotal,
        categoryBreakdown,
      },
      throttling: {
        isElevated: status === "ELEVATED" || status === "CRITICAL",
        isCritical: status === "CRITICAL",
        throttleOptionalReports: status === "ELEVATED" || status === "CRITICAL",
        throttleNonessentialRefreshes: status === "CRITICAL",
        // Guarantees: essential functions are NEVER throttled
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
