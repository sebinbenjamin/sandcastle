// Parallel Planner — three-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):    The planner agent analyzes open issues, builds a
//                      dependency graph, and outputs a <plan> JSON listing
//                      unblocked issues with their target branch names.
//   Phase 2 (Execute): N worker agents run in parallel via Promise.allSettled,
//                      each working a single issue on its own branch.
//   Phase 3 (Merge):   A worker agent merges all branches that produced
//                      commits and closes their issues.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Agent selection is provider-selectable: the planner and workers resolve
// their agent provider at start-up from SANDCASTLE_AGENT (claude|codex) and
// per-role model env vars. The scaffolded sandbox image installs both agent
// CLIs, so switching provider is a .sandcastle/.env edit — no image rebuild.
//
// The loop is hardened with host-side safety checks: the host worktree must
// be clean before each round, the <plan> output is validated against the
// sandcastle/issue-<id> branch convention, every phase must emit its
// completion signal, already-merged branches are never re-merged, and
// Ctrl-C aborts cleanly with sandbox cleanup.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as sandcastle from "@ai-hero/sandcastle";
import {
  buildImage,
  defaultImageName,
  docker,
} from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Plan schema
// ---------------------------------------------------------------------------

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
//
// Beyond the basic shape, two invariants the orchestration depends on are
// enforced here: issue ids are unique (a duplicated id would double-work one
// issue), and every branch follows the sandcastle/issue-<id> convention so
// re-planning the same issue always lands on the same branch and accumulated
// progress is preserved (see plan-prompt.md). A plan that violates either is
// rejected and the loop aborts.
const plannedIssueSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    branch: z.string().min(1),
  })
  .superRefine((issue, context) => {
    if (issue.branch !== `sandcastle/issue-${issue.id}`) {
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: `Branch must be sandcastle/issue-${issue.id}.`,
      });
    }
  });

