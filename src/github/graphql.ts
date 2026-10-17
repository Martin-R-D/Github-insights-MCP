import { USER_AGENT } from "../version.js";
import { graphql } from "@octokit/graphql";
import { loadConfig } from "../config.js";
import { ToolError } from "../utils/errors.js";

/**
 * GitHub GraphQL access for the contribution calendar. The
 * contributionsCollection API only accepts windows of at most one year, so
 * requests are chunked into <= 1-year segments and merged into a flat,
 * date-ascending array.
 */


export interface ContributionDay {
  date: string;
  count: number;
}

interface CalendarResponse {
  user: {
    contributionsCollection: {
      contributionCalendar: {
        weeks: { contributionDays: { date: string; contributionCount: number }[] }[];
      };
    } | null;
  } | null;
}

const CALENDAR_QUERY = /* GraphQL */ `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

export interface GraphqlClientOptions {
  token?: string;
  /** Inject a preconfigured graphql function (used by tests). */
  graphql?: typeof graphql;
}

function makeClient(options: GraphqlClientOptions): typeof graphql {
  if (options.graphql) return options.graphql;
  const token = options.token ?? loadConfig().GITHUB_TOKEN;
  return graphql.defaults({
    headers: { authorization: `token ${token}`, "user-agent": USER_AGENT },
  });
}

/**
 * Split [from, to] into inclusive windows no longer than one year. Windows are
 * back-to-back with no overlap.
 */
function chunkByYear(from: Date, to: Date): { from: Date; to: Date }[] {
  const windows: { from: Date; to: Date }[] = [];
  let cursor = new Date(from);

  while (cursor <= to) {
    const end = new Date(cursor);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    end.setUTCDate(end.getUTCDate() - 1); // one-year inclusive span
    const windowEnd = end < to ? end : to;
    windows.push({ from: new Date(cursor), to: new Date(windowEnd) });

    cursor = new Date(windowEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return windows;
}

/**
 * Fetch a user's contribution calendar between `from` and `to` (ISO date or
 * datetime strings), returning a flat array of { date, count } sorted ascending
 * with duplicate dates summed.
 */
export async function getContributionCalendar(
  username: string,
  from: string,
  to: string,
  options: GraphqlClientOptions = {},
): Promise<ContributionDay[]> {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new ToolError("invalid_input", "getContributionCalendar requires valid from/to dates.");
  }
  if (fromDate > toDate) {
    throw new ToolError("invalid_input", "`from` must be on or before `to`.");
  }

  const client = makeClient(options);
  const byDate = new Map<string, number>();

  for (const window of chunkByYear(fromDate, toDate)) {
    const result = await client<CalendarResponse>(CALENDAR_QUERY, {
      login: username,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    });

    const weeks = result.user?.contributionsCollection?.contributionCalendar?.weeks ?? [];
    for (const week of weeks) {
      for (const day of week.contributionDays) {
        byDate.set(day.date, (byDate.get(day.date) ?? 0) + day.contributionCount);
      }
    }
  }

  return [...byDate.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
