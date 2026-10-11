#!/usr/bin/env bash
# Points the Telegram bot's webhook at the deployed edge function and sets the command menus.
# Usage: ./scripts/set-webhook.sh   (reads secrets from .env)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

: "${SUPABASE_PROJECT_REF:?Set SUPABASE_PROJECT_REF (from your Supabase project URL)}"
# Accept either the bare ref or the full project URL.
SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF#https://}"
SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF%%.*}"
URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/telegram-bot"
API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

post() { curl -sS "$API/$1" -H 'content-type: application/json' -d "$2"; echo; }

# message: questions; my_chat_member: bot added/removed; callback_query: admin buttons.
post setWebhook "{\"url\":\"${URL}\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"my_chat_member\",\"callback_query\"]}"

post setMyCommands '{"commands":[{"command":"help","description":"Botdan qanday foydalanish"}]}'
for id in ${ADMIN_USER_IDS//,/ }; do
  post setMyCommands "{\"scope\":{\"type\":\"chat\",\"chat_id\":${id}},\"commands\":[{\"command\":\"groups\",\"description\":\"Guruhlarni boshqarish\"},{\"command\":\"help\",\"description\":\"Botdan qanday foydalanish\"}]}"
done

curl -sS "$API/getWebhookInfo"; echo
