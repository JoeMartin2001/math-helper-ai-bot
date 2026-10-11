#!/usr/bin/env bash
# Points the Telegram bot's webhook at the deployed edge function.
# Usage: SUPABASE_PROJECT_REF=abcd1234 ./scripts/set-webhook.sh   (reads secrets from .env)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

: "${SUPABASE_PROJECT_REF:?Set SUPABASE_PROJECT_REF (from your Supabase project URL)}"
# Accept either the bare ref or the full project URL.
SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF#https://}"
SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF%%.*}"
URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/telegram-bot"

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"${URL}\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\"],\"drop_pending_updates\":true}"
echo
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
echo
