---
"@ai-hero/sandcastle": minor
---

Make the `parallel-planner` and `parallel-planner-with-review` templates provider-selectable: the scaffolded `main.ts` reads `SANDCASTLE_AGENT` at runtime and switches between Claude Code and Codex, with per-role model knobs (`SANDCASTLE_{CLAUDE,CODEX}_{PLANNER,WORKER}_MODEL`) and `SANDCASTLE_CODEX_EFFORT`. The scaffolded image installs both CLIs, so switching provider needs no re-init or rebuild; `init --agent` / `--model` now seed the template defaults instead of rewriting the agent factory. Both templates also inline orchestration safety checks: a clean-worktree precheck each round, hardened plan schema (unique issue ids, `sandcastle/issue-<id>` branch convention), completion-signal gates (unfinished workers are excluded from the merge set, a missing planner/merger signal aborts), `--no-ff` merge gating with already-merged detection, and `Ctrl+C` cancellation that aborts in-flight runs and removes containers.
