#!/usr/bin/env bash
# Pushes the secrets Terraform produced to Infisical, so the application reads
# them at runtime: always DATABASE_URL (dedicated IAM credential included), plus
# the S3_* Object Storage coordinates when that feature is enabled.
# Usage: sync-secrets.sh <environment>
# Expects: INFISICAL_HOST, INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET,
#          INFISICAL_PROJECT_ID in the environment; terraform init already run.
set -euo pipefail

ENVIRONMENT="${1:?usage: sync-secrets.sh <environment>}"

SECRETS_JSON="$(terraform output -json infisical_secrets)"
if [ -z "$SECRETS_JSON" ] || [ "$SECRETS_JSON" = "null" ] || [ "$SECRETS_JSON" = "{}" ]; then
  echo "No secrets to sync."
  exit 0
fi

ACCESS_TOKEN="$(curl -sS --fail-with-body -X POST \
  "$INFISICAL_HOST/api/v1/auth/universal-auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"clientId\":\"$INFISICAL_CLIENT_ID\",\"clientSecret\":\"$INFISICAL_CLIENT_SECRET\"}" \
  | jq -r .accessToken)"
echo "::add-mask::$ACCESS_TOKEN"

sync_secret() {
  local name="$1" value="$2"
  echo "::add-mask::$value"
  local payload
  payload="$(jq -n \
    --arg workspaceId "$INFISICAL_PROJECT_ID" \
    --arg environment "$ENVIRONMENT" \
    --arg value "$value" \
    '{workspaceId: $workspaceId, environment: $environment, secretPath: "/", secretValue: $value, type: "shared"}')"
  local status
  status="$(curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
    "$INFISICAL_HOST/api/v3/secrets/raw/$name" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")"
  # PATCH updates the placeholder seeded at bootstrap; create the secret if missing.
  if [ "$status" = "404" ]; then
    curl -sS --fail-with-body -o /dev/null -X POST \
      "$INFISICAL_HOST/api/v3/secrets/raw/$name" \
      -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$payload"
  elif [ "$status" -ge 300 ]; then
    echo "Failed to update $name in Infisical (HTTP $status)" >&2
    exit 1
  fi
  echo "Synced $name to Infisical ($ENVIRONMENT)."
}

# Iterate the output map as base64-encoded {key,value} rows to survive any
# special characters in the values.
while IFS= read -r row; do
  entry="$(echo "$row" | base64 --decode)"
  name="$(echo "$entry" | jq -r '.key')"
  value="$(echo "$entry" | jq -r '.value')"
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    echo "Skipping $name (no value yet)."
    continue
  fi
  sync_secret "$name" "$value"
done < <(echo "$SECRETS_JSON" | jq -r 'to_entries[] | @base64')
