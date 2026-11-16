# Google Health MCP connector

A remote MCP server, hosted for free on Cloudflare Workers, that gives Claude
live read-only access to your Google Health data (Fitbit trackers, Pixel
Watch, the Google Health app; the successor to the Fitbit Web API): steps,
distance, calories, active zone minutes, heart rate, resting heart rate, HRV,
SpO2, respiratory rate, VO2 max, skin temperature, sleep with stages,
workouts, weight, body fat, ECG and irregular-rhythm notifications.

It is built the same way as the Withings connector: one Worker, tokens in
Cloudflare KV, a secret key in the URL, and a `/auth` link that runs the
Google login in the browser. Because Google accepts any HTTPS redirect URI,
there is no clipboard scramble; the worker receives the OAuth redirect itself.

## Files

| Path | Purpose |
| --- | --- |
| `worker/src/index.ts` | Routes, OAuth login/callback, the ten tools. Stateless MCP since 2026-11-15: every POST is answered by one shared Durable Object that writes nothing to storage (the old McpAgent made a new Durable Object per session, ~60 rows written each, and Claude Code's reconnects nearly hit the Free plan's 100,000 rows/day). |
| `worker/src/health.ts` | Google OAuth + KV token storage, REST client (auto-chunked roll-ups, pagination), data-type registry, formatters. |
| `worker/deploy.ps1` | One-shot deploy: KV namespace, secrets, deploy, write outputs, repoint Claude Code. |
| `worker/update_claude_configs.py` | Adds the remote URL to `~/.claude.json` (called by deploy). |
| `worker/deploy-output.json` | Written by the deploy: worker URL, access key, connector URL, login URL. Keep private. |
| `.env` | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (never commit; see `.env.example`). |

## One-time Google Cloud setup

Google Health data is only reachable through a Google Cloud project with the
Google Health API enabled and an OAuth client. This takes about ten minutes.

1. **Enable the API.** Open the
   [Google Health API library page](https://console.developers.google.com/apis/library/health.googleapis.com),
   create a project (or pick one) and click **Enable**.
2. **Configure the consent screen.** Google Cloud console > **APIs & Services >
   OAuth consent screen** (also called *Google Auth Platform*). App name and
   support email are enough. User type **External**. Leave the publishing
   status at **Testing**.
3. **Add yourself as a test user.** On the **Audience** page, under *Test
   users*, add the Google account that owns the health data. Unverified apps
   only work for listed test users.
4. **Add the scopes.** On the **Data Access** page click *Add or remove
   scopes*, search for "Google Health API" and tick the read-only ones:
   `activity_and_fitness.readonly`, `health_metrics_and_measurements.readonly`,
   `sleep.readonly`, `profile.readonly`, `settings.readonly`, `ecg.readonly`,
   `irn.readonly`. If `nutrition.readonly` is listed too, tick it and add it to
   `SCOPES` in `worker/wrangler.jsonc` to enable hydration and food logging.
5. **Create the OAuth client.** **Credentials > Create credentials > OAuth
   client ID**, type **Web application**. You can add the redirect URI later
   (the deploy script prints it). Copy the client ID and secret into `.env`:

   ```
   GOOGLE_CLIENT_ID=....apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

6. **Have some data.** Install the Google Health app on your phone, sign in
   with the same account, and let your tracker sync (or log something by hand).

## Deploy

```
cd worker
npm install
npx wrangler login          # once; opens a browser, free Cloudflare account
powershell -ExecutionPolicy Bypass -File deploy.ps1
```

The script prints three things at the end:

1. the **callback URL** (`https://googlehealth-mcp.<you>.workers.dev/callback`).
   Add it under *Authorized redirect URIs* on your OAuth client in the Cloud
   console and save.
2. the **login URL** (`https://<worker>/auth/<key>`). Open it in a browser, pick
   the account, click through the "unverified app" warning (Continue) and allow
   every permission. The page confirms which scopes were granted.
3. the **connector URL** (`https://<worker>/mcp/<key>`). Add it in claude.ai
   under **Settings > Connectors > Add custom connector** (name: Google
   Health). Connectors sync to the desktop chat and the phone app. Claude Code
   on this machine is pointed at it automatically.

The key in the URL is the only thing protecting your data, so treat the URL
like a password.

## Tools

| Tool | What it answers |
| --- | --- |
| `googlehealth_get_daily_summary` | "How did I do today / yesterday?" Activity, heart, vitals, body, the night's sleep, the day's workouts. |
| `googlehealth_get_daily_series` | Day-by-day rows plus stats (mean, min/max, week-over-week) for any mix of metrics. |
| `googlehealth_get_sleep` | Sleep sessions with stages, efficiency and averages. |
| `googlehealth_list_exercises` | Workouts with distance, pace, calories, heart rate zones, totals by type. |
| `googlehealth_get_intraday` | Minute-level roll-ups within a day (heart rate during a run, steps per hour). |
| `googlehealth_get_body_measurements` | Individual weigh-ins / body fat / height with a trend block. |
| `googlehealth_list_data_points` | Raw points of any readable data type (ECG, SpO2 samples, HRV, IRN, nutrition, ...). |
| `googlehealth_get_devices` | Paired trackers with battery and last sync. |
| `googlehealth_get_profile` | Identity, profile, settings (timezone and units). |
| `googlehealth_auth_status` | Is the server logged in? Granted scopes, token expiry, login link, live check. |

All tools are read-only. Dates are the user's local calendar days and times
carry the user's UTC offset; distances are reported in km and miles, weight in
kg and lb.

## How tokens work

Google access tokens last one hour; the worker refreshes them five minutes
before expiry and stores the result in KV. Google refresh tokens do not
rotate, so several clients can share the worker safely.

**Testing-mode caveat.** While the OAuth consent screen is in *Testing*,
Google issues refresh tokens that expire after **7 days**. When that happens
the tools return an error with the login link; open it and you are back in
30 seconds. `googlehealth_auth_status` shows the days left. To get
long-lived tokens, publish the app in the Cloud console (*Audience > Publish
app*). Publishing an unverified app still works for up to 100 users; Google
only shows a warning screen at login.

Logging in again also lets you change scopes: the login always asks for
consent (`prompt=consent`) and a fresh refresh token.

## Local development

```
cd worker
copy .dev.vars.example .dev.vars    # fill in the client id/secret, any ACCESS_KEY
npx wrangler dev
```

Then add `http://localhost:8787/callback` as a redirect URI on the OAuth
client and open `http://localhost:8787/auth/<ACCESS_KEY>`. The MCP endpoint is
`http://localhost:8787/mcp/<ACCESS_KEY>`.

## Troubleshooting

- **`redirect_uri_mismatch` on the Google page** - the callback URL is not
  listed on the OAuth client, or differs (http vs https, trailing slash).
- **"Access blocked: app has not completed the Google verification process"** -
  the signed-in account is not in the *Test users* list.
- **`invalid_scope`** - a scope in `SCOPES` (or the defaults) does not exist;
  check the Data Access page and remove it.
- **403 `PERMISSION_DENIED` from one tool** - the scope for that data type was
  not granted (unticked on the consent page) or not added on the Data Access
  page. `googlehealth_auth_status` lists granted vs missing scopes.
- **`invalid_grant` when refreshing** - the 7-day testing token expired, access
  was revoked, or the token was unused for 6 months. Log in again.
- **Everything null for today** - the tracker has not synced. Open the Google
  Health app to force a sync, or check `googlehealth_get_devices`.
- Worker logs: `npx wrangler tail` in the `worker` folder.
