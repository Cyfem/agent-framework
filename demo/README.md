# Agent Framework Demo

The demo package has two feature-suite layers for Agent Skills and Context Compact.

## Deterministic offline suite

```bash
pnpm --filter @manee/agent-framework-demo features:offline
```

This suite does not use the network. It exercises progressive Skill disclosure, inline and file
resources/scripts, raw-versus-active context, tool payload compaction, proactive and emergency
summary transactions, and model-error recovery with programmable models.

## Ark Agent Plan integration suite

Copy `.env.example` to `.env`, fill `ARK_API_KEY`, and keep that file local. `demo/.env` is ignored
by Git; an already exported environment variable takes precedence over the file.

```bash
pnpm --filter @manee/agent-framework-demo features:ark
```

The suite uses the Agent Plan base URL (`/api/plan/v3`) and `kimi-k3` by default. It exercises both
Chat Completions and Responses without falling back between protocols. Each protocol is capped at
10 Agent iterations and a hard total of seven provider calls (one summary plus six Agent calls).
Each SDK request has a 120-second timeout; SDK retries and framework model-error retries are
disabled. One protocol still runs if the other fails. This is a real, billable network integration
test.

`pnpm test` runs the core tests, deterministic demos, and this Ark integration. It intentionally
fails when `ARK_API_KEY` is absent; use the offline command when credentials or network access are
not available.

Logs contain only scenario/phase names, tool names, message and payload lengths, status, and stable
error codes. They do not print prompts, tool payloads, response bodies, request headers, or the API
key.

## Security boundaries

- Skill scripts are trusted local code, run with the host Node.js process environment and without a
  framework sandbox, timeout, or output limit. This includes credentials such as `ARK_API_KEY`, so
  only run trusted Skill scripts.
- Inline scripts are materialized in a temporary Skill directory and cleaned up best-effort; file
  Skill scripts execute directly from their registered Skill root.
- File Skills support the framework's portable UTF-8 text subset, not arbitrary binary assets or
  host-specific filenames.
- Context Compact changes only the active model context. Raw history retains the original content
  and must be protected according to the application's data-retention requirements.

The repository also contains older Ark demos for the regular `/api/v3` and Coding Plan
`/api/coding/v3` endpoints. Their environment variables and provider capabilities are independent
from this Agent Plan suite.
