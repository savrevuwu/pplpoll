#!/usr/bin/env bash
# Local dev helper: make sure the local Postgres cluster is up, then run the full test suite.
set -euo pipefail
if command -v pg_lsclusters >/dev/null && ! pg_lsclusters | grep -q online; then
  pg_ctlcluster 16 main start
fi
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://pplpoll:pplpoll@localhost:5432/pplpoll_test}"
exec pnpm test "$@"
