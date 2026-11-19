# Google Health MCP server

Gives Claude live, read-only access to your own Google Health data (Fitbit
trackers, Pixel Watch and the Google Health app; the Google Health API
replaces the Fitbit Web API): steps, distance, calories, active zone minutes,
heart rate, resting heart rate, HRV, SpO2, respiratory rate, VO2 max, skin
temperature, sleep with stages, workouts, weight, body fat, ECG and
irregular-rhythm notifications.

It runs as a Cloudflare Worker in your own Cloudflare account (the free plan
is enough) and works with claude.ai, Claude Desktop, the Claude mobile apps
and Claude Code. You set everything up under your own accounts: your Google
Cloud project, your Cloudflare account and your Claude account. No
third-party server is involved.

> **Disclaimer.** This is an independent project, not affiliated with or
> endorsed by Google or Fitbit. It is not a medical device, and what it
> reports is not medical advice.

## Tools

| Tool | What it answers |
| --- | --- |
| `googlehealth_get_daily_summary` | "How did I do today / yesterday?" Activity, heart, vitals, body, the night's sleep, the day's workouts. |
| `googlehealth_get_daily_series` | Day-by-day rows plus stats (mean, min/max, week-over-week) for any mix of metrics. |
| `googlehealth_get_sleep` | Sleep sessions with stages, efficiency and averages. |
| `googlehealth_list_exercises` | Workouts with distance, pace, calories, heart rate zones, totals by type. |
| `googlehealth_get_intraday` | Minute-level roll-ups within a day (heart rate during a run, steps per hour). |
| `googlehealth_get_body_measurements` | Individual weigh-ins, body fat and height with a trend block. |
| `googlehealth_list_data_points` | Raw points of any readable data type (ECG, SpO2 samples, HRV, IRN, nutrition, ...). |
| `googlehealth_get_devices` | Paired trackers with battery and last sync. |
| `googlehealth_get_profile` | Identity, profile and settings (time zone and units). |
| `googlehealth_auth_status` | Is the server logged in? Granted scopes, token expiry, login link, live check. |

All tools are read-only. Dates are your local calendar days and times carry
your UTC offset; distances come in km and miles, weights in kg and lb.

## 1. Get the code

```bash
git clone https://github.com/thomascoverstone/googlehealth-mcp.git
cd googlehealth-mcp
```

## 2. Set up Google Cloud (about ten minutes)

The Google Health API is reached through a Google Cloud project of your own,
with the API enabled and an OAuth client.

