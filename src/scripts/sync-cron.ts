/**
 * Scheduled sync entry point (for cron / launchd / Task Scheduler).
 *
 * Runs a full syncAll() and then snapshotToday(), so daily_snapshots accumulate
 * the historical stars/forks/issues trend that GitHub's API does NOT retain.
 * Run this once a day. Logs go to stderr; exits non-zero if any resource failed.
 *
 * Usage:
 *   node dist/scripts/sync-cron.js            # incremental daily sync + snapshot
 *   node dist/scripts/sync-cron.js --full     # 365-day backfill + snapshot
 */
import { syncAll } from "../services/sync.js";
import { closeDb } from "../db/client.js";
import { logger, redactSecret } from "../utils/logger.js";
import { loadConfig } from "../config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  redactSecret(config.GITHUB_TOKEN);

  const full = process.argv.slice(2).includes("--full");
  logger.info("Scheduled sync starting", { full });

  const report = await syncAll({ full });

  logger.info("Scheduled sync complete", {
    reposSynced: report.reposSynced,
    commitsAdded: report.commitsAdded,
    starsAdded: report.starsAdded,
    snapshotRepos: report.snapshotRepos,
    errors: report.errors.length,
  });
  process.stderr.write(JSON.stringify(report, null, 2) + "\n");

  closeDb();
  // Use exitCode + natural drain rather than process.exit() to avoid a libuv
  // "handle closing" assertion when undici sockets are still tearing down.
  process.exitCode = report.errors.length > 0 ? 1 : 0;
}

main().catch((err) => {
  logger.error("Scheduled sync failed", { message: err instanceof Error ? err.message : String(err) });
  process.stderr.write(`\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  closeDb();
  process.exitCode = 1;
});