const planSchema = z.object({
  issues: z.array(plannedIssueSchema).superRefine((issues, context) => {
    const seenIds = new Set<string>();
    for (const [index, issue] of issues.entries()) {
      if (seenIds.has(issue.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Issue ${issue.id} appears more than once.`,
        });
      }
      seenIds.add(issue.id);
    }
  }),
});

// ---------------------------------------------------------------------------
// Agent configuration (provider-selectable)
// ---------------------------------------------------------------------------
//
// The agent provider and per-role models are read once at start-up from
// .sandcastle/.env (wins) or the process env:
//
//   SANDCASTLE_AGENT                 "claude" | "codex"
//   SANDCASTLE_CLAUDE_PLANNER_MODEL  planner model when running Claude
//   SANDCASTLE_CLAUDE_WORKER_MODEL   worker model when running Claude
//   SANDCASTLE_CODEX_PLANNER_MODEL   planner model when running Codex
//   SANDCASTLE_CODEX_WORKER_MODEL    worker model when running Codex
//   SANDCASTLE_CODEX_EFFORT          low | medium | high | xhigh
//
// The DEFAULT_* values below were seeded by `sandcastle init` from the
// --agent / --model choices. Set the env keys to override per role — no
// rebuild needed, the change takes effect on the next run.

type AgentName = "claude" | "codex";
type AgentStage = "planner" | "worker";
type CodexEffort = "low" | "medium" | "high" | "xhigh";

type AgentConfiguration = {
  readonly name: AgentName;
  readonly claudePlannerModel: string;
  readonly claudeWorkerModel: string;
  readonly codexPlannerModel: string;
  readonly codexWorkerModel: string;
  readonly codexEffort: CodexEffort;
};

type Environment = Readonly<Record<string, string | undefined>>;

// Cast: `sandcastle init` substitutes these tokens with the init-selected
// --agent / --model choices; the placeholders must still typecheck before
// substitution.
const DEFAULT_AGENT = "{{DEFAULT_AGENT}}" as AgentName;
// --model seeds both role defaults of the selected provider; refine per role
// via the SANDCASTLE_*_PLANNER_MODEL / SANDCASTLE_*_WORKER_MODEL keys.
const DEFAULT_PLANNER_MODEL = "{{DEFAULT_PLANNER_MODEL}}";
const DEFAULT_WORKER_MODEL = "{{DEFAULT_WORKER_MODEL}}";

// Defaults for the provider init did not select. Claude keeps the template's
// planner/worker model split; Codex falls back to its registry default.
const CLAUDE_PLANNER_MODEL =
  DEFAULT_AGENT === "claude" ? DEFAULT_PLANNER_MODEL : "claude-opus-4-8";
const CLAUDE_WORKER_MODEL =
  DEFAULT_AGENT === "claude" ? DEFAULT_WORKER_MODEL : "claude-sonnet-4-6";
const CODEX_PLANNER_MODEL =
  DEFAULT_AGENT === "codex" ? DEFAULT_PLANNER_MODEL : "gpt-5.4";
const CODEX_WORKER_MODEL =
  DEFAULT_AGENT === "codex" ? DEFAULT_WORKER_MODEL : "gpt-5.4";
const DEFAULT_CODEX_EFFORT: CodexEffort = "high";

// Minimal .env parser: KEY=VALUE lines, '#' comments and blank lines skipped,
// one level of surrounding quotes stripped. An empty value counts as unset.
const parseEnvFile = (contents: string): Environment => {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    values[name] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
};

// A missing .sandcastle/.env is fine — only the process env applies.
const readEnvFile = (): Environment => {
  try {
    return parseEnvFile(readFileSync(".sandcastle/.env", "utf8"));
  } catch {
    return {};
  }
};

// .sandcastle/.env wins over the process env, which wins over the fallback.
const configuredValue = ({
  fileEnvironment,
  processEnvironment,
  name,
  fallback,
}: {
  readonly fileEnvironment: Environment;
  readonly processEnvironment: Environment;
  readonly name: string;
  readonly fallback: string;
}): string => fileEnvironment[name] || processEnvironment[name] || fallback;

const parseAgentName = (value: string): AgentName => {
  if (value === "claude" || value === "codex") return value;
  throw new Error(
    `SANDCASTLE_AGENT must be "claude" or "codex", received "${value}".`,
  );
};

const parseCodexEffort = (value: string): CodexEffort => {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error(
    `SANDCASTLE_CODEX_EFFORT must be low, medium, high, or xhigh, received "${value}".`,
  );
};

const readAgentConfiguration = (): AgentConfiguration => {
  const fileEnvironment = readEnvFile();
  const processEnvironment: Environment = process.env;
  return {
    name: parseAgentName(
      configuredValue({
        fileEnvironment,
        processEnvironment,
        name: "SANDCASTLE_AGENT",
        fallback: DEFAULT_AGENT,
      }),
    ),
    claudePlannerModel: configuredValue({
      fileEnvironment,
      processEnvironment,
      name: "SANDCASTLE_CLAUDE_PLANNER_MODEL",
      fallback: CLAUDE_PLANNER_MODEL,
    }),
    claudeWorkerModel: configuredValue({
      fileEnvironment,
      processEnvironment,
      name: "SANDCASTLE_CLAUDE_WORKER_MODEL",
      fallback: CLAUDE_WORKER_MODEL,
    }),
    codexPlannerModel: configuredValue({
      fileEnvironment,
      processEnvironment,
      name: "SANDCASTLE_CODEX_PLANNER_MODEL",
      fallback: CODEX_PLANNER_MODEL,
    }),
    codexWorkerModel: configuredValue({
      fileEnvironment,
      processEnvironment,
      name: "SANDCASTLE_CODEX_WORKER_MODEL",
      fallback: CODEX_WORKER_MODEL,
    }),
    codexEffort: parseCodexEffort(
      configuredValue({
        fileEnvironment,
        processEnvironment,
        name: "SANDCASTLE_CODEX_EFFORT",
        fallback: DEFAULT_CODEX_EFFORT,
      }),
    ),
  };
};

const agentConfiguration = readAgentConfiguration();

// Build the agent provider for one orchestration stage: "planner" gets the
// per-provider planner model; execution and merge share the worker model.
const createAgent = (stage: AgentStage): sandcastle.AgentProvider => {
  const isPlanner = stage === "planner";
  if (agentConfiguration.name === "claude") {
    return sandcastle.claudeCode(
      isPlanner
        ? agentConfiguration.claudePlannerModel
        : agentConfiguration.claudeWorkerModel,
    );
  }
  return sandcastle.codex(
    isPlanner
      ? agentConfiguration.codexPlannerModel
      : agentConfiguration.codexWorkerModel,
    { effort: agentConfiguration.codexEffort },
  );
};

// ---------------------------------------------------------------------------
// Orchestration safety checks
// ---------------------------------------------------------------------------
//
// These run on the host so a bad precondition stops the loop cleanly instead
// of letting agents build on unknown state.

// Run git on the host repo, capture stdout, discard stderr. A non-zero exit
// throws — callers decide whether that is recoverable.
const gitOutput = (args: string[]): string =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const currentBranch = (): string => {
  const branch = gitOutput(["branch", "--show-current"]);
  if (branch === "") {
    throw new Error("Sandcastle requires a named Git branch (HEAD is detached).");
  }
  return branch;
};

// Clean-worktree precheck: the planner and merger phases run against the host
// working directory, so uncommitted changes would leak into their runs.
// `--untracked-files=normal` (dirs collapsed to one line) rather than `all` —
// enumerating every file of a large untracked tree (e.g. an un-ignored
// node_modules) can overflow spawnSync's buffer and fail the check outright.
const requireCleanWorktree = (): void => {
  const status = gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  if (status !== "") {
    throw new Error(
      "Sandcastle working tree is not clean. Commit or stash local changes first.",
    );
  }
};

// Completion-signal gate: a phase that ended without emitting its signal did
// not actually finish (e.g. it hit its iteration cap). Planner and merger
// failures abort the loop; worker failures exclude their issue from the merge
// set instead.
const requireCompletedRun = (
  stage: string,
  completionSignal: string | undefined,
): void => {
  if (completionSignal === undefined) {
    throw new Error(`${stage} did not emit its completion signal.`);
  }
};

// Number of commits on the issue branch that the target branch does not have.
const countUnmergedCommits = ({
  targetBranch,
  issueBranch,
}: {
  readonly targetBranch: string;
  readonly issueBranch: string;
}): number => {
  const output = gitOutput([
    "rev-list",
    "--count",
    `${targetBranch}..${issueBranch}`,
  ]);
  const count = Number(output);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Git returned an invalid commit count: ${output}`);
  }
  return count;
};

// Whether the target branch already contains the issue branch — detected via
// the merge commits the merger phase creates with --no-ff. Keeps re-runs from
// re-implementing or re-merging finished work.
const branchWasMerged = ({
  targetBranch,
  issueBranch,
}: {
  readonly targetBranch: string;
  readonly issueBranch: string;
}): boolean => {
  let issueTip: string;
  try {
    issueTip = gitOutput([
      "rev-parse",
      "--verify",
      `refs/heads/${issueBranch}`,
    ]);
  } catch {
    return false; // branch does not exist (never created, or cleaned up)
  }
  const mergeCommits = gitOutput([
    "rev-list",
    "--merges",
    "--parents",
    targetBranch,
  ]);
  return mergeCommits
    .split("\n")
    .some((line) =>
      line
        .trim()
        .split(/\s+/)
        .slice(2) // <merge-sha> <first-parent> <merged-tip...>
        .includes(issueTip),
    );
};

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------
//
// Ctrl-C (or SIGTERM) aborts every in-flight agent run via the signal passed
// to each run() below; Sandcastle's own shutdown registry then force-removes
// the containers. The signal is checked at phase boundaries too, so an
// aborted run never starts the next agent invocation.

const abortController = new AbortController();

const requestShutdown = (signalName: NodeJS.Signals): void => {
  if (abortController.signal.aborted) return;
  const reason = new Error(`Sandcastle runner received ${signalName}.`);
  console.error(`\n${reason.message} Cleaning up active sandboxes...`);
  abortController.abort(reason);
};

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

const runSignal = abortController.signal;

// ---------------------------------------------------------------------------
// Dependency image check (opt-in recipe — no-ops for the default setup)
// ---------------------------------------------------------------------------
//
// Projects using the baked-dependency recipe from the Sandcastle docs bake
// node_modules into the image and stamp it with a
// `sandcastle.dependency-lock.sha256` label. For those projects this check
// rebuilds the image automatically when package-lock.json drifts. Without
// the label (the default setup) the check skips silently, leaving the
// copyToWorktree flow untouched.

const DEPENDENCY_LOCK_LABEL = "sandcastle.dependency-lock.sha256";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// Sandcastle's derived image name — the same default the sandbox factories
// use, so no --image-name plumbing is needed.
const sandboxImageName = defaultImageName(process.cwd());

const runContainerCommand = (
  args: string[],
): { exitCode: number; stdout: string; stderr: string } => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

// sha256 of the host lockfile, or undefined when there is none — the recipe
// is npm-lockfile-based; other package managers keep the copy strategy.
const dependencyLockHash = (): string | undefined => {
  try {
    return createHash("sha256")
      .update(readFileSync("package-lock.json"))
      .digest("hex");
  } catch {
    return undefined;
  }
};

const readDependencyLabel = (): string | undefined => {
  const inspect = runContainerCommand([
    "image",
    "inspect",
    sandboxImageName,
    "--format",
    `{{index .Config.Labels "${DEPENDENCY_LOCK_LABEL}"}}`,
  ]);
  if (inspect.exitCode !== 0) return undefined; // image not built yet
  const label = inspect.stdout.trim().toLowerCase();
  return label === "" ? undefined : label;
};

const checkDependencyImage = async (): Promise<void> => {
  const expectedHash = dependencyLockHash();
  if (expectedHash === undefined) return; // no npm lockfile — recipe not in use

  // Fail fast on an unreachable daemon with actionable guidance.
  const daemon = runContainerCommand(["info", "--format", "{{.ServerVersion}}"]);
  if (daemon.exitCode !== 0) {
    throw new Error(
      `The container daemon is unreachable (exit ${daemon.exitCode}: ${daemon.stderr.trim() || "no output"}). Start Docker Desktop (or your container daemon) and retry.`,
    );
  }

  const label = readDependencyLabel();
  if (label === undefined) return; // no label — default setup, nothing to verify

  if (label === expectedHash) {
    console.log(`Dependency image '${sandboxImageName}' is current.`);
    return;
  }

  const reason = SHA256_PATTERN.test(label)
    ? `stale: package-lock.json changed since it was built`
    : `unusable: its '${DEPENDENCY_LOCK_LABEL}' label is not a sha256 hash ("${label}")`;
  console.warn(
    `Dependency image '${sandboxImageName}' is ${reason}. Rebuilding...`,
  );

  const containerfilePath = existsSync(".sandcastle/Dockerfile")
    ? ".sandcastle/Dockerfile"
    : ".sandcastle/Containerfile";
  if (!existsSync(containerfilePath)) {
    throw new Error(
      "Dependency image is stale but no .sandcastle/Dockerfile (or Containerfile) exists to rebuild from.",
    );
  }

  await buildImage(sandboxImageName, ".sandcastle", {
    // Generic option key shared by the docker and podman exports — a
    // Dockerfile and a Containerfile are the same format.
    containerfile: containerfilePath,
    buildArgs: {
      DEPENDENCY_LOCK_SHA256: expectedHash,
      AGENT_UID: String(process.getuid?.() ?? 1000),
      AGENT_GID: String(process.getgid?.() ?? 1000),
    },
  });

  const rebuilt = readDependencyLabel();
  if (rebuilt !== expectedHash) {
    throw new Error(
      `Dependency image '${sandboxImageName}' is still out of sync after a rebuild (label: ${rebuilt ?? "none"}). Check the ${containerfilePath} recipe.`,
    );
  }
  console.log(`Dependency image '${sandboxImageName}' rebuilt.`);
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

try {
  // The host's active branch — the merge target for every issue branch.
  const targetBranch = currentBranch();

  // One-shot dependency image verification before any agent runs.
  await checkDependencyImage();

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    requireCleanWorktree();
    console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

    // -------------------------------------------------------------------------
    // Phase 1: Plan
    //
    // The planning agent (deeper-reasoning planner model) reads the open issue
    // list, builds a dependency graph, and selects the issues that can be
    // worked in parallel right now (i.e., no blocking dependencies on other
    // open issues).
    //
    // It outputs a <plan> JSON block — Output.object parses and validates it.
    // -------------------------------------------------------------------------
    const plan = await sandcastle.run({
      hooks,
      sandbox: docker(),
      name: "planner",
      // One iteration is enough: the planner just needs to read and reason,
      // not write code. (Structured output requires maxIterations: 1.)
      maxIterations: 1,
      signal: runSignal,
      agent: createAgent("planner"),
      promptFile: "./.sandcastle/plan-prompt.md",
      // Extract and validate the <plan> JSON into a typed object. Throws
      // StructuredOutputError if the tag is missing, the JSON is malformed,
      // or validation fails — which aborts the loop.
      output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
    });

    requireCompletedRun("planner", plan.completionSignal);

    const issues = plan.output.issues;

    if (issues.length === 0) {
      // No unblocked work — either everything is done or everything is blocked.
      console.log("No unblocked issues to work on. Exiting.");
      break;
    }

    console.log(
      `Planning complete. ${issues.length} issue(s) to work in parallel:`,
    );
    for (const issue of issues) {
      console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
    }

    // Issue branches the target already contains skip implementation — the
    // merge phase closes their issues instead. This is what makes re-runs
    // after a crashed merger cheap: finished work is never re-implemented.
    const alreadyMergedIssues: typeof issues = [];
    const openIssues: typeof issues = [];
    for (const issue of issues) {
      if (branchWasMerged({ targetBranch, issueBranch: issue.branch })) {
        console.log(
          `  ⏭ ${issue.branch} already merged — its issue will be closed in the merge phase.`,
        );
        alreadyMergedIssues.push(issue);
      } else {
        openIssues.push(issue);
      }
    }

    // -------------------------------------------------------------------------
    // Phase 2: Execute
    //
    // Spawn one worker agent per issue, all running concurrently.
    // Each agent works on its own branch so there are no conflicts during
    // execution — merging happens in Phase 3.
    //
    // Promise.allSettled means one failing agent doesn't cancel the others.
    // -------------------------------------------------------------------------
    const settled = await Promise.allSettled(
      openIssues.map((issue) =>
        sandcastle.run({
          hooks,
          copyToWorktree,
          // Each agent starts on its own branch via branchStrategy on run().
          sandbox: docker(),
          branchStrategy: { type: "branch", branch: issue.branch },
          name: "implementer",
          // Give each agent plenty of room to implement and iterate on tests.
          maxIterations: 100,
          signal: runSignal,
          // Worker model: fast and capable enough for typical issue work.
          agent: createAgent("worker"),
          promptFile: "./.sandcastle/implement-prompt.md",
          // Prompt arguments substitute {{TASK_ID}}, {{ISSUE_TITLE}},
          // and {{BRANCH}} placeholders in implement-prompt.md before the
          // agent sees the prompt.
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        }),
      ),
    );

    // An aborted signal rejects every in-flight run — surface it immediately
    // instead of walking a partially-failed round.
    runSignal.throwIfAborted();

    // Log any agents that threw (network error, sandbox crash, etc.).
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        console.error(
          `  ✗ ${openIssues[i]!.id} (${openIssues[i]!.branch}) failed: ${outcome.reason}`,
        );
      }
    }

    // Merge candidates: implementers that emitted their completion signal and
    // produced commits. A run that hit its iteration cap without signaling is
    // treated as failed and kept out of the merge set.
    const implementedIssues = settled
      .map((outcome, i) => ({ outcome, issue: openIssues[i]! }))
      .filter(
        (
          entry,
        ): entry is {
          outcome: PromiseFulfilledResult<
            Awaited<ReturnType<typeof sandcastle.run>>
          >;
          issue: (typeof openIssues)[number];
        } =>
          entry.outcome.status === "fulfilled" &&
          entry.outcome.value.completionSignal !== undefined &&
          entry.outcome.value.commits.length > 0,
      )
      .map((entry) => entry.issue);

    // Merge gating: only branches the target does not contain yet go to the
    // merger with work attached; already-merged branches ride along so the
    // merger still closes their issues (the merge prompt skips the merge
    // itself). Together with the completion gate this prevents duplicate
    // merges on re-runs.
    const completedIssues = [...alreadyMergedIssues, ...implementedIssues].filter(
      (issue) => {
        if (branchWasMerged({ targetBranch, issueBranch: issue.branch })) {
          return true;
        }
        if (
          countUnmergedCommits({ targetBranch, issueBranch: issue.branch }) > 0
        ) {
          return true;
        }
        console.log(`  ⏭ ${issue.branch} has nothing to merge — skipping.`);
        return false;
      },
    );

    const completedBranches = completedIssues.map((i) => i.branch);

    console.log(
      `\nExecution complete. ${completedBranches.length} branch(es) to merge:`,
    );
    for (const branch of completedBranches) {
      console.log(`  ${branch}`);
    }

    if (completedBranches.length === 0) {
      // All agents ran but none made commits — nothing to merge this cycle.
      console.log("No commits produced. Nothing to merge.");
      continue;
    }

    // -------------------------------------------------------------------------
    // Phase 3: Merge
    //
    // One worker agent merges all completed branches into the current branch,
    // resolving any conflicts and running tests to confirm everything still
    // works.
    //
    // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
    // uses to know which branches to merge and which issues to close.
    // -------------------------------------------------------------------------
    const merge = await sandcastle.run({
      hooks,
      sandbox: docker(),
      name: "merger",
      maxIterations: 1,
      signal: runSignal,
      agent: createAgent("worker"),
      promptFile: "./.sandcastle/merge-prompt.md",
      promptArgs: {
        // A markdown list of branch names, one per line.
        BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
        // A markdown list of issue IDs and titles, one per line.
        ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
      },
    });

    requireCompletedRun("merger", merge.completionSignal);

    console.log("\nBranches merged.");
  }

  console.log("\nAll done.");
} catch (error) {
  // A failed precondition (dirty worktree, missing completion signal, an
  // unreachable daemon) ends the loop, but rounds that already merged are
  // finished work. Report the remedy instead of unwinding as an unhandled
  // rejection, so the run ends with the cause rather than a stack trace.
  const reason = error instanceof Error ? error.message : String(error);
  console.error(
    `\nSandcastle stopped before finishing every round.\n${reason}`,
  );
  process.exitCode = 1;
}
