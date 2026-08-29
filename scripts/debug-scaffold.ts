/**
 * Scaffold-only helper for manual smoke runs: scaffolds the parallel-planner
 * template into <target-dir> with the codex agent and prints the path.
 * (Executing the scaffold is done from the shell — the sandboxed node
 * subprocess environment here can't spawn git/cmd.)
 */
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  scaffold,
  getAgent,
  getIssueTracker,
  getSandboxProvider,
} from "../src/InitService.js";

const repo = resolve(process.argv[2] ?? ".smoke-repo");
await mkdir(repo, { recursive: true });

await Effect.runPromise(
  scaffold(repo, {
    agent: getAgent(process.argv[3] ?? "codex")!,
    model: process.argv[4] ?? "gpt-5.4",
    templateName: process.argv[5] ?? "parallel-planner",
    issueTracker: getIssueTracker("beads")!,
    sandboxProvider: getSandboxProvider(process.argv[6] ?? "docker")!,
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

console.log(repo);
