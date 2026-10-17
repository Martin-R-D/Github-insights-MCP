import packageJson from "../package.json";

/** Shared release identity; bundled from package.json at build time. */
export const VERSION = packageJson.version;
export const USER_AGENT = `github-insights-mcp/${VERSION}`;
