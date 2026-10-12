# Math Helper AI Bot

A Telegram group bot that solves math problems. Send a photo of the problem, mention the bot in the caption (optionally with a question in Uzbek), and it replies in the thread with a step-by-step solution **in Uzbek**, with graphs and diagrams where they help.

- **Runtime:** Supabase Edge Function (Deno / TypeScript)
- **AI:** Claude (`claude-opus-5-5`) with vision, adaptive thinking and the server-side code execution tool. Claude uses the tool to check calculations with sympy and to draw figures with matplotlib.
- **DB:** Supabase Postgres, table `requests`, used for the usage log, per-user hourly rate limit and de-duplication of Telegram retries

## How members use it
| In the group | What happens |
|---|---|
| Photo + caption `@MathHelperBot 3-masalani yeching` | Solves problem 3 from the photo |
| Reply to any photo with `@MathHelperBot` (+ optional question) | Solves the replied-to photo |
| `@MathHelperBot 2x + 3 = 11` | Solves the text problem |
| Reply to any of the bot's answers (no mention needed) | Follow-up in the same conversation, e.g. "soddaroq tushuntir" |
| Private chat with the bot | Every message is a question |
| `@MathHelperBot` alone, `/help`, `/start` | Shows usage help |

## Setup

1. **Create the bot.** In [@BotFather](https://t.me/BotFather), run `/newbot`.
   - Then run `/setprivacy` → choose the bot → **Disable**.
   - Without this the bot does not receive group messages that mention it. Making the bot a group admin also works.
2. **Configure secrets.**
   ```bash
   cp .env.example .env   # fill in the values
   ```
3. **Deploy to Supabase.**
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push                                   # creates the requests table
   supabase secrets set --env-file .env
   supabase functions deploy telegram-bot --no-verify-jwt
   ```
4. **Register the webhook.**
   ```bash
   ./scripts/set-webhook.sh                           # uses SUPABASE_PROJECT_REF from .env
   ```
   The `getWebhookInfo` output should show your URL with no `last_error_message`.
5. **Add the bot to your group.**

## Development
```bash
cd supabase/functions/telegram-bot
deno test          # unit tests: trigger detection, message splitting
deno check *.ts    # type-check
```
To run the function locally against a test bot:
1. Run `supabase start` and `supabase functions serve telegram-bot --no-verify-jwt --env-file .env`.
2. Expose port 54321 with a tunnel such as `ngrok`.
3. Point the webhook at `https://<tunnel>/functions/v1/telegram-bot`.

## Admin panel (inside Telegram)
Only chats an admin has approved can use the bot, so strangers can't spend your API credits.

1. Set `ADMIN_USER_IDS` to your Telegram user id. You can get it from @userinfobot.
2. Open a private chat with the bot and send `/start`. Bots can't message you first, so this step is required for approval requests to reach you.

| What happens | Result |
|---|---|
| Someone adds the bot to a group, or a stranger writes to it in private | The chat is **pending**. The bot says once a day that it's awaiting approval, and you get a message with **✅ Ruxsat berish / ⛔ Bloklash** buttons |
| You approve | The bot announces itself in the group and starts answering |
| You block | The bot says it's been switched off there and then ignores the chat. A blocked group that re-adds the bot gets no reply |
| An admin adds the bot, or uses it in a new chat | Approved automatically |
| `/groups` (admins, private chat) | Lists every chat with its status and solved problems over 7 days, plus buttons to approve or block. Pages hold 8 chats |
| The group is upgraded to a supergroup (its id changes) | The approval carries over automatically |

## Configuration
| Secret | Default | Purpose |
|---|---|---|
| `RATE_LIMIT_PER_HOUR` | 10 | Per-user limit. Failed requests don't count against the user |
| `DAILY_REQUEST_LIMIT` | 300 | Global 24h cap across all chats |
| `ADMIN_USER_IDS` | *(none)* | Comma-separated Telegram user ids allowed to approve/block chats. **Required:** with no admins, every new chat stays pending |
| `SOLVE_TIMEOUT_SECONDS` | 120 | When to give up and tell the user. Keep it below the wall-clock limit |

## Solution sheets
Claude answers a problem with a typeset image in the style of Abdulaziz's Milliy sertifikat solution sheets. The image has a question box with a topic tag, a redrawn figure and the A–D options, then numbered steps with formulas, and a "Javob" box with the correct option highlighted. A one-line answer goes underneath as the caption.

How it works:
1. `sandbox/render_solution.py` is a small typesetter built on matplotlib's TeX-style math engine with Computer Modern fonts. It runs inside Claude's code execution sandbox, which has no LaTeX.
2. Claude writes the solution as JSON, redraws any graph from the question, and runs the script.
3. The bot sends the resulting `yechim-N.png` pages as a photo, or as an album when there is more than one page. It keeps the JSON as the text of the answer, so follow-up questions have context.
4. Short chat, such as thanks or a quick clarification, gets a plain text answer.

After editing anything in `sandbox/`, upload it again:
```bash
deno run -A scripts/upload-sandbox-assets.ts
```
The bot always uses the newest upload of each file, found by file name, so there is nothing to reconfigure. If the files are ever missing, the bot answers in plain text instead of failing.
To preview the renderer locally (with matplotlib 3.10 installed), run `SOLUTION_FONTS=sandbox/fonts python sandbox/render_solution.py solution.json out/`.

## Notes
- **Figures:** Claude saves PNGs to `$OUTPUT_DIR` in its sandbox and places `[[RASM:name.png]]` markers in the answer. The bot sends text and photos in that order, then deletes the files from the Anthropic Files API. Code execution includes 1,550 free container-hours per month, then $0.05/hour.
- **Timeouts:** the function returns 200 to Telegram immediately and solves the problem in the background with `EdgeRuntime.waitUntil`.
  - Background work is bounded by the Edge Function wall-clock limit: 150s on the free plan, 400s on paid.
  - Claude runs at `effort: "medium"` so it stays well within that limit. Raise it in `solver.ts` for harder problems if you're on a paid plan.
- **Refusal fallback:** requests opt into Anthropic's server-side refusal fallback (`fallbacks: "default"`). If Claude's safety classifiers decline a request, the API retries it on a recommended fallback model. To disable this, remove `betas` and `fallbacks` in `solver.ts`.
- **Model:** set with the `CLAUDE_MODEL` secret (default `claude-opus-5-5`). On a 21-problem test (18 real Milliy sertifikat problems from Abdulaziz's channel plus 3 physics problems), Haiku 5.5, Sonnet 5.5 and Opus 5.5 all scored 21/21. Haiku costs about 1/18 as much, so production runs on Haiku. To switch back: `supabase secrets set CLAUDE_MODEL=claude-opus-5-5`.
- **Cost:** each request's real cost is stored in `requests.cost_usd`; see the `daily_costs` view. You can also check usage with `select date(created_at), count(*), sum(input_tokens), sum(output_tokens) from requests group by 1 order by 1 desc;`.
  - Lower `RATE_LIMIT_PER_HOUR` to cap spend.
