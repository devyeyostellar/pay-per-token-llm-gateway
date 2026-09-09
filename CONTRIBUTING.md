# Contributing to x402 LLM Gateway

Welcome! This guide will help you pick up an issue, set up your environment, and get a PR merged — whether you're here for a Stellar Wave bounty, a GrantFox payout, or just want to build on Stellar.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Picking Up an Issue (Bounties)](#picking-up-an-issue-bounties)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Commit Convention](#commit-convention)
- [Testing](#testing)
- [Pull Request Checklist](#pull-request-checklist)
- [Troubleshooting](#troubleshooting)
- [Getting Help](#getting-help)

---

## Code of Conduct

Be respectful, constructive, and collaborative. Harassment, spam, or disruptive behavior will result in removal from the project.

---

## Picking Up an Issue (Bounties)

All bounty-eligible issues are labeled:

| Label                               | Meaning                                     |
| ----------------------------------- | ------------------------------------------- |
| `Stellar Wave`                      | Eligible for Drips Wave contribution points |
| `GrantFox OSS`                      | Eligible for GrantFox escrow payouts        |
| `Maybe Rewarded`                    | Maintainer may allocate a reward on merge   |
| `good first issue`                  | Suitable for new contributors               |
| `priority:high` / `priority:medium` | Importance level                            |

### How to claim a bounty issue

1. **Find an unassigned issue** — filter by `Stellar Wave` + `GrantFox OSS` labels.
2. **Comment on the issue** with "I'd like to work on this" — a maintainer will assign you within 24 hours.
3. **Fork the repo** and create a branch named `issue/NNN-short-description` (e.g., `issue/47-remove-dead-models`).
4. **Work on the fix** — keep it focused on the issue's acceptance criteria.
5. **Open a PR** — reference the issue number in the description (e.g., "Closes #47").
6. **Pass CI** — all jobs must be green before review.
7. **Address review feedback** — once approved and merged, the bounty is considered complete.

> **Note:** Issues are first-come, first-assigned. If an issue is already assigned, check other open issues or ask in the issue comments if you can help.

### Point / reward model

| Complexity  | Points | Typical scope                                                       |
| ----------- | ------ | ------------------------------------------------------------------- |
| **High**    | 200    | Multi-file, cross-package features (e.g., wiring escrow settlement) |
| **Medium**  | 150    | Single-module features or non-trivial fixes                         |
| **Trivial** | 100    | Small, well-scoped fixes (e.g., removing dead code, fixing a field) |

---

## Development Setup

### Prerequisites

| Tool           | Minimum version | Check                                                |
| -------------- | --------------- | ---------------------------------------------------- |
| **Node.js**    | ≥ 20            | `node --version`                                     |
| **pnpm**       | ≥ 9             | `pnpm --version`                                     |
| **PostgreSQL** | ≥ 16            | `psql --version`                                     |
| **Redis**      | ≥ 7             | `redis-cli --version`                                |
| **Rust**       | stable          | `rustc --version` (only needed for contract changes) |
| **Docker**     | ≥ 24            | `docker --version` (recommended for infra)           |

### Step-by-step setup

```bash
# 1. Fork and clone
git clone https://github.com/YOUR_USERNAME/pay-per-token-llm-gateway.git
cd pay-per-token-llm-gateway

# 2. Install dependencies
pnpm install

# 3. Generate Prisma client
pnpm nx run database:generate

# 4. Copy and configure environment
cp .env.example .env
# Generate a real JWT_SECRET:
openssl rand -base64 32
# Paste the output into .env as JWT_SECRET=<output>
# ⚠️ The gateway refuses to start without a valid JWT_SECRET.

# 5. Start PostgreSQL and Redis (choose one):
# Option A — Docker (recommended for isolation):
docker compose -f infrastructure/docker/docker-compose.yml up -d postgres redis

# Option B — local services:
# Ensure PostgreSQL and Redis are running on their default ports.

# 6. Push the database schema
pnpm nx run database:push

# 7. Verify everything builds
pnpm exec nx run-many --target=build --all
```

### Running the dev servers

```bash
# Gateway (http://localhost:3000)
pnpm dev:gateway

# Dashboard (http://localhost:3001) — in a separate terminal
pnpm dev:dashboard
```

---

## Project Structure

```
x402-llm-gateway/
├── apps/
│   ├── gateway/              # NestJS reverse proxy (the core server)
│   │   └── src/modules/      # proxy, x402, payments, routes, providers, analytics, admin, webhooks, auth
│   └── dashboard/            # Next.js provider management UI
├── contracts/                # Soroban smart contracts (Rust)
│   ├── payment-verifier/     # On-chain payment recording
│   ├── credit-escrow/        # Prepaid credit balances
│   └── multisig/             # M-of-N payout wallet security
├── packages/                 # 12 shared libraries (@x402/*)
│   ├── types/                # TypeScript type definitions
│   ├── x402-core/            # Quote generation, payment verification, replay protection
│   ├── sdk/                  # Client SDK (402 → pay → retry)
│   ├── config/               # Centralized configuration with env validation
│   ├── logger/               # Structured logging (text + JSON)
│   ├── validation/           # Zod schemas for request validation
│   ├── database/             # Prisma client, schema, and migrations
│   ├── wallet/               # Stellar wallet utilities
│   ├── authentication/       # Wallet challenge-response auth
│   ├── analytics/            # Usage & revenue analytics service
│   ├── notifications/        # Email/webhook/in-app notification delivery
│   ├── shared/               # General utilities (ID generation, timestamps)
│   └── ui/                   # Shared UI utilities
├── infrastructure/docker/    # Dockerfiles + compose
├── .github/workflows/        # CI, deploy, and Vercel pipelines
└── scripts/                  # Build, deploy, and verification scripts
```

**Key relationships:**

- `apps/gateway` depends on nearly all `packages/*`
- `apps/dashboard` depends on `packages/types`, `packages/config`, `packages/ui`
- `packages/sdk` depends on `packages/wallet`, `packages/types`
- Contracts are self-contained Rust crates with no workspace dependencies

---

## Development Workflow

### Making changes

1. **Create a branch** from `main`:

   ```bash
   git checkout -b issue/47-remove-dead-models
   ```

2. **Make your changes** — follow the existing code style:
   - TypeScript strict mode
   - NestJS modules follow single-responsibility
   - Use existing helpers from `@x402/*` packages instead of reimplementing
   - Prefer Zod schemas (in `@x402/validation`) for request validation

3. **Run lint** on your changed packages:

   ```bash
   pnpm exec nx lint <project-name>
   ```

4. **Run tests** on your changed packages:

   ```bash
   pnpm exec nx test <project-name>
   ```

5. **Commit** using Conventional Commits (see below).

### Pre-push hooks

The Husky pre-push hook runs automatically:

- **Lint** — all 15 projects
- **Unit tests** — config, wallet, x402-core, gateway (with coverage thresholds)
- **E2E tests** — gateway (33 tests, self-contained, no external services needed)

All must pass before the push succeeds. If a hook fails, fix the issue and try again.

### Environment variables

- The gateway loads `.env` from the repository root automatically (via `@x402/config`).
- Variables already in the environment (Docker, Railway, CI) take precedence over `.env`.
- `.env` is gitignored — only `.env.example` is committed.
- `NODE_ENV=test` skips JWT_SECRET validation (test suites provide their own).

---

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix      | Use for                                 |
| ----------- | --------------------------------------- |
| `feat:`     | New feature                             |
| `fix:`      | Bug fix                                 |
| `docs:`     | Documentation changes                   |
| `refactor:` | Code restructuring (no behavior change) |
| `test:`     | Adding or updating tests                |
| `chore:`    | Build, config, or tooling changes       |
| `ci:`       | CI/CD pipeline changes                  |
| `perf:`     | Performance improvement                 |
| `security:` | Security fix                            |

**Scope (optional but encouraged):**

```
feat(gateway): wire escrow settlement for metered per-token pricing
fix(contracts): clamp unbounded limit in paginated queries
```

**Examples:**

```
feat: implement email notification channel with nodemailer
fix: re-validate upstream DNS at request time to prevent DNS rebinding SSRF
test(contracts): add invariant tests for credit-escrow token balance equation
chore: remove unused Session and ApiKey Prisma models
```

---

## Testing

### Running tests

```bash
# All unit tests
pnpm test

# Specific package
pnpm exec nx test gateway
pnpm exec nx test config
pnpm exec nx test wallet
pnpm exec nx test x402-core

# E2E tests (self-contained, no Postgres/Redis needed)
pnpm exec nx run gateway:test:e2e

# Soroban contracts
cd contracts/payment-verifier && cargo test
cd contracts/credit-escrow && cargo test
cd contracts/multisig && cargo test
```

### Writing tests

- Gateway tests use Jest with mocked Prisma and Redis (see existing `.spec.ts` files).
- E2E tests use `@nestjs/testing` with `Test.createTestingModule` — they mock the database layer and are fully self-contained.
- Contract tests use `#[cfg(test)]` modules with the Soroban SDK test utilities.
- Coverage thresholds are enforced in CI. Don't lower them — add tests to cover new code.

### Test environment

- Unit tests: `NODE_ENV=test` — no real database or Redis needed.
- E2E tests: `NODE_ENV=test` — mocks `@x402/database` and Redis, no services required.
- Contract tests: `cargo test` with Soroban test framework.

---

## Pull Request Checklist

Before opening a PR, confirm:

- [ ] Branch is named `issue/NNN-short-description` (or `feat/short-description` for non-issue changes)
- [ ] Changes are focused — one issue per PR, no unrelated refactors
- [ ] Tests pass locally (`pnpm exec nx test <project>` for each changed project)
- [ ] Lint passes (`pnpm exec nx lint <project>`)
- [ ] E2E tests pass (`pnpm exec nx run gateway:test:e2e`)
- [ ] Commit messages follow Conventional Commits
- [ ] New code has tests (at minimum, unit tests covering the happy path)
- [ ] Documentation is updated if the API or behavior changed
- [ ] No new lint warnings introduced
- [ ] PR description references the issue number (e.g., "Closes #47")

### After opening

- CI will run the full suite (lint → test → build → e2e → contracts → security scan).
- A maintainer will review within 48 hours.
- Address review feedback promptly — stale PRs may be unassigned after 14 days of inactivity.

---

## Troubleshooting

### `pnpm install` fails with "Unsupported engine"

Make sure you're using Node.js ≥ 20:

```bash
node --version  # should be v20.x.x or later
```

### `prisma generate` fails with "Can't reach database server"

This is expected — `prisma generate` only needs the schema file, not a running database. If it still fails, check that `packages/database/prisma/schema.prisma` exists.

### Gateway fails to start with "JWT_SECRET is missing"

Make sure `.env` exists at the repo root and contains a valid `JWT_SECRET` (not a placeholder). Generate one:

```bash
openssl rand -base64 32
```

### Tests fail with "Cannot find module '@x402/database'"

Run `pnpm nx run database:generate` to build the Prisma client. Nx may need to be aware of the dependency:

```bash
pnpm nx run database:generate
pnpm exec nx test gateway
```

### Pre-push hook takes too long

The pre-push hook runs lint + unit tests + e2e. To skip it temporarily (not recommended):

```bash
git push --no-verify
```

Note: CI will still run and must pass before your PR can merge.

### E2E tests fail with port conflict

The E2E suite starts an in-memory NestJS server on a random port — no port conflict should occur. If you see `EADDRINUSE`, check that nothing else is holding port 0 or that a previous test run didn't leave a process behind:

```bash
lsof -ti:3000 | xargs kill -9  # if the dev server is still running
```

---

## Getting Help

- **Issue comments** — Ask questions on the specific issue you're working on.
- **Discussions** — For broader questions, open a [GitHub Discussion](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/discussions).
- **Security vulnerabilities** — Do NOT open a public issue. [Report privately](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/security/advisories/new).

---

_Thank you for contributing to the x402 LLM Gateway — every PR helps build the permissionless AI access layer on Stellar._
