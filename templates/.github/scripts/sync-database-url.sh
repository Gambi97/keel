#!/usr/bin/env bash
# Pushes the freshly-applied database endpoint to Infisical as DATABASE_URL.
# Usage: sync-database-url.sh <staging|prod>
# Expects: INFISICAL_HOST, INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET,
#          INFISICAL_PROJECT_ID in the environment; terraform init already run.
set -euo pipefail

ENVIRONMENT="${1:?usage: sync-database-url.sh <staging|prod>}"

DB_ENDPOINT="$(terraform output -raw database_endpoint)"
if [ -z "$DB_ENDPOINT" ]; then
  echo "No database endpoint in outputs, skipping Infisical sync."
  exit 0
fi
echo "::add-mask::$DB_ENDPOINT"

ACCESS_TOKEN="$(curl -sS --fail-with-body -X POST \
  "$INFISICAL_HOST/api/v1/auth/universal-auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"clientId\":\"$INFISICAL_CLIENT_ID\",\"clientSecret\":\"$INFISICAL_CLIENT_SECRET\"}" \
  | jq -r .accessToken)"
echo "::add-mask::$ACCESS_TOKEN"

payload="$(jq -n \
  --arg workspaceId "$INFISICAL_PROJECT_ID" \
  --arg environment "$ENVIRONMENT" \
  --arg value "$DB_ENDPOINT" \
  '{workspaceId: $workspaceId, environment: $environment, secretPath: "/", secretValue: $value, type: "shared"}')"

# Update the placeholder seeded at bootstrap; create the secret if missing.
status="$(curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
  "$INFISICAL_HOST/api/v3/secrets/raw/DATABASE_URL" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$payload")"

if [ "$status" = "404" ]; then
  curl -sS --fail-with-body -o /dev/null -X POST \
    "$INFISICAL_HOST/api/v3/secrets/raw/DATABASE_URL" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload"
elif [ "$status" -ge 300 ]; then
  echo "Failed to update DATABASE_URL in Infisical (HTTP $status)" >&2
  exit 1
fi

echo "DATABASE_URL synced to Infisical ($ENVIRONMENT)."
