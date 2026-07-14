# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What keel is

One command (`npx @gambi97/keel-cli`) from zero to a production-shaped serverless infrastructure on Scaleway: Terraform + GitHub Actions + Infisical. keel runs **once**, hands the user a repository they fully own, and never stays in the loop. It generates no application code: the user brings a Docker image.

Three opinions drive every decision; a change that violates one is wrong even if useful:

1. **Near-free to start, grow without re-architecting.** Everything scales to zero; growth is a tfvars edit reviewed in a PR.
2. **The repository is the single source of truth and holds zero secrets.** Terraform runs in CI, credentials live in GitHub encrypted secrets (CI) and Infisical (app).
3. **Infrastructure only, no framework.** keel is "a starting point, not a control plane". Never generate application code, never embed an SDK, never become something with a runtime dependency on keel.

## Working role and method

Act as a **senior platform engineer**, not a feature factory. Before designing any new capability, run it through the gratitude test: _would another platform engineer thank you for building this?_ What survives the test is work that is **recurring** (used repeatedly after day one) or **glue** (contracts other pieces dock onto) — never a one-shot task a human does in 30 minutes, and never something a specialized SaaS already does better (that becomes a documented recipe, not a module). Challenge designs adversarially before implementing; changing a recommendation after a challenge is the method working, not a failure.

Feature placement policy:

- **Scaleway-native + fits the tfvars/count rails** → opt-in flag inside keel (like `--object-storage`).
- **External SaaS integration** (auth/WorkOS, email providers) → a documented recipe; the app reads coordinates from Infisical env vars. Not keel's code.
- **Day-2 additions** (cron/jobs, etc.) → future `keel add` modules docking onto the additive contract; demand-driven, don't build ahead of demand.

## Commands

```sh
npm run build              # tsc -> dist/ (also the typecheck)
npm test                   # vitest, all suites
npx vitest run src/config.test.ts        # single file
npx vitest run -t 'renders the full'     # single test by name
npm run lint               # eslint src
npm run format:check       # prettier (CI enforces; run `npm run format` to fix)
npm run verify:templates   # render templates + terraform fmt/validate
                           # needs `terraform` on PATH or TERRAFORM_BIN=<path>; requires build first
node dist/index.js --dry-run --yes --name demo   # end-to-end without any account
```

CI runs build, lint, format:check, tests, verify:templates and a dry run on every push/PR. All must stay green.

## Architecture

This repo produces **two artifacts**, and the coupling between them is the thing to protect:

1. **The CLI** (`src/`): collects answers, renders `templates/` into a new repo, then bootstraps three providers via APIs (Scaleway state bucket, Infisical project + secrets, GitHub repo + CI wiring).
2. **The generated repository**: plain Terraform (root module + `modules/app_stack`), three workflows (plan on PR, chained gated applies on main, weekly drift detection), one Terraform **workspace per environment** with per-env `<env>.tfvars`.

Key mechanics that span multiple files:

- **Data spine**: every input source (env vars < `--config` file < flags < interactive prompts) merges into `PartialAnswers`, then `finalizeAnswers()` (`src/config.ts`) validates and freezes it into `Answers`. New features enter as: a field in `Answers`, a default, a prompt, a token. Environments are data (`ENV_DEFAULTS`/`ENV_PRESETS` tables), not branches.
- **Cross-artifact contracts** (`src/contracts.ts`): names shared between the bootstrap code and the generated repo — branch-protection contexts `plan (<slug>)`, the `infisical_secrets` Terraform output consumed by `sync-secrets.sh`, seeded secret keys, Actions secret/variable names. Both sides import these constants; `src/contracts.test.ts` renders the templates and asserts agreement. **A rename on one side only passes CI and breaks at runtime in the user's account — always go through contracts.ts.**
- **Templating** (`src/generate.ts`): plain `__TOKEN__` replacement with a leftover-token guard, plus exactly two special templates (per-env tfvars, assembled apply workflow). Hard rule documented at `SPECIAL_TEMPLATES`: a conditional feature must become a Terraform variable rendered into tfvars (`enable_object_storage` is the precedent), **never a conditionally emitted file**. If that rule ever fails, adopt a real template engine — do not add a third special case.
- **Idempotency & resume** (`src/state.ts` + `runBootstrap` step table in `src/index.ts`): every bootstrap step is find-or-create on the provider side and recorded in the git-ignored `.keel.json` inside the target dir; re-running skips completed steps. Seeded Infisical secrets are never overwritten.
- **Validate before create**: all three credentials are checked with read-only calls before anything is mutated. Provider errors are typed with a `field`/`code` so interactive prompts re-ask only the offending answer (`GitHubError`, `InfisicalError`, `ScalewayError`).
- **Security posture in the output**: dedicated least-privilege IAM application per concern (db, storage), state bucket restricted by a bucket policy to the bootstrap identity, token handed to git via ephemeral askpass, secrets sealed-boxed client-side, `terraform.workspace == var.environment` precondition guards cross-env applies.
- **CLI surface**: `CLI_OPTIONS` in `src/index.ts` is the single source for parseArgs and `--help` (`CLI_HELP`'s keys are compiler-checked against it). The README CLI reference is the one manual copy — update it when flags change.

## Releasing

Publishing runs only in CI: `npm version patch|minor` (creates the version commit + `vX.Y.Z` tag), then `git push --follow-tags`. The Release workflow refuses tag/package.json mismatches and skips already-published versions. Changes that alter the generated output's behavior or contracts are a **minor** bump, not a patch.
