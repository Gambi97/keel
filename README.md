# create-serverless-app

Generate and bootstrap a production-shaped serverless infrastructure in one
command, with **only Node.js installed**. No Terraform, no `scw`, no `gh` CLI
required on your machine.

```sh
npx create-serverless-app
```

Answer a few questions and you get a **public GitHub repository** containing
Terraform + GitHub Actions that provision, on the first push to `main`:

- a **Scaleway Serverless Container** (scale-to-zero compute for your app)
- a **Scaleway Serverless SQL Database** (Postgres), one per environment
- a **private container registry** for your images
- two isolated environments: **staging** and **prod**

The tool itself only performs the bootstrap: it creates the Terraform state
bucket on Scaleway, the GitHub repository with its CI secrets and variables,
and the Infisical project with placeholder secrets. The first
`terraform apply` runs in GitHub Actions, not on your machine.

## Prerequisites

You need accounts and credentials, not local tooling:

| Service | What you need |
|---|---|
| Local machine | Node.js >= 18 and `git` |
| [Scaleway](https://www.scaleway.com) | API key (access + secret), project ID, organization ID. Permissions to create Object Storage buckets and manage Serverless Containers, Serverless SQL and the Registry |
| [Infisical](https://infisical.com) | A Machine Identity (Universal Auth client ID + secret) allowed to create and manage a project |
| [GitHub](https://github.com) | A token with `repo` + `workflow` scopes, allowed to create repositories |

## Usage

Interactive (recommended for the first run):

```sh
npx create-serverless-app
```

Non-interactive, for scripts and CI:

```sh
export SCW_ACCESS_KEY=... SCW_SECRET_KEY=...
export SCW_DEFAULT_PROJECT_ID=... SCW_DEFAULT_ORGANIZATION_ID=...
export INFISICAL_CLIENT_ID=... INFISICAL_CLIENT_SECRET=...
export GITHUB_TOKEN=...

npx create-serverless-app --yes --name my-app --region fr-par
```

Simulate everything without touching any account:

```sh
npx create-serverless-app --dry-run --yes --name my-app
```

Run `npx create-serverless-app --help` for the full flag list (every question
has a flag, plus `--config file.json` to load answers from a file).

## What gets created, and when

**During the bootstrap (the CLI, via APIs):**

- Scaleway: one Object Storage bucket for the Terraform state (versioned).
- GitHub: a public repository with the generated code pushed to `main`,
  encrypted Actions secrets (Scaleway + Infisical credentials), Actions
  variables (bucket name, region, Infisical project), a `production`
  environment requiring manual approval, and branch protection on `main`.
- Infisical: a project with `staging` and `prod` environments, seeded with
  `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` (staging) and a `DATABASE_URL`
  placeholder per environment.

**On the first push to `main` (Terraform, in GitHub Actions):**

- Registry namespace, Container namespace, Serverless SQL Database per
  environment. The Serverless Container itself appears once you push an app
  image and set `container_image` in the tfvars.
- After each apply the pipeline writes the real database endpoint back to
  Infisical as `DATABASE_URL`.

The repository contains **infrastructure only**. Your application (with its
Dockerfile) lives wherever you want; you just push its image to the generated
registry.

## How CI/CD works in the generated repo

- **Pull request to `main`**: `terraform fmt`, `validate` and `plan` for both
  environments. Plans show up as PR checks.
- **Push / merge to `main`**: `terraform apply` on staging, then a manual
  approval gate, then `terraform apply` on prod.

## Security

- **No secret ever lands in the generated repository**: credentials go to
  GitHub Actions encrypted secrets and to Infisical, tfvars only contain
  non-sensitive values, and `backend.hcl` is git-ignored.
- The CLI never prints credentials, and the confirmation summary redacts them.
- Staging is protected by Basic Auth credentials stored in Infisical. The
  container receives `BASIC_AUTH_ENABLED=true` and your app enforces it.
- Terraform state lives in a private, versioned Scaleway bucket.

## Failure recovery

Every bootstrap step is idempotent and progress is tracked in
`.create-serverless-app.json` inside the project directory. If a run fails
halfway (network, missing permission), fix the cause and re-run the same
command: completed steps are skipped, existing resources are reused, nothing
is duplicated.

## FAQ

**How much does this cost?**
With scale-to-zero defaults and no traffic, close to zero: Serverless
Containers and Serverless SQL bill on usage, the state bucket costs cents.
You pay for what your app actually consumes.

**Can I use a custom domain?**
Not out of the box (yet). The app gets an auto-generated Scaleway URL. Add a
`scaleway_container_domain` resource to the module when you need one.

**Can I make the repository private?**
The tool creates it public by design. You can flip it to private in the repo
settings afterwards; nothing in the pipeline depends on visibility.

**Why Infisical instead of GitHub secrets for app secrets?**
CI credentials live in GitHub; application secrets (DB URL, Basic Auth) live
in Infisical so the app and Terraform read them from one place, with
per-environment separation, without redeploying the pipeline to rotate them.

**What if the npm name is taken or I want to hack on it?**
Clone this repo, `npm install && npm run build`, then `node dist/index.js`.

## Development

```sh
npm install
npm run build        # tsc -> dist/
npm test             # vitest unit tests
npm run lint         # eslint
npm run verify:templates   # render templates + terraform fmt/validate (needs terraform)
node dist/index.js --dry-run --yes --name demo   # end-to-end without accounts
```

## License

MIT
