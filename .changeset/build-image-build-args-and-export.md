---
"@ai-hero/sandcastle": minor
---

Add a repeatable `--build-arg KEY=VALUE` flag to `sandcastle docker build-image` and `sandcastle podman build-image`, and give `PodmanLifecycle.buildImage` a `buildArgs` option so it matches `DockerLifecycle`. Both commands pass the default `AGENT_UID`/`AGENT_GID` alignment args on Linux/macOS, with explicit flags winning. Both sandbox subpaths (`@ai-hero/sandcastle/sandboxes/docker` and `@ai-hero/sandcastle/sandboxes/podman`) also export a promise-based `buildImage(imageName, dir, { containerfile?, buildArgs? })` for orchestration scripts — the shared `containerfile` option key keeps docker and podman interchangeable. This backs the planner templates' dependency-image stale detection, which rebuilds automatically when the image's `sandcastle.dependency-lock.sha256` label no longer matches `package-lock.json`.
