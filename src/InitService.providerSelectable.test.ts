import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scaffold,
  getNextStepsLines,
  getAgent,
  getIssueTracker,
  getSandboxProvider,
  listTemplates,
  isProviderSelectableTemplate,
} from "./InitService.js";
import type { ScaffoldOptions } from "./InitService.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-selectable-"));

const claudeCodeAgent = getAgent("claude-code")!;
const codexAgent = getAgent("codex")!;
const piAgent = getAgent("pi")!;

const runScaffold = (
  options?: Partial<ScaffoldOptions>,
  repoDir?: string,
  pkg?: Record<string, unknown>,
) =>
  (async () => {
    const dir = repoDir ?? (await makeDir());
    if (pkg) {
      await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    }
    await Effect.runPromise(
      scaffold(dir, {
        agent: claudeCodeAgent,
        model: "claude-opus-4-8",
        ...options,
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    return dir;
  })();

const readMain = async (dir: string, filename = "main.mts") =>
  readFile(join(dir, ".sandcastle", filename), "utf-8");

// ---------------------------------------------------------------------------
// Template metadata
// ---------------------------------------------------------------------------

describe("providerSelectable template metadata", () => {
  it("flags both planner templates as provider-selectable", () => {
    expect(isProviderSelectableTemplate("parallel-planner")).toBe(true);
    expect(isProviderSelectableTemplate("parallel-planner-with-review")).toBe(
      true,
    );
  });

  it("does not flag the other templates", () => {
    for (const template of listTemplates()) {
      if (!template.name.startsWith("parallel-planner")) {
        expect(isProviderSelectableTemplate(template.name)).toBe(false);
      }
    }
    expect(isProviderSelectableTemplate("nonexistent")).toBe(false);
  });

  it("listTemplates exposes the flag on the metadata entries", () => {
    const planner = listTemplates().find((t) => t.name === "parallel-planner")!;
    expect(planner.providerSelectable).toBe(true);
    expect(planner.dependencies).toContain("zod");
  });
});

// ---------------------------------------------------------------------------
// Dual-CLI Dockerfile
// ---------------------------------------------------------------------------

describe("providerSelectable scaffold — containerfile", () => {
  it("writes the dual-CLI Dockerfile regardless of the selected agent", async () => {
    for (const agent of [claudeCodeAgent, codexAgent, piAgent]) {
      const dir = await runScaffold({
        templateName: "parallel-planner",
        agent,
        model: agent.defaultModel,
      });
      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      // Both agent CLIs are installed so SANDCASTLE_AGENT can switch at runtime.
      expect(dockerfile).toContain("npm install -g @openai/codex");
      expect(dockerfile).toContain("https://claude.ai/install.sh | bash");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
    }
  });

  it("selecting podman writes the dual-CLI Containerfile", async () => {
    const dir = await runScaffold({
      templateName: "parallel-planner",
      sandboxProvider: getSandboxProvider("podman"),
    });

    const containerfile = await readFile(
      join(dir, ".sandcastle", "Containerfile"),
      "utf-8",
    );
    expect(containerfile).toContain("npm install -g @openai/codex");
    expect(containerfile).toContain("https://claude.ai/install.sh | bash");

    const { access } = await import("node:fs/promises");
    await expect(
      access(join(dir, ".sandcastle", "Dockerfile")),
    ).rejects.toThrow();
  });

  it("aligns UID/GID with build args like the per-agent images", async () => {
    const dir = await runScaffold({ templateName: "parallel-planner" });
    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("ARG AGENT_UID=1000");
    expect(dockerfile).toContain("ARG AGENT_GID=1000");
    expect(dockerfile).toContain("groupmod -o -g $AGENT_GID node");
    // Codex installs as root before the USER directive; the Claude CLI after.
    expect(dockerfile).toMatch(
      /npm install -g @openai\/codex[\s\S]*USER \$\{AGENT_UID\}:\$\{AGENT_GID\}[\s\S]*claude\.ai\/install\.sh/,
    );
  });
});

// ---------------------------------------------------------------------------
// .env.example
// ---------------------------------------------------------------------------

describe("providerSelectable scaffold — .env.example", () => {
  it("documents both agent env blocks and the SANDCASTLE_* knobs", async () => {
    const dir = await runScaffold({ templateName: "parallel-planner" });
    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );

    // Selection knobs
    for (const key of [
      "SANDCASTLE_AGENT",
      "SANDCASTLE_CLAUDE_PLANNER_MODEL",
      "SANDCASTLE_CLAUDE_WORKER_MODEL",
      "SANDCASTLE_CODEX_PLANNER_MODEL",
      "SANDCASTLE_CODEX_WORKER_MODEL",
      "SANDCASTLE_CODEX_EFFORT",
    ]) {
      expect(envExample).toContain(key);
    }

    // Both provider env blocks — switching provider must not require re-init.
    expect(envExample).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    expect(envExample).toContain("OPENAI_KEY=");

    // Issue tracker env still appended
    expect(envExample).toContain("GH_TOKEN=");
  });

  it("keeps the single-agent .env.example for non-selectable templates", async () => {
    const dir = await runScaffold({ templateName: "simple-loop" });
    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    expect(envExample).not.toContain("OPENAI_KEY=");
    expect(envExample).not.toContain("SANDCASTLE_AGENT");
  });
});

// ---------------------------------------------------------------------------
// main file seeding + rewrite behavior
// ---------------------------------------------------------------------------

describe("providerSelectable scaffold — main file", () => {
  it("seeds the claude default agent and skips the factory rewrite", async () => {
    const dir = await runScaffold({
      templateName: "parallel-planner",
      model: "claude-opus-4-8",
    });

    const main = await readMain(dir);
    expect(main).toContain('DEFAULT_AGENT = "claude" as AgentName');
    // The config section still references both factories verbatim — the
    // blanket agent rewrite must not have clobbered them.
    expect(main).toContain("sandcastle.claudeCode(");
    expect(main).toContain("sandcastle.codex(");
    // Provider selection is resolved via createAgent, not rewritten factories.
    expect(main).toContain('createAgent("planner")');
    expect(main).toContain('createAgent("worker")');
    // No unresolved template tokens.
    expect(main).not.toContain("{{DEFAULT_AGENT}}");
  });

  it("seeds the codex default agent when codex is selected at init", async () => {
    const dir = await runScaffold({
      templateName: "parallel-planner",
      agent: codexAgent,
      model: "gpt-5.4",
    });

    const main = await readMain(dir);
    expect(main).toContain('DEFAULT_AGENT = "codex" as AgentName');
    expect(main).toContain('DEFAULT_PLANNER_MODEL = "gpt-5.4"');
    expect(main).toContain('DEFAULT_WORKER_MODEL = "gpt-5.4"');
  });

  it("does not rewrite the factories when a non-claude/codex agent is selected", async () => {
    const dir = await runScaffold({
      templateName: "parallel-planner",
      agent: piAgent,
      model: "claude-sonnet-4-6",
    });

    const main = await readMain(dir);
    // Falls back to the claude seed; no pi factory is injected.
    expect(main).toContain('DEFAULT_AGENT = "claude" as AgentName');
    expect(main).not.toContain("pi(");
  });

  it("rewrites docker to podman across factories, imports, and spawn strings", async () => {
    const dir = await runScaffold({
      templateName: "parallel-planner",
      sandboxProvider: getSandboxProvider("podman"),
    });

    const main = await readMain(dir);
    // The import subpath, the factory calls, and the dependency-image
    // inspection CLI are all rewritten.
    expect(main).toContain('from "@ai-hero/sandcastle/sandboxes/podman"');
    expect(main.match(/sandbox: podman\(\)/g)).toHaveLength(3);
    expect(main).toContain('spawnSync("podman"');
    expect(main).not.toContain("docker");
  });

  it("keeps the docker provider untouched when docker is selected", async () => {
    const dir = await runScaffold({
      templateName: "parallel-planner",
      sandboxProvider: getSandboxProvider("docker"),
    });

    const main = await readMain(dir);
    expect(main).toContain('"@ai-hero/sandcastle/sandboxes/docker"');
    expect(main).toContain('spawnSync("docker"');
  });

  it("rewrites main.mts references to main.ts when package.json has type module", async () => {
    const dir = await runScaffold(
      { templateName: "parallel-planner" },
      undefined,
      { name: "test", type: "module" },
    );

    const main = await readMain(dir, "main.ts");
    expect(main).not.toContain("main.mts");
    expect(main).toContain("main.ts");
    expect(main).toContain('DEFAULT_AGENT = "claude" as AgentName');
  });

  it("scaffolds the orchestration safety checks and dependency-image check", async () => {
    for (const templateName of [
      "parallel-planner",
      "parallel-planner-with-review",
    ]) {
      const dir = await runScaffold({ templateName });
      const main = await readMain(dir);

      // Safety checks
      expect(main).toContain("requireCleanWorktree");
      expect(main).toContain("--porcelain=v1");
      expect(main).toContain("requireCompletedRun");
      expect(main).toContain("branchWasMerged");
      expect(main).toContain("countUnmergedCommits");
      expect(main).toContain("superRefine");
      // Completion-signal gate wired into every phase
      expect(main).toContain('requireCompletedRun("planner"');
      expect(main).toContain('requireCompletedRun("merger"');
      // Cancellation
      expect(main).toContain("signal: runSignal");
      expect(main).toContain('process.once("SIGINT"');
      expect(main).toContain('process.once("SIGTERM"');
      // Dependency-image stale detection (opt-in via the label)
      expect(main).toContain("sandcastle.dependency-lock.sha256");
      expect(main).toContain("DEPENDENCY_LOCK_SHA256");
      expect(main).toContain("defaultImageName(process.cwd())");
    }
  });

  it("keeps the review pipeline gates in parallel-planner-with-review", async () => {
    const dir = await runScaffold({
      templateName: "parallel-planner-with-review",
    });

    const main = await readMain(dir);
    expect(main).toContain("sandcastle.createSandbox");
    expect(main).toContain("implement.commits.length > 0");
    expect(main).toContain("const review = await sandbox.run");
    expect(main).toContain("[...implement.commits, ...review.commits]");
    // Reviewer gate excludes (not aborts) on a missing signal
    expect(main).toContain("reviewer finished without its completion signal");
  });
});

// ---------------------------------------------------------------------------
// Prompt files
// ---------------------------------------------------------------------------

describe("providerSelectable scaffold — prompt files", () => {
  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s plan-prompt mandates the branch convention and the completion signal",
    async (templateName) => {
      const dir = await runScaffold({ templateName });
      const prompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("sandcastle/issue-{id}");
      expect(prompt).toContain("rejected by schema validation");
      expect(prompt).toContain("<promise>COMPLETE</promise>");
    },
  );

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s merge-prompt uses --no-ff and skips already-merged branches",
    async (templateName) => {
      const dir = await runScaffold({ templateName });
      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git merge <branch> --no-ff --no-edit");
      expect(prompt).toContain("already up to date");
    },
  );
});

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

