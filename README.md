# create-serverless-app

Spin up a production-shaped serverless infrastructure with one command, using
**only Node.js**. No Terraform, no `scw`, no `gh` CLI to install: everything
runs through APIs.

```sh
npx create-serverless-app
```

Answer a few questions and you get a **GitHub repository** containing
Terraform and GitHub Actions pipelines. On the first push to `main`, the
pipeline provisions on Scaleway:

- a **Serverless Container** to run your app (scales to zero when idle)
- a **Serverless SQL Database** (Postgres), one per environment
- a **private container registry** for your app images
- two isolated environments, **staging** and **prod**, with staging protected
  by Basic Auth

The tool generates **infrastructure only**: no application skeleton, no
framework opinions. Your app lives wherever you want; you just build a Docker
image and push it to the generated registry.

---

## The stack, and why

| Piece | Service | Why |
|---|---|---|
| Compute | [Scaleway Serverless Containers](https://www.scaleway.com/en/serverless-containers/) | Runs any Docker image, scales to zero, no cluster to manage. You pay only while requests are being served. EU-based provider. |
| Database | [Scaleway Serverless SQL](https://www.scaleway.com/en/serverless-sql-database/) | Real Postgres that also scales to zero. No instance sizing, no idle costs for side projects, grows with real traffic. |
| Infrastructure as code | [Terraform](https://www.terraform.io) | The whole infra is declarative, versioned and reviewable in PRs. Nothing is click-configured in a console. |
| State storage | [Scaleway Object Storage](https://www.scaleway.com/en/object-storage/) | Terraform state must live outside the repo. An S3-compatible bucket on the same provider means no extra account, versioned for safety. |
| CI/CD | [GitHub Actions](https://github.com/features/actions) | `terraform plan` on every PR, `apply` on merge. Terraform runs in CI, never on your laptop, so nobody needs local tooling or production credentials. |
| Secrets | [Infisical](https://infisical.com) | Application secrets (database URL, Basic Auth credentials) live in a dedicated secret manager with per-environment separation, not in the repo and not scattered across CI settings. Rotating a secret never requires a commit. |

The guiding idea: **the repository is the single source of truth, and it
contains zero secrets.** Anyone can read the infra; only CI can change it;
only Infisical and GitHub's encrypted store hold credentials.

---

## Prerequisites

You need three accounts and their credentials. Nothing else is installed
locally: the CLI talks to each service through its API.

**Local machine**

- Node.js >= 18
- `git`

**Scaleway** (the cloud provider)

1. Create an account and a project at [console.scaleway.com](https://console.scaleway.com).
2. Generate an API key: IAM > API keys > Generate. You need both the
   **access key** and the **secret key**.
3. Note your **project ID** and **organization ID** (Project Dashboard >
   Settings).
4. The API key needs permissions to create Object Storage buckets and to
   manage Serverless Containers, Serverless SQL Databases and the Container
   Registry (an IAM policy with `ObjectStorageFullAccess`,
   `ContainersFullAccess`, `ServerlessSQLDatabaseFullAccess` and
   `ContainerRegistryFullAccess`, or broader).

**Infisical** (the secret manager)

1. Create an account at [app.infisical.com](https://app.infisical.com), or
   use your self-hosted instance.
2. Create a **Machine Identity** with **Universal Auth** (Organization
   Settings > Machine Identities). You need its **client ID** and
   **client secret**.
3. Give the identity permission to create and manage projects (an org role
   with project creation rights).

**GitHub** (code hosting and CI)

1. Create a token at [github.com/settings/tokens](https://github.com/settings/tokens)
   with the `repo` and `workflow` scopes (classic token), or a fine-grained
   token allowed to create repositories and manage Actions secrets,
   variables, environments and branch protection.

The CLI **validates credentials before creating anything**: wrong keys fail
fast, with nothing half-created.

---

## Usage

Interactive, recommended the first time:

```sh
npx create-serverless-app
```

The CLI asks for a project name, region, credentials (environment variables
like `SCW_ACCESS_KEY` are picked up automatically as defaults), then shows a
**full summary of everything it is about to create and where**. Nothing
happens before you confirm.

Non-interactive, for scripts:

```sh
export SCW_ACCESS_KEY=... SCW_SECRET_KEY=...
export SCW_DEFAULT_PROJECT_ID=... SCW_DEFAULT_ORGANIZATION_ID=...
export INFISICAL_CLIENT_ID=... INFISICAL_CLIENT_SECRET=...
export GITHUB_TOKEN=...

npx create-serverless-app --yes --name my-app --region fr-par
```

Simulate without touching any account (generates the repo locally and prints
what a real run would do):

```sh
npx create-serverless-app --dry-run --yes --name my-app
```

Every question has a matching flag (`--help` for the full list) and answers
can also come from a JSON file with `--config answers.json`.

---

## What gets created, and when

The tool works in two phases. The CLI does the **bootstrap**; the first
pipeline run does the **provisioning**. The CLI deliberately stops before the
first `terraform apply`.

**Phase A: bootstrap (the CLI, via APIs, after your confirmation)**

| Where | What |
|---|---|
| Your machine | The generated repo: Terraform, workflows, README, initial git commit |
| Scaleway | One Object Storage bucket for Terraform state (`<name>-tfstate`, versioned) |
| GitHub | Repository (public or private, your choice) with the code pushed to `main`; encrypted Actions **secrets** (Scaleway + Infisical credentials); Actions **variables** (bucket, region, Infisical project); `staging` and `production` environments, the latter gated by manual approval; branch protection on `main` |
| Infisical | A project with `staging` and `prod` environments, seeded with `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` (staging, password randomly generated) and a `DATABASE_URL` placeholder per environment |

**Phase B: first deploy (Terraform in GitHub Actions, on push to `main`)**

| Scaleway resource | Notes |
|---|---|
| Registry namespace | Private, one per environment |
| Container namespace + Serverless Container | The container appears once you set `container_image` in the tfvars; registry and database are created right away |
| Serverless SQL Database | One per environment; after each apply the pipeline writes the real endpoint to Infisical as `DATABASE_URL` |

No custom domain is configured: the app gets an auto-generated Scaleway URL.
A domain can be added later with one `scaleway_container_domain` resource.

---

## The generated repository

```
my-app/
├── README.md                    # operating manual for the repo
├── .github/workflows/
│   ├── terraform-plan.yml       # PR: fmt + validate + plan (staging & prod)
│   └── terraform-apply.yml      # main: apply staging -> approval -> apply prod
├── versions.tf · providers.tf · backend.tf
├── backend.hcl.example          # state bucket coordinates (backend.hcl is git-ignored)
├── variables.tf · main.tf · outputs.tf
├── staging.tfvars · prod.tfvars # non-sensitive config only, committed
└── modules/app_stack/           # registry + container + database
```

Environments are separated with **Terraform workspaces** (`staging`, `prod`):
same code, two independent states in the same bucket, two `.tfvars` files for
the differences (scaling, Basic Auth on staging).

### Where every piece of data lives

| Data | Lives in | Why |
|---|---|---|
| Scaleway API keys | GitHub encrypted secrets | CI needs them to run Terraform; encrypted with the repo public key, write-only |
| Infisical machine identity | GitHub encrypted secrets | Lets Terraform read app secrets at plan/apply time |
| Basic Auth user/password | Infisical (staging) | App secret, injected into the container, rotatable without commits |
| Database connection string | Infisical (both envs) | Doesn't exist until Terraform creates the DB; the pipeline fills it in after each apply |
| Bucket name, region, Infisical project | GitHub variables | Non-sensitive wiring, visible and editable in one place |
| Project name, scaling, image | Committed tfvars | Reviewable configuration, no secrets |

---

## After the bootstrap

1. **Push to `main`** (or open a PR and merge it): the pipeline provisions
   registry and databases. Approve the `production` gate when prompted.
2. **Build and push your app image** to the registry endpoint shown in the
   apply output:

   ```sh
   docker build -t rg.fr-par.scw.cloud/my-app-staging/app:latest .
   docker push rg.fr-par.scw.cloud/my-app-staging/app:latest
   ```

3. **Set `container_image`** in `staging.tfvars` / `prod.tfvars` and open a
   PR: the next apply creates the containers.
4. **Replace the placeholder secrets** in Infisical with real values. The app
   reads `DATABASE_URL`, `BASIC_AUTH_*` from its environment; on staging it
   also receives `BASIC_AUTH_ENABLED=true` and is expected to enforce it.

---

## Security model

- **No secret ever lands in the repository**: not in the Terraform files, not
  in the tfvars, not in the workflows. `backend.hcl` and local state are
  git-ignored.
- The CLI never logs credentials and redacts them in the confirmation
  summary. The GitHub token is passed to `git push` through an ephemeral
  askpass helper, so it never appears in remote URLs, `.git/config` or the
  process list.
- GitHub Actions secrets are encrypted client-side with the repository public
  key (libsodium sealed box) before upload.
- `main` is protected: force pushes and deletion are blocked, PRs need a
  green plan. Production applies require a manual approval.
- Terraform state (which can contain sensitive values) lives in a private,
  versioned bucket, never in the repo.

## Costs

With the default scale-to-zero settings and no traffic, the monthly cost is
close to zero: Serverless Containers and Serverless SQL bill per usage, and
the state bucket is cents. Costs grow with actual traffic instead of with the
number of environments. Scaleway's pricing pages have the per-second details.

## Failure recovery and idempotency

Every bootstrap step first checks whether its resource already exists, and
progress is recorded in `.create-serverless-app.json` inside the project
directory. If a run fails halfway (network hiccup, missing permission), fix
the cause and **re-run the same command**: completed steps are skipped,
existing resources are reused, nothing is duplicated. Errors state what was
created, what was not, and how to proceed.

## FAQ

**Do I need Terraform, scw or gh installed?**
No. The CLI bootstraps via APIs; Terraform runs inside GitHub Actions.

**Can the repository be private?**
Yes. The CLI asks for the repository name and its visibility; the default is
public (the infra contains no secrets), but you can choose private
interactively or with `--private`. Nothing in the pipeline depends on
visibility.

**Why is the container not created on the first apply?**
A Serverless Container needs an image, and no image exists yet. Registry and
database are created immediately; the container is gated on
`container_image` being set, so the first apply is green instead of failing.

**Why Basic Auth "at the app level" instead of at the platform level?**
Scaleway Serverless Containers have no built-in auth layer in front of public
endpoints. The credentials live in Infisical and the container gets
`BASIC_AUTH_ENABLED=true`; a few lines of middleware in your app enforce it.

**Can I add more environments later?**
Yes: add a workspace, a `<env>.tfvars`, an Infisical environment, and mirror
one job in each workflow.

**What if something in the bootstrap already exists?**
It is reused: existing GitHub repos you can push to, existing Infisical
projects with the same name, an existing state bucket you own. Existing
secrets in Infisical are never overwritten.

## CLI reference

```
--name <name>                  Project name (dns-safe: lowercase, digits, hyphens)
--dir <path>                   Target directory (default: ./<name>)
--region <region>              fr-par | nl-ams | pl-waw (default: fr-par)
--scw-access-key <key>         or env SCW_ACCESS_KEY
--scw-secret-key <key>         or env SCW_SECRET_KEY
--scw-project-id <id>          or env SCW_DEFAULT_PROJECT_ID
--scw-organization-id <id>     or env SCW_DEFAULT_ORGANIZATION_ID
--infisical-host <url>         or env INFISICAL_HOST (default: https://app.infisical.com)
--infisical-client-id <id>     or env INFISICAL_CLIENT_ID
--infisical-client-secret <s>  or env INFISICAL_CLIENT_SECRET
--infisical-project-name <n>   Infisical project (default: project name)
--github-token <token>         or env GITHUB_TOKEN (scopes: repo, workflow)
--repo-name <name>             GitHub repository name (default: project name)
--private                      Create the repository as private (default: public)
--no-basic-auth                Disable Basic Auth on staging
--staging-min-scale <n>        Default 0        --staging-max-scale <n>   Default 1
--prod-min-scale <n>           Default 0        --prod-max-scale <n>      Default 2
--config <file.json>           Load answers from a JSON file
--advanced                     Also ask scaling questions interactively
--yes                          Accept defaults, skip the confirmation prompt
--dry-run                      Generate locally, touch no account
```

## Development

```sh
npm install
npm run build              # tsc -> dist/
npm test                   # vitest unit tests
npm run lint               # eslint
npm run verify:templates   # render templates + terraform fmt/validate (needs terraform)
node dist/index.js --dry-run --yes --name demo   # end-to-end without accounts
```

## License

MIT
