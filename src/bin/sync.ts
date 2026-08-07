/**
 * CLI entry point for cron: run a sync and exit.
 *
 * Usage:
 *   node dist/bin/sync.js            # incremental sync of all repos
 *   node dist/bin/sync.js --full     # 365-day backfill + enrichment
 *   node dist/bin/sync.js --repo owner/name
 *
 * Logs go to stderr (stdout stays clean); exits non-zero if any resource failed.
 */
import { syncAll } from "../services/sync.js";
import { logger } from "../utils/logger.js";

function parseArgs(argv: string[]): { full: boolean; repo?: string } {
  const full = argv.includes("--full");
  const repoIdx = argv.indexOf("--repo");
  const repo = repoIdx >= 0 ? argv[repoIdx + 1] : undefined;
  return { full, repo };
}

async function main(): Promise<void> {
  const { full, repo } = parseArgs(process.argv.slice(2));
  logger.info("sync starting", { full, repo });

  const report = await syncAll({ full, repo });
  logger.info("sync complete", report);

  // Emit the machine-readable report to stderr as well for cron log capture.
  process.stderr.write(JSON.stringify(report, null, 2) + "\n");

  process.exit(report.errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  logger.error("sync failed", { message: err instanceof Error ? err.message : String(err) });
  process.stderr.write(`\n${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
