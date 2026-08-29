/**
 * The npm package this fork publishes and installs for remote server runtimes.
 * The upstream repo publishes `t3`; this fork publishes under its own scope so
 * pinned runtime installs (`t3 service install`) never pull the official
 * package over a fork build. Keep `apps/server/package.json` named `t3` — the
 * publish command rewrites the name only while publishing.
 */
export const NPM_PACKAGE_NAME = "@ianworleyxyz/t3";
