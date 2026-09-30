import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverKiroSkills } from "./KiroSkills.ts";

const makeWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-skills-" });
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  const environment = { HOME: home, USERPROFILE: home };
  const writeSkill = (directory: string, contents: string) =>
    fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(directory, "SKILL.md"), contents)));
  return { fs, path, root, cwd, home, environment, writeSkill };
});

it.layer(NodeServices.layer)("discoverKiroSkills", (it) => {
  it.effect("reports user skills with descriptions and invocation paths", () =>
    Effect.gen(function* () {
      const { cwd, home, environment, path, writeSkill } = yield* makeWorkspace;
      const directory = path.join(home, ".kiro", "skills", "review");
      yield* writeSkill(directory, "---\nname: review\ndescription: Review changes\n---\n");
      assert.deepEqual(yield* discoverKiroSkills(cwd, environment), [
        {
          name: "review",
          description: "Review changes",
          path: path.join(directory, "SKILL.md"),
          scope: "user",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("prefers workspace skills and does not leak skills between workspaces", () =>
    Effect.gen(function* () {
      const { cwd, home, environment, path, writeSkill } = yield* makeWorkspace;
      yield* writeSkill(
        path.join(home, ".kiro", "skills", "review"),
        "---\nname: review\ndescription: Global review\n---\n",
      );
      const directory = path.join(cwd, ".kiro", "skills", "review");
      yield* writeSkill(directory, "---\nname: review\ndescription: Project review\n---\n");
      assert.deepEqual(yield* discoverKiroSkills(cwd, environment), [
        {
          name: "review",
          description: "Project review",
          path: path.join(directory, "SKILL.md"),
          scope: "project",
          enabled: true,
        },
      ]);
      const otherWorkspaceSkills = yield* discoverKiroSkills(path.join(cwd, "other"), environment);
      assert.equal(otherWorkspaceSkills[0]?.description, "Global review");
      assert.equal(otherWorkspaceSkills[0]?.scope, "user");
    }),
  );

  it.effect("skips malformed skills, loose files, and non-Kiro roots", () =>
    Effect.gen(function* () {
      const { cwd, home, environment, path, fs, writeSkill } = yield* makeWorkspace;
      assert.deepEqual(yield* discoverKiroSkills(cwd, environment), []);
      const root = path.join(home, ".kiro", "skills");
      for (const { name, contents } of [
        { name: "invalid-yaml", contents: "---\nname: [invalid\n---\n" },
        { name: "no-description", contents: "---\nname: no-description\n---\n" },
        { name: "no-frontmatter", contents: "Instructions only" },
      ]) {
        yield* writeSkill(path.join(root, name), contents);
      }
      yield* fs.writeFileString(path.join(root, "README.md"), "Not a skill");
      yield* writeSkill(
        path.join(home, ".agents", "skills", "ignored"),
        "---\nname: ignored\ndescription: Other provider\n---\n",
      );
      assert.deepEqual(yield* discoverKiroSkills(cwd, environment), []);
    }),
  );

  it.effect.skipIf(!symlinksSupported)("discovers linked user skill directories", () =>
    Effect.gen(function* () {
      const { cwd, home, root, environment, path, fs, writeSkill } = yield* makeWorkspace;
      const target = path.join(root, "library", "review");
      yield* writeSkill(target, "---\nname: review\ndescription: Linked review\n---\n");
      const skillsRoot = path.join(home, ".kiro", "skills");
      yield* fs.makeDirectory(skillsRoot, { recursive: true });
      const link = path.join(skillsRoot, "review");
      yield* fs.symlink(target, link);
      assert.deepEqual(yield* discoverKiroSkills(cwd, environment), [
        {
          name: "review",
          description: "Linked review",
          path: path.join(link, "SKILL.md"),
          scope: "user",
          enabled: true,
        },
      ]);
    }),
  );
});
