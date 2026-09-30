import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_SKILL_BYTES = 1_000_000;
const SkillFrontmatter = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
});
const decodeSkillFrontmatter = Schema.decodeUnknownSync(SkillFrontmatter);

function parseSkillFrontmatter(contents: string) {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return undefined;
  try {
    return decodeSkillFrontmatter(parseYamlDocument(match[1] ?? ""));
  } catch {
    return undefined;
  }
}

const ifPresent = <A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
  effect.pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.undefined : Effect.fail(error),
    ),
  );

/** Mirrors the default Kiro agent's roots; workspace skills override user skills. */
export const discoverKiroSkills = Effect.fn("discoverKiroSkills")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const userHome =
    (platform === "win32" ? environment.USERPROFILE : environment.HOME) || NodeOS.homedir();
  const roots = [
    { directory: path.join(cwd, ".kiro", "skills"), scope: "project" },
    { directory: path.join(userHome, ".kiro", "skills"), scope: "user" },
  ];
  const skills = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* ifPresent(fileSystem.readDirectory(root.directory));
    for (const entry of entries?.toSorted() ?? []) {
      const directory = path.join(root.directory, entry);
      const directoryInfo = yield* ifPresent(fileSystem.stat(directory));
      if (directoryInfo?.type !== "Directory") continue;
      const skillPath = path.join(directory, "SKILL.md");
      const info = yield* ifPresent(fileSystem.stat(skillPath));
      if (info?.type !== "File" || info.size > BigInt(MAX_SKILL_BYTES)) continue;
      const contents = yield* ifPresent(fileSystem.readFileString(skillPath));
      const frontmatter = contents === undefined ? undefined : parseSkillFrontmatter(contents);
      if (!frontmatter) continue;
      const name = frontmatter.name.trim();
      const description = frontmatter.description.trim();
      if (!name || !description || skills.has(name)) continue;
      skills.set(name, { name, description, path: skillPath, scope: root.scope, enabled: true });
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
});