1. **Enable the API.** Open the
   [Google Health API page](https://console.developers.google.com/apis/library/health.googleapis.com)
   in the API library, create a project (or pick one) and click **Enable**.
2. **Configure the consent screen.** In the Google Cloud console go to
   **APIs & Services → OAuth consent screen** (also called *Google Auth
   Platform*). An app name and a support email are enough. User type
   **External**. Leave the publishing status at **Testing** for now.
3. **Add yourself as a test user.** On the **Audience** page, under *Test
   users*, add the Google account that has the health data. Apps in Testing
   only work for listed test users.
4. **Add the scopes.** On the **Data Access** page click *Add or remove
   scopes*, search for "Google Health API" and tick the read-only ones:
   `activity_and_fitness.readonly`, `health_metrics_and_measurements.readonly`,
   `sleep.readonly`, `profile.readonly`, `settings.readonly`, `ecg.readonly`
   and `irn.readonly`. If `nutrition.readonly` is listed too, you can add it
   as well (see [Settings](#settings)).
5. **Create the OAuth client.** **Credentials → Create credentials → OAuth
   client ID**, type **Web application**. Leave the redirect URIs empty for
   now; setup prints the one to add.
6. Copy `.env.example` to `.env` (on Windows: `copy .env.example .env`) and
   fill in the client ID and client secret. `.env` is git-ignored.
7. **Have some data.** Install the Google Health app on your phone, sign in
   with the same Google account and let your tracker sync.

## 3. Deploy to Cloudflare

You need [Node.js](https://nodejs.org/) 22 or newer and a free
[Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
cd worker
npm install
npx wrangler login     # once per computer; opens a browser
npm run setup
```

`npm run setup` works on Windows, macOS and Linux. It deploys the worker
(the first deploy also creates the KV namespace that keeps your login),
uploads your Google client ID and secret and a random access key as Worker
secrets, and prints three links, which it also saves to
`worker/deploy-output.json` (git-ignored). Then:

1. **Redirect URI.** In the Cloud console, open your OAuth client
   (**APIs & Services → Credentials**), add the printed
   `https://googlehealth-mcp.<your-subdomain>.workers.dev/callback` under
   *Authorized redirect URIs* and save.
2. **Login link.** Open the printed `https://…/auth/…` link, pick your
   account, continue past the "Google hasn't verified this app" warning (it
   is your own app) and allow every permission. The page lists what was
   granted.
3. **Connector URL.** Add the printed `https://…/mcp/…` URL to Claude:
   - claude.ai, Claude Desktop and the Claude mobile apps: **Settings →
     Connectors → Add custom connector**, name it Google Health and paste the
     URL. A connector added there shows up in all three.
   - Claude Code: `claude mcp add --transport http --scope user googlehealth <connector URL>`

Then ask Claude something like "How did I sleep last night?".

To update, pull the changes and run `npm run setup` again. It reuses the
access key saved in `deploy-output.json`, so your connector URL stays the
same. To redeploy from another computer, copy that file over first;
otherwise setup creates a new key and you have to update the connector. For
the other options, see `npm run setup -- --help`.

## Security

- **The connector URL is the password.** Its last part is the worker's
  `ACCESS_KEY`, and anyone who has the URL can read your Google Health data
  through the tools. Keep it private.
- **The login link only starts a login.** It ends in a key derived from
  `ACCESS_KEY` (HMAC-SHA256), so it does not reveal the connector URL even
  though `googlehealth_auth_status` and login errors show it to Claude. It
  can't read your data, but someone who has it could log the worker in to a
  different Google account, so keep it private too.
- **Rotate the key** with `npm run setup -- --rotate-key` if a link leaks. The
  old connector URL and login link stop working; give Claude the new
  connector URL.
- **Where things are stored.** The Google client secret and the access key
  are Worker secrets, and the Google tokens sit in a KV namespace, all in
  your Cloudflare account. The worker stores nothing else and talks only to
  Google's OAuth and Health APIs.
- **What Claude sees.** Tool results become part of your conversation with
  Claude and are handled like anything else you share there.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## How logins work

Google access tokens last an hour; the worker refreshes them five minutes
before they expire and keeps them in KV. Google refresh tokens don't rotate,
so any number of Claude apps can share the worker.

**In Testing mode a login lasts 7 days.** While the OAuth consent screen is
in *Testing*, Google's refresh tokens expire after 7 days. The tools then
answer with the login link, and opening it takes a few seconds;
`googlehealth_auth_status` shows the days left. For logins that last,
publish the app (**Audience → Publish app**). An unverified app can still be
published for personal use: Google shows its "unverified app" warning at
login and limits the app to 100 users.

Logging in again is also how you change permissions: the login always asks
for consent and returns a fresh refresh token.

## Settings

These are `vars` in `worker/wrangler.jsonc`. Run `npm run setup` again after
changing them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCOPES` | empty: the seven read-only scopes from step 2 | Replaces the scope list. Space- or comma-separated; short names such as `sleep.readonly` work. To add nutrition, list the seven defaults plus `nutrition.readonly`, then log in again. |
| `DEFAULT_TIMEZONE` | `UTC` | IANA time zone (e.g. `Europe/Berlin`) for "today" when `settings.readonly` was not granted. With it, your Google Health time zone is used. |
| `PUBLIC_URL` | empty | The worker's https origin for login links. Empty means the origin each request arrives on. |

## Development

```bash
cd worker
cp .dev.vars.example .dev.vars    # then fill it in (on Windows: copy)
npm run dev                       # serves http://localhost:8787
npm run typecheck
npm run setup -- --dry-run        # checks the settings and builds without deploying
```

The local MCP endpoint is `http://localhost:8787/mcp/<ACCESS_KEY from .dev.vars>`;
try it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
(`npx @modelcontextprotocol/inspector`). To test the login locally, add
`http://localhost:8787/callback` as an authorized redirect URI on the OAuth
client, then open the `login_url` that `googlehealth_auth_status` returns.

## Troubleshooting

- **Setup says you are not logged in to Cloudflare**: run `npx wrangler login`.
  If you have several Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` first.
- **"You need to register a workers.dev subdomain"**: accept the prompt when
  setup asks, or open **Workers & Pages** in the Cloudflare dashboard once.
- **`redirect_uri_mismatch` on the Google page**: the callback URL is not
  listed on the OAuth client, or differs (http vs https, trailing slash).
- **"Access blocked: app has not completed the Google verification process"**:
  the signed-in account is not in the *Test users* list.
- **`invalid_scope`**: a scope in `SCOPES` (or the defaults) does not exist
  for your project; check the Data Access page.
- **403 `PERMISSION_DENIED` from one tool**: the permission for that data type
  was not granted (unticked on the consent page) or not added on the Data
  Access page. `googlehealth_auth_status` lists granted and missing scopes.
- **`invalid_grant` when refreshing**: the 7-day Testing login ended, access
  was revoked, or the login went unused for 6 months. Log in again.
- **Everything is null for today**: the tracker has not synced yet. Open the
  Google Health app to sync, or check `googlehealth_get_devices`.
- **Logs**: `npx wrangler tail` in `worker/` streams the worker's logs.

## Project layout

| Path | Purpose |
| --- | --- |
| `worker/src/index.ts` | Worker routes, OAuth login and callback, the ten MCP tools. |
| `worker/src/health.ts` | Google OAuth and token storage in KV, REST client (chunked roll-ups, paging), data-type registry, formatting. |
| `worker/scripts/setup.mjs` | Deploys to your Cloudflare account (`npm run setup`). |
| `worker/wrangler.jsonc` | Worker configuration and [settings](#settings). |

The worker answers every MCP request statelessly from one shared Durable
Object that writes nothing to storage, which keeps it well inside the
Cloudflare free plan.

## License

[MIT](LICENSE). Google, Google Health, Fitbit and Pixel are trademarks of
Google LLC; this project is not affiliated with Google.