describe("providerSelectable next steps", () => {
  it("lists the provider-selection knobs for planner templates", () => {
    const lines = getNextStepsLines(
      "parallel-planner",
      "main.mts",
      getIssueTracker("github-issues")!,
      claudeCodeAgent,
      "npm",
    );
    const joined = lines.join("\n");
    expect(joined).toContain("SANDCASTLE_AGENT=claude|codex");
    expect(joined).toContain("SANDCASTLE_CLAUDE_PLANNER_MODEL");
    expect(joined).toContain("SANDCASTLE_CLAUDE_WORKER_MODEL");
    expect(joined).toContain("SANDCASTLE_CODEX_PLANNER_MODEL");
    expect(joined).toContain("SANDCASTLE_CODEX_WORKER_MODEL");
    expect(joined).toContain("SANDCASTLE_CODEX_EFFORT=low|medium|high|xhigh");
    expect(joined).toContain(".sandcastle/.env wins");
  });

  it("does not mention the knobs for non-selectable templates", () => {
    const lines = getNextStepsLines(
      "simple-loop",
      "main.mts",
      getIssueTracker("github-issues")!,
      claudeCodeAgent,
      "npm",
    );
    expect(lines.join("\n")).not.toContain("SANDCASTLE_AGENT");
  });
});
