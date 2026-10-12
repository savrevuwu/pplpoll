# Local setup

Requirements: Node.js 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker.

```sh
cp .env.example .env
docker compose up -d          # Postgres 16 (+ pplpoll_test db), Redis, Mailpit
pnpm install
export $(grep -v '^#' .env | xargs)
pnpm migrate:up               # apply migrations to DATABASE_URL
pnpm test                     # unit + integration (uses TEST_DATABASE_URL)
pnpm dev:api                  # http://localhost:3000/health
pnpm dev:web                  # http://localhost:5173
```

Checks CI runs (run them before pushing): `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build:web`.

Environments: **development** (this), **staging** and **production** are separate deployments with separate databases and secrets. Secrets come from the hosting platform's secret store, never from committed files. Hosting provider is not chosen yet.
