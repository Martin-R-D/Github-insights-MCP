import { listRepos } from "../db/repos.js";
import { syncAll } from "./sync.js";
import { logger } from "../utils/logger.js";

/**
 * First-run experience. On boot, if the local DB has no repos yet, kick off an
 * initial full sync in the background and expose progress so tools can answer
 * "still syncing, N repos done" instead of returning misleading empty data.
 */

interface FirstRunState {
  active: boolean;
  done: number;
  total: number;
  error?: string;
}

const state: FirstRunState = { active: false, done: 0, total: 0 };

/** Is an initial (first-run) sync currently in progress? */
export function firstRunActive(): boolean {
  return state.active;
}

export function firstRunStatus(): Readonly<FirstRunState> {
  return { ...state };
}

/** True when no repos have been synced into the DB yet. */
export function isDbEmpty(): boolean {
  return listRepos({ includeForks: true, includeArchived: true, includePrivate: true }).length === 0;
}

/**
 * If the DB is empty and no initial sync is already running, start one in the
 * background. Returns immediately; progress is tracked in module state.
 */
export function startInitialSyncIfEmpty(): void {
  if (state.active) return;
  if (!isDbEmpty()) return;

  state.active = true;
  state.done = 0;
  state.total = 0;
  state.error = undefined;
  logger.info("First run: local database is empty, starting initial sync in the background");

  void syncAll({
    full: true,
    onProgress: (done, total) => {
      state.done = done;
      state.total = total;
      logger.info("Initial sync progress", { done, total });
    },
  })
    .then((report) => {
      logger.info("Initial sync complete", {
        reposSynced: report.reposSynced,
        commitsAdded: report.commitsAdded,
        starsAdded: report.starsAdded,
      });
    })
    .catch((err) => {
      state.error = err instanceof Error ? err.message : String(err);
      logger.error("Initial sync failed", { message: state.error });
    })
    .finally(() => {
      state.active = false;
    });
}

/** A friendly tool response used while the first-run sync is still going. */
export function stillSyncingResponse() {
  const total = state.total > 0 ? String(state.total) : "?";
  return {
    summary:
      `Still setting up: syncing your GitHub data for the first time (${state.done} of ${total} repos done). ` +
      `This runs once and can take a minute or two — ask again shortly.`,
    data: null,
    meta: {
      syncing: true,
      repos_done: state.done,
      repos_total: state.total,
      generated_at: new Date().toISOString(),
    },
  };
}
