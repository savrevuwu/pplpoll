# Local setup

Requirements: Node.js 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker.

```sh
cp .env.example .env          # then fill APP_ENCRYPTION_KEY / APP_HMAC_KEY (openssl rand -base64 32)
docker compose up -d          # Postgres 16 (+ pplpoll_test db), Redis, Mailpit
pnpm install
export $(grep -v '^#' .env | xargs)
pnpm migrate:up               # apply migrations to DATABASE_URL
# one time: create the Owner account (the Owner then makes invite codes)
OWNER_EMAIL=you@example.com OWNER_USERNAME=YourName OWNER_PASSWORD='long-password' \
  pnpm --filter @pplpoll/api owner:create
pnpm test                     # unit + integration (uses TEST_DATABASE_URL)
pnpm dev:api                  # http://localhost:3000/health
pnpm dev:web                  # http://localhost:5173
pnpm --filter @pplpoll/worker start   # background jobs (deactivation warnings/deletions, emails)
```

Checks CI runs (run them before pushing): `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build:web`.

Environments: **development** (this), **staging** and **production** are separate deployments with separate databases and secrets. Secrets come from the hosting platform's secret store, never from committed files. Hosting provider is not chosen yet.
