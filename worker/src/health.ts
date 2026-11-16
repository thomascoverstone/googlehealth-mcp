/**
 * Google Health API (health.googleapis.com, v4) client for the Cloudflare Worker.
 *
 * Responsibilities:
 *   * Google OAuth 2.0 (authorization-code + refresh) with tokens kept in KV
 *   * a thin REST wrapper that retries once on 401, explains 403/429, and
 *     splits rollUp / dailyRollUp ranges into the 14- or 90-day chunks the API
 *     enforces
 *   * a registry of every data type (URL name, payload key, record kind, scope)
 *     so tools can build the right `filter` expression automatically
 *   * formatting helpers that turn the API's UTC + utcOffset timestamps into
 *     the user's local ISO-8601 time and int64 strings into numbers
 */

export interface Env {
  TOKENS: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Long random string that must appear in the URL path (/mcp/<key>). */
  ACCESS_KEY: string;
  /** Public https URL of this worker, used in help messages. */
  PUBLIC_URL?: string;
  /** Optional space/comma separated scope override (short names accepted). */
  SCOPES?: string;
  /** IANA zone used when the settings scope was not granted (default UTC). */
  DEFAULT_TIMEZONE?: string;
}

export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const API_BASE = "https://health.googleapis.com/v4";
export const SCOPE_PREFIX = "https://www.googleapis.com/auth/googlehealth.";

/**
 * Read-only scopes requested by default. `nutrition.readonly` (food, hydration
 * and nutrition logs) is listed on the scopes page but not in the discovery
 * document; add it via the SCOPES var once it shows up in the Cloud console.
 */
export const DEFAULT_SCOPES = [
  "activity_and_fitness.readonly",
  "health_metrics_and_measurements.readonly",
  "sleep.readonly",
  "profile.readonly",
  "settings.readonly",
  "ecg.readonly",
  "irn.readonly",
];

const TOKEN_KEY = "googlehealth:tokens";
const STATE_PREFIX = "googlehealth:oauth_state:";
const REFRESH_MARGIN_S = 300;

export class HealthError extends Error {}
export class NotAuthorizedError extends HealthError {}
export class ApiError extends HealthError {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  /** Space separated scopes the user actually granted. */
  scope: string;
  token_type: string;
  expires_in: number;
  /** Unix seconds. */
  expires_at: number;
  /** Unix seconds, or null when Google did not report one (published apps). */
  refresh_expires_at: number | null;
  obtained_at: number;
  health_user_id?: string;
  legacy_user_id?: string;
}

// --------------------------------------------------------------------------
// Scopes
// --------------------------------------------------------------------------

export function requestedScopes(env: Env): string[] {
  const raw = (env.SCOPES ?? "").trim();
  const list = raw ? raw.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES;
  return list.map(fullScope);
}

export function fullScope(s: string): string {
  if (s.startsWith("https://")) return s;
  return SCOPE_PREFIX + s.replace(/^\.?(googlehealth\.)?/, "");
}

export function shortScope(s: string): string {
  return s.startsWith(SCOPE_PREFIX) ? s.slice(SCOPE_PREFIX.length) : s;
}

// --------------------------------------------------------------------------
// Data type registry
// --------------------------------------------------------------------------

export type RecordKind = "interval" | "sample" | "daily" | "session" | "sleep" | "ecg" | "food";

export interface DataTypeInfo {
  /** Key of the payload inside a DataPoint / RollupDataPoint. */
  key: string;
  kind: RecordKind;
  /** Supported read operations. */
  ops: ReadonlyArray<"list" | "reconcile" | "rollUp" | "dailyRollUp">;
  /** Short read scope, e.g. "activity_and_fitness.readonly". */
  scope: string;
  /** Maximum rollUp / dailyRollUp range in days. */
  limitDays: number;
}

const ACT = "activity_and_fitness.readonly";
const MET = "health_metrics_and_measurements.readonly";
const NUT = "nutrition.readonly";
const LRRD = ["list", "reconcile", "rollUp", "dailyRollUp"] as const;
const LR = ["list", "reconcile"] as const;
const L = ["list"] as const;
const RD = ["rollUp", "dailyRollUp"] as const;
const RRD = ["reconcile", "rollUp", "dailyRollUp"] as const;
const NONE = [] as const;

export const DATA_TYPES: Record<string, DataTypeInfo> = {
  "active-energy-burned": { key: "activeEnergyBurned", kind: "interval", ops: LRRD, scope: ACT, limitDays: 90 },
  "active-minutes": { key: "activeMinutes", kind: "interval", ops: LRRD, scope: ACT, limitDays: 14 },
  "active-zone-minutes": { key: "activeZoneMinutes", kind: "interval", ops: LRRD, scope: ACT, limitDays: 90 },
  "activity-level": { key: "activityLevel", kind: "interval", ops: LR, scope: ACT, limitDays: 90 },
  altitude: { key: "altitude", kind: "interval", ops: LRRD, scope: ACT, limitDays: 90 },
  "blood-glucose": { key: "bloodGlucose", kind: "sample", ops: LRRD, scope: MET, limitDays: 90 },
  "body-fat": { key: "bodyFat", kind: "sample", ops: LRRD, scope: MET, limitDays: 90 },
  "calories-in-heart-rate-zone": { key: "caloriesInHeartRateZone", kind: "interval", ops: RD, scope: ACT, limitDays: 14 },
  "core-body-temperature": { key: "coreBodyTemperature", kind: "sample", ops: LRRD, scope: MET, limitDays: 90 },
  "daily-heart-rate-variability": { key: "dailyHeartRateVariability", kind: "daily", ops: LR, scope: MET, limitDays: 90 },
  "daily-heart-rate-zones": { key: "dailyHeartRateZones", kind: "daily", ops: LR, scope: MET, limitDays: 90 },
  "daily-oxygen-saturation": { key: "dailyOxygenSaturation", kind: "daily", ops: LR, scope: MET, limitDays: 90 },
  "daily-respiratory-rate": { key: "dailyRespiratoryRate", kind: "daily", ops: LR, scope: MET, limitDays: 90 },
  "daily-resting-heart-rate": { key: "dailyRestingHeartRate", kind: "daily", ops: LR, scope: MET, limitDays: 90 },
  "daily-sleep-temperature-derivations": { key: "dailySleepTemperatureDerivations", kind: "daily", ops: LR, scope: MET, limitDays: 90 },
  "daily-vo2-max": { key: "dailyVo2Max", kind: "daily", ops: LR, scope: ACT, limitDays: 90 },
  distance: { key: "distance", kind: "interval", ops: LRRD, scope: ACT, limitDays: 90 },
  electrocardiogram: { key: "electrocardiogram", kind: "ecg", ops: L, scope: "ecg.readonly", limitDays: 90 },
  exercise: { key: "exercise", kind: "session", ops: LR, scope: ACT, limitDays: 90 },
  floors: { key: "floors", kind: "interval", ops: RRD, scope: ACT, limitDays: 90 },
  food: { key: "food", kind: "food", ops: L, scope: NUT, limitDays: 90 },
  "food-measurement-unit": { key: "foodMeasurementUnit", kind: "food", ops: L, scope: NUT, limitDays: 90 },
  "heart-rate": { key: "heartRate", kind: "sample", ops: LRRD, scope: MET, limitDays: 14 },
  "heart-rate-variability": { key: "heartRateVariability", kind: "sample", ops: LR, scope: MET, limitDays: 90 },
  height: { key: "height", kind: "sample", ops: LR, scope: MET, limitDays: 90 },
  "hydration-log": { key: "hydrationLog", kind: "session", ops: LRRD, scope: NUT, limitDays: 90 },
  "irregular-rhythm-notification": { key: "irregularRhythmNotification", kind: "session", ops: L, scope: "irn.readonly", limitDays: 90 },
  "menstrual-period": { key: "menstrualPeriod", kind: "interval", ops: NONE, scope: "reproductive_health.writeonly", limitDays: 90 },
  moods: { key: "moods", kind: "sample", ops: NONE, scope: "mindfulness.writeonly", limitDays: 90 },
  "nutrition-log": { key: "nutritionLog", kind: "session", ops: LRRD, scope: NUT, limitDays: 90 },
  "ovulation-test": { key: "ovulationTest", kind: "sample", ops: NONE, scope: "reproductive_health.writeonly", limitDays: 90 },
  "oxygen-saturation": { key: "oxygenSaturation", kind: "sample", ops: LR, scope: MET, limitDays: 90 },
  "respiratory-rate-sleep-summary": { key: "respiratoryRateSleepSummary", kind: "sample", ops: LR, scope: MET, limitDays: 90 },
  "run-vo2-max": { key: "runVo2Max", kind: "sample", ops: LRRD, scope: ACT, limitDays: 90 },
  "sedentary-period": { key: "sedentaryPeriod", kind: "interval", ops: LRRD, scope: ACT, limitDays: 90 },
  sleep: { key: "sleep", kind: "sleep", ops: LR, scope: "sleep.readonly", limitDays: 90 },
  steps: { key: "steps", kind: "interval", ops: LRRD, scope: ACT, limitDays: 90 },
  "swim-lengths-data": { key: "swimLengthsData", kind: "interval", ops: LRRD, scope: ACT, limitDays: 90 },
  symptoms: { key: "symptoms", kind: "sample", ops: NONE, scope: "logged_symptoms.writeonly", limitDays: 90 },
  "time-in-heart-rate-zone": { key: "timeInHeartRateZone", kind: "interval", ops: LRRD, scope: ACT, limitDays: 90 },
  "total-calories": { key: "totalCalories", kind: "interval", ops: RD, scope: ACT, limitDays: 14 },
  "vo2-max": { key: "vo2Max", kind: "sample", ops: LR, scope: ACT, limitDays: 90 },
  weight: { key: "weight", kind: "sample", ops: LRRD, scope: MET, limitDays: 90 },
};

const DATA_TYPE_ALIASES: Record<string, string> = {
  hr: "heart-rate",
  heartrate: "heart-rate",
  pulse: "heart-rate",
  rhr: "daily-resting-heart-rate",
  resting_heart_rate: "daily-resting-heart-rate",
  hrv: "daily-heart-rate-variability",
  spo2: "daily-oxygen-saturation",
  oxygen: "daily-oxygen-saturation",
  respiratory_rate: "daily-respiratory-rate",
  breathing_rate: "daily-respiratory-rate",
  vo2max: "daily-vo2-max",
  cardio_fitness: "daily-vo2-max",
  azm: "active-zone-minutes",
  calories: "total-calories",
  calories_burned: "total-calories",
  active_calories: "active-energy-burned",
  bmr: "basal-energy-burned",
  workouts: "exercise",
  workout: "exercise",
  activities: "exercise",
  activity: "exercise",
  bodyfat: "body-fat",
  fat: "body-fat",
  water: "hydration-log",
  hydration: "hydration-log",
  food_log: "nutrition-log",
  nutrition: "nutrition-log",
  ecg: "electrocardiogram",
  irn: "irregular-rhythm-notification",
  afib: "irregular-rhythm-notification",
  skin_temperature: "daily-sleep-temperature-derivations",
  temperature: "daily-sleep-temperature-derivations",
  elevation: "altitude",
  sedentary: "sedentary-period",
  glucose: "blood-glucose",
};

/** Turn "heart_rate", "HeartRate", "hr" ... into the URL data type name. */
export function resolveDataType(raw: string): { name: string; info: DataTypeInfo } {
  const key = raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const hyphen = key.replace(/_/g, "-");
  const name = DATA_TYPES[hyphen] ? hyphen : DATA_TYPE_ALIASES[key];
  if (!name || !DATA_TYPES[name]) {
    throw new HealthError(
      `Unknown data type '${raw}'. Known types: ${Object.keys(DATA_TYPES).sort().join(", ")}`,
    );
  }
  return { name, info: DATA_TYPES[name] };
}

export function filterField(name: string): string {
  return name.replace(/-/g, "_");
}

/**
 * Build the `filter` expression that selects a closed-open range of civil
 * days [startDay, endDayExclusive) for the given data type, or undefined when
 * the type cannot be filtered by time (food catalogue) or needs a physical
 * time (ECG - see ecgFilter).
 */
export function civilDayFilter(name: string, info: DataTypeInfo, startDay: string, endDayExclusive: string): string | undefined {
  const f = filterField(name);
  const q = (field: string, lo: string, hi: string) => `${f}.${field} >= "${lo}" AND ${f}.${field} < "${hi}"`;
  switch (info.kind) {
    case "interval":
    case "session":
      return q("interval.civil_start_time", startDay, endDayExclusive);
    case "sample":
      return q("sample_time.civil_time", startDay, endDayExclusive);
    case "daily":
      return q("date", startDay, endDayExclusive);
    case "sleep":
      return q("interval.civil_end_time", startDay, endDayExclusive);
    case "ecg":
    case "food":
      return undefined;
  }
}

export function ecgFilter(start: Date): string {
  return `electrocardiogram.interval.start_time >= "${start.toISOString()}"`;
}

// --------------------------------------------------------------------------
// Token storage (KV)
// --------------------------------------------------------------------------

export function loginUrl(env: Env): string {
  const base = env.PUBLIC_URL || "https://<your-worker-url>";
  return `${base.replace(/\/$/, "")}/auth/${env.ACCESS_KEY}`;
}

export function authHelp(env: Env): string {
  return `Log in to Google Health by opening ${loginUrl(env)} in a browser.`;
}

export async function loadTokens(env: Env): Promise<Tokens | null> {
  return (await env.TOKENS.get<Tokens>(TOKEN_KEY, "json")) ?? null;
}

export async function saveTokens(env: Env, tokens: Tokens): Promise<void> {
  await env.TOKENS.put(TOKEN_KEY, JSON.stringify(tokens));
}

export async function rememberState(env: Env, state: string): Promise<void> {
  await env.TOKENS.put(STATE_PREFIX + state, "1", { expirationTtl: 600 });
}

export async function consumeState(env: Env, state: string): Promise<boolean> {
  const ok = (await env.TOKENS.get(STATE_PREFIX + state)) !== null;
  if (ok) await env.TOKENS.delete(STATE_PREFIX + state);
  return ok;
}

function nowS(): number {
  return Date.now() / 1000;
}

function withExpiry(body: Record<string, unknown>, previous: Tokens | null): Tokens {
  const now = nowS();
  const expiresIn = Number(body.expires_in ?? 3600) || 3600;
  const refreshIn = body.refresh_token_expires_in === undefined ? NaN : Number(body.refresh_token_expires_in);
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previous?.refresh_token;
  if (!refreshToken) {
    throw new HealthError(
      "Google did not return a refresh token. Open the login link again; it asks for consent " +
        "explicitly (prompt=consent), which makes Google issue a fresh refresh token.",
    );
  }
  return {
    access_token: String(body.access_token),
    refresh_token: refreshToken,
    scope: String(body.scope ?? previous?.scope ?? ""),
    token_type: String(body.token_type ?? "Bearer"),
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_expires_at: Number.isFinite(refreshIn) ? now + refreshIn : previous?.refresh_expires_at ?? null,
    obtained_at: now,
    health_user_id: previous?.health_user_id,
    legacy_user_id: previous?.legacy_user_id,
  };
}

async function readJson(res: Response): Promise<{ payload: any; text: string }> {
  const text = await res.text();
  try {
    return { payload: text ? JSON.parse(text) : {}, text };
  } catch {
    return { payload: null, text };
  }
}

function describeApiError(status: number, payload: any, context: string, text: string): string {
  const e = (payload && payload.error) || {};
  const detail =
    (typeof e === "object" && e.message) ||
    (typeof e === "string" && e) ||
    payload?.error_description ||
    (text ? text.slice(0, 200) : "no description");
  let msg = `Google Health ${context} failed (HTTP ${status}${e.status ? " " + e.status : ""}): ${detail}`;
  if (status === 403) {
    msg +=
      " Usually this means the user did not grant a scope this data needs. Check googlehealth_auth_status " +
      "for the granted scopes and open the login link again, ticking every permission.";
  } else if (status === 429) {
    msg += " Rate limited (300 requests per user per minute). Wait a minute and retry with a smaller range.";
  } else if (status === 400 && /filter/i.test(detail)) {
    msg += " The filter expression was rejected; see the data type's supported filter fields.";
  }
  return msg;
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

export interface ListOptions {
  filter?: string;
  pageSize?: number;
  pageToken?: string;
  /** Use dataPoints:reconcile (deduplicated across sources) instead of list. */
  reconcile?: boolean;
  dataSourceFamily?: string;
  /** Follow nextPageToken at most this many times (default 1 page). */
  maxPages?: number;
  /** Stop once this many points were collected. */
  maxItems?: number;
}

export class HealthClient {
  private tokens: Tokens | null = null;
  private refreshing: Promise<Tokens> | null = null;
  private tz: string | null = null;

  constructor(private readonly env: Env) {}

  // ---- OAuth -----------------------------------------------------------

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      client_id: this.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: requestedScopes(this.env).join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTHORIZE_URL}?${q}`;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({
      client_id: this.env.GOOGLE_CLIENT_ID,
      client_secret: this.env.GOOGLE_CLIENT_SECRET,
      ...fields,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const { payload, text } = await readJson(res);
    if (!res.ok || !payload || payload.error) {
      const code = payload?.error ?? `http_${res.status}`;
      const desc = payload?.error_description ?? (payload ? "" : text.slice(0, 200));
      throw new ApiError(res.status, `Google token request failed (${code}): ${desc}`.trim());
    }
    return payload as Record<string, unknown>;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<Tokens> {
    const body = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    this.tokens = withExpiry(body, null);
    await saveTokens(this.env, this.tokens);
    // Best effort: remember who this is so status messages can show it.
    try {
      const id = await this.identity();
      this.tokens.health_user_id = id.healthUserId;
      this.tokens.legacy_user_id = id.legacyUserId;
      await saveTokens(this.env, this.tokens);
    } catch {
      /* identity needs at least one data scope; not fatal */
    }
    return this.tokens;
  }

  /** Refresh once even if several tool calls ask at the same time. */
  refresh(): Promise<Tokens> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<Tokens> {
    const stored = await loadTokens(this.env);
    if (!stored) throw new NotAuthorizedError(`No Google Health login saved yet. ${authHelp(this.env)}`);
    try {
      const body = await this.tokenRequest({
        grant_type: "refresh_token",
        refresh_token: stored.refresh_token,
      });
      this.tokens = withExpiry(body, stored);
      await saveTokens(this.env, this.tokens);
      return this.tokens;
    } catch (err) {
      // Another isolate may have refreshed a moment ago.
      const again = await loadTokens(this.env);
      if (again && again.access_token !== stored.access_token && again.expires_at - nowS() > 60) {
        this.tokens = again;
        return again;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const why = /invalid_grant/.test(msg)
        ? " The refresh token is no longer valid: Google expires them after 7 days while the Cloud " +
          "project's OAuth consent screen is in 'Testing', after 6 months without use, or when access is revoked."
        : "";
      throw new NotAuthorizedError(`The saved Google Health login could not be refreshed (${msg}).${why} ${authHelp(this.env)}`);
    }
  }

  async accessToken(force = false): Promise<string> {
    if (!this.tokens) this.tokens = await loadTokens(this.env);
    if (!this.tokens) throw new NotAuthorizedError(`No Google Health login saved yet. ${authHelp(this.env)}`);
    const remaining = this.tokens.expires_at - nowS();
    if (force || remaining < REFRESH_MARGIN_S) {
      const fresh = await loadTokens(this.env);
      if (!force && fresh && fresh.expires_at - nowS() >= REFRESH_MARGIN_S) {
        this.tokens = fresh;
      } else {
        await this.refresh();
      }
    }
    return this.tokens!.access_token;
  }

  // ---- Generic call ----------------------------------------------------

  async request<T = any>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; context?: string } = {},
  ): Promise<T> {
    const qs = Object.entries(opts.query ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const url = `${API_BASE}/${path}${qs ? "?" + qs : ""}`;
    const context = opts.context ?? `${method} ${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt === 1);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (res.status === 401 && attempt === 0) {
        await res.text();
        continue;
      }
      const { payload, text } = await readJson(res);
      if (res.ok) return (payload ?? {}) as T;
      throw new ApiError(res.status, describeApiError(res.status, payload, context, text));
    }
    throw new HealthError("unreachable");
  }

  // ---- Endpoints -------------------------------------------------------

  async identity(): Promise<{ healthUserId?: string; legacyUserId?: string }> {
    return this.request("GET", "users/me/identity", { context: "getIdentity" });
  }

  async profile(): Promise<Record<string, any>> {
    return this.request("GET", "users/me/profile", { context: "getProfile" });
  }

  async settings(): Promise<Record<string, any>> {
    return this.request("GET", "users/me/settings", { context: "getSettings" });
  }

  async pairedDevices(): Promise<any[]> {
    const out: any[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const body = await this.request("GET", "users/me/pairedDevices", {
        query: { pageSize: 50, pageToken },
        context: "pairedDevices.list",
      });
      out.push(...(body.pairedDevices ?? []));
      pageToken = body.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return out;
  }

  /** IANA zone (or "+HH:MM") the user's account is set to; cached per session. */
  async timezone(): Promise<string> {
    if (this.tz) return this.tz;
    let tz = "";
    try {
      const s = await this.settings();
      tz = s.timeZone || (s.utcOffset ? offsetString(parseDuration(s.utcOffset)) : "");
    } catch {
      /* settings scope not granted; fall through */
    }
    this.tz = tz || this.env.DEFAULT_TIMEZONE || "UTC";
    return this.tz;
  }

  async listDataPoints(dataType: string, opts: ListOptions = {}): Promise<{ dataPoints: any[]; nextPageToken?: string }> {
    const op = opts.reconcile ? "dataPoints:reconcile" : "dataPoints";
    const out: any[] = [];
    let pageToken = opts.pageToken;
    let next: string | undefined;
    const maxPages = opts.maxPages ?? 1;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.request("GET", `users/me/dataTypes/${dataType}/${op}`, {
        query: {
          filter: opts.filter,
          pageSize: opts.pageSize,
          pageToken,
          dataSourceFamily: opts.reconcile ? opts.dataSourceFamily : undefined,
        },
        context: `${dataType} ${opts.reconcile ? "reconcile" : "list"}`,
      });
      for (const dp of body.dataPoints ?? []) {
        // reconcile returns ReconciledDataPoint with dataPointName instead of name
        if (dp.dataPointName && !dp.name) dp.name = dp.dataPointName;
        out.push(dp);
      }
      next = body.nextPageToken || undefined;
      pageToken = next;
      if (!next) break;
      if (opts.maxItems && out.length >= opts.maxItems) break;
    }
    return { dataPoints: out, nextPageToken: next };
  }

  /**
   * Physical-time roll-up. Splits the range into chunks the API accepts and
   * returns the windows oldest first.
   */
  async rollUp(
    dataType: string,
    opts: { start: Date; end: Date; windowSeconds: number; dataSourceFamily?: string; maxPages?: number },
  ): Promise<any[]> {
    const info = DATA_TYPES[dataType];
    const limitMs = (info?.limitDays ?? 90) * DAY_MS;
    const out: any[] = [];
    for (let s = opts.start.getTime(); s < opts.end.getTime(); s += limitMs) {
      const e = Math.min(s + limitMs, opts.end.getTime());
      let pageToken: string | undefined;
      for (let page = 0; page < (opts.maxPages ?? 10); page++) {
        const body = await this.request("POST", `users/me/dataTypes/${dataType}/dataPoints:rollUp`, {
          body: {
            range: { startTime: new Date(s).toISOString(), endTime: new Date(e).toISOString() },
            windowSize: `${Math.max(1, Math.round(opts.windowSeconds))}s`,
            dataSourceFamily: opts.dataSourceFamily,
            pageSize: 10000,
            pageToken,
          },
          context: `${dataType} rollUp`,
        });
        out.push(...(body.rollupDataPoints ?? []));
        pageToken = body.nextPageToken || undefined;
        if (!pageToken) break;
      }
    }
    out.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    return out;
  }

  /**
   * Civil-time roll-up over whole days [startDay, endDayExclusive). Returns the
   * windows oldest first with a `date` (YYYY-MM-DD) added to each.
   */
  async dailyRollUp(
    dataType: string,
    opts: { startDay: string; endDayExclusive: string; windowDays?: number; dataSourceFamily?: string },
  ): Promise<any[]> {
    const info = DATA_TYPES[dataType];
    const limit = info?.limitDays ?? 90;
    const out: any[] = [];
    for (let day = opts.startDay; day < opts.endDayExclusive; day = addDays(day, limit)) {
      const chunkEnd = minDay(addDays(day, limit), opts.endDayExclusive);
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const body = await this.request("POST", `users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`, {
          body: {
            range: { start: civilStart(day), end: civilStart(chunkEnd) },
            windowSizeDays: opts.windowDays ?? 1,
            dataSourceFamily: opts.dataSourceFamily,
            pageSize: 10000,
            pageToken,
          },
          context: `${dataType} dailyRollUp`,
        });
        for (const p of body.rollupDataPoints ?? []) {
          p.date = civilDate(p.civilStartTime);
          out.push(p);
        }
        pageToken = body.nextPageToken || undefined;
        if (!pageToken) break;
      }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }
}

// --------------------------------------------------------------------------
// Time helpers
// --------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written YYYY-MM-DD. Date.parse alone would roll Feb 30 over to Mar 2. */
export function isDay(s: string | undefined | null): s is string {
  if (!s) return false;
  const t = s.trim();
  if (!DAY_RE.test(t)) return false;
  const ms = Date.parse(t + "T00:00:00Z");
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === t;
}

export function assertDay(s: string, label: string): string {
  if (!isDay(s)) throw new HealthError(`Bad ${label} '${s}'; use YYYY-MM-DD.`);
  return s.trim();
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function minDay(a: string, b: string): string {
  return a < b ? a : b;
}

export function daysBetween(startDay: string, endDayExclusive: string): number {
  return Math.round((Date.parse(endDayExclusive + "T00:00:00Z") - Date.parse(startDay + "T00:00:00Z")) / DAY_MS);
}

export function civilStart(day: string): { date: { year: number; month: number; day: number }; time: { hours: number; minutes: number; seconds: number; nanos: number } } {
  const [y, m, d] = day.split("-").map(Number);
  return { date: { year: y, month: m, day: d }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function dateStr(d: { year?: number; month?: number; day?: number } | undefined | null): string | null {
  if (!d || !d.year) return null;
  return `${pad(d.year, 4)}-${pad(d.month ?? 1)}-${pad(d.day ?? 1)}`;
}

export function civilDate(cdt: { date?: { year?: number; month?: number; day?: number } } | undefined | null): string | null {
  return dateStr(cdt?.date);
}

/** CivilDateTime -> "YYYY-MM-DDTHH:MM[:SS]" (no offset, the user's wall clock). */
export function civilIso(cdt: any): string | null {
  const date = civilDate(cdt);
  if (!date) return null;
  const t = cdt.time ?? {};
  const base = `${date}T${pad(t.hours ?? 0)}:${pad(t.minutes ?? 0)}`;
  return t.seconds ? `${base}:${pad(t.seconds)}` : base;
}

/** "-18000s" -> -18000 */
export function parseDuration(s: string | undefined | null): number {
  if (!s) return 0;
  const n = Number(String(s).replace(/s$/, ""));
  return Number.isFinite(n) ? n : 0;
}

export function offsetString(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(Math.round(seconds));
  return `${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
}

/** UTC instant + the user's offset at that instant -> local ISO-8601 with offset. */
export function localIso(physicalTime: string | undefined | null, utcOffset?: string | null): string | null {
  if (!physicalTime) return null;
  const ms = Date.parse(physicalTime);
  if (Number.isNaN(ms)) return physicalTime;
  const off = parseDuration(utcOffset);
  const shifted = new Date(ms + off * 1000).toISOString();
  return shifted.replace(/\.\d{3}Z$/, "").replace(/Z$/, "") + offsetString(off);
}

/** UTC offset (seconds) of an IANA zone or "+HH:MM" string at a given instant. */
export function offsetAt(instant: Date, tz: string): number {
  const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (fixed) return (fixed[1] === "-" ? -1 : 1) * (Number(fixed[2]) * 3600 + Number(fixed[3]) * 60);
  if (!tz || tz === "UTC") return 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(instant);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!m) return 0;
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60);
  } catch {
    return 0;
  }
}

/** Local midnight of `day` in `tz`, as a UTC instant. */
export function zonedMidnight(day: string, tz: string): Date {
  const naive = Date.parse(day + "T00:00:00Z");
  let guess = naive - offsetAt(new Date(naive), tz) * 1000;
  // one correction pass handles DST changes that fall around midnight
  guess = naive - offsetAt(new Date(guess), tz) * 1000;
  return new Date(guess);
}

/** Today's date (YYYY-MM-DD) in `tz`. */
export function todayIn(tz: string, now = new Date()): string {
  return new Date(now.getTime() + offsetAt(now, tz) * 1000).toISOString().slice(0, 10);
}

/** Format a UTC instant in `tz` as local ISO with offset. */
export function instantToLocal(iso: string | undefined | null, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return localIso(iso, `${offsetAt(d, tz)}s`);
}

// --------------------------------------------------------------------------
// Value helpers
// --------------------------------------------------------------------------

export function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export const r1 = (n: number) => Math.round(n * 10) / 10;
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const r3 = (n: number) => Math.round(n * 1000) / 1000;

export const KG_TO_LB = 2.2046226218;
export const KM_TO_MI = 0.621371192;

export function minutes(duration: string | undefined | null): number | null {
  if (!duration) return null;
  return r1(parseDuration(duration) / 60);
}

/** Recursively convert int64 strings ("1234") to numbers; leave enums/text alone. */
export function deepNumbers<T>(v: T): T {
  if (Array.isArray(v)) return v.map(deepNumbers) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = deepNumbers(val);
    return out as T;
  }
  if (typeof v === "string" && /^-?\d{1,15}$/.test(v)) return Number(v) as unknown as T;
  return v;
}

export function sourceLabel(ds: any): string | null {
  if (!ds) return null;
  const bits: string[] = [];
  if (ds.device?.displayName) bits.push(ds.device.displayName);
  else if (ds.device?.manufacturer) bits.push(ds.device.manufacturer);
  if (ds.platform && ds.platform !== "PLATFORM_UNSPECIFIED") bits.push(String(ds.platform).toLowerCase());
  if (ds.recordingMethod && ds.recordingMethod !== "RECORDING_METHOD_UNSPECIFIED") {
    bits.push(String(ds.recordingMethod).toLowerCase());
  }
  return bits.join(" / ") || null;
}

export interface StatBlock {
  n: number;
  first: { date: string; value: number };
  last: { date: string; value: number };
  change: number;
  min: number;
  max: number;
  mean: number;
  last_7d_avg?: number;
  previous_7d_avg?: number;
  week_over_week_change?: number;
}

/** points oldest first: [date, value] */
export function statBlock(points: Array<[string, number]>, lastDay: string): StatBlock | null {
  if (!points.length) return null;
  const values = points.map((p) => p[1]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const block: StatBlock = {
    n: values.length,
    first: { date: points[0][0], value: values[0] },
    last: { date: points[points.length - 1][0], value: values[values.length - 1] },
    change: r3(values[values.length - 1] - values[0]),
    min: Math.min(...values),
    max: Math.max(...values),
    mean: r3(mean),
  };
  const weekAgo = addDays(lastDay, -6);
  const twoWeeksAgo = addDays(lastDay, -13);
  const recent = points.filter((p) => p[0] >= weekAgo && p[0] <= lastDay).map((p) => p[1]);
  const previous = points.filter((p) => p[0] >= twoWeeksAgo && p[0] < weekAgo).map((p) => p[1]);
  if (recent.length && previous.length) {
    block.last_7d_avg = r3(recent.reduce((a, b) => a + b, 0) / recent.length);
    block.previous_7d_avg = r3(previous.reduce((a, b) => a + b, 0) / previous.length);
    block.week_over_week_change = r3(block.last_7d_avg - block.previous_7d_avg);
  }
  return block;
}

// --------------------------------------------------------------------------
// Simplifiers: raw API payloads -> compact, readable JSON
// --------------------------------------------------------------------------

function stageMinutes(sleep: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sleep.summary?.stagesSummary ?? []) {
    const key = String(s.type ?? "").toLowerCase();
    if (key) out[key] = num(s.minutes) ?? 0;
  }
  return out;
}

export function simplifySleep(dp: any, includeStages = false): Record<string, unknown> {
  const s = dp.sleep ?? dp;
  const i = s.interval ?? {};
  const asleep = num(s.summary?.minutesAsleep);
  const inBed = num(s.summary?.minutesInSleepPeriod);
  const out: Record<string, unknown> = {
    id: dp.name ? String(dp.name).split("/").pop() : undefined,
    date: civilDate(i.civilEndTime) ?? (localIso(i.endTime, i.endUtcOffset) ?? "").slice(0, 10),
    start: localIso(i.startTime, i.startUtcOffset),
    end: localIso(i.endTime, i.endUtcOffset),
    type: s.type ?? null,
    main_sleep: s.metadata?.mainSleep ?? s.metadata?.main ?? null,
    nap: s.metadata?.nap ?? null,
    minutes_asleep: asleep,
    minutes_in_sleep_period: inBed,
    minutes_awake: num(s.summary?.minutesAwake),
    minutes_to_fall_asleep: num(s.summary?.minutesToFallAsleep),
    minutes_after_wake_up: num(s.summary?.minutesAfterWakeUp),
    efficiency_pct: asleep !== null && inBed ? Math.round((100 * asleep) / inBed) : null,
    stages_minutes: stageMinutes(s),
    processed: s.metadata?.processed ?? null,
    manually_edited: s.metadata?.manuallyEdited ?? null,
    source: sourceLabel(dp.dataSource),
  };
  if (includeStages) {
    out.stages = (s.stages ?? []).map((st: any) => ({
      type: st.type,
      start: localIso(st.startTime, st.startUtcOffset),
      end: localIso(st.endTime, st.endUtcOffset),
      minutes: r1((Date.parse(st.endTime) - Date.parse(st.startTime)) / 60000),
    }));
  }
  return out;
}

export function simplifyExercise(dp: any): Record<string, unknown> {
  const e = dp.exercise ?? dp;
  const i = e.interval ?? {};
  const m = e.metricsSummary ?? {};
  const distMm = num(m.distanceMillimeters);
  const pace = num(m.averagePaceSecondsPerMeter);
  const zones = m.heartRateZoneDurations ?? {};
  const out: Record<string, unknown> = {
    id: dp.name ? String(dp.name).split("/").pop() : undefined,
    start: localIso(i.startTime, i.startUtcOffset),
    end: localIso(i.endTime, i.endUtcOffset),
    type: e.exerciseType ?? null,
    name: e.displayName ?? null,
    duration_min: i.startTime && i.endTime ? r1((Date.parse(i.endTime) - Date.parse(i.startTime)) / 60000) : null,
    active_duration_min: minutes(e.activeDuration),
    distance_km: distMm !== null ? r2(distMm / 1e6) : null,
    distance_mi: distMm !== null ? r2((distMm / 1e6) * KM_TO_MI) : null,
    calories_kcal: num(m.caloriesKcal),
    steps: num(m.steps),
    avg_heart_rate_bpm: num(m.averageHeartRateBeatsPerMinute),
    active_zone_minutes: num(m.activeZoneMinutes),
    pace_min_per_km: pace !== null && pace > 0 ? r2((pace * 1000) / 60) : null,
    avg_speed_kmh: m.averageSpeedMillimetersPerSecond ? r2((num(m.averageSpeedMillimetersPerSecond)! * 3.6) / 1000) : null,
    elevation_gain_m: m.elevationGainMillimeters ? r1(num(m.elevationGainMillimeters)! / 1000) : null,
    heart_rate_zone_minutes: {
      light: minutes(zones.lightTime),
      moderate: minutes(zones.moderateTime),
      vigorous: minutes(zones.vigorousTime),
      peak: minutes(zones.peakTime),
    },
    run_vo2_max: num(m.runVo2Max),
    has_gps: e.exerciseMetadata?.hasGps ?? null,
    notes: e.notes ?? null,
    source: sourceLabel(dp.dataSource),
  };
  if (e.splits?.length || e.splitSummaries?.length) out.split_count = (e.splits ?? e.splitSummaries).length;
  return out;
}

/** Generic data point -> {time|start/end|date, ...payload, source}. */
export function simplifyDataPoint(dp: any, info: DataTypeInfo): Record<string, unknown> {
  if (info.kind === "sleep") return simplifySleep(dp);
  if (info.key === "exercise") return simplifyExercise(dp);
  const payload = dp[info.key] ?? {};
  const out: Record<string, unknown> = {};
  if (dp.name) out.id = String(dp.name).split("/").pop();
  if (payload.sampleTime) out.time = localIso(payload.sampleTime.physicalTime, payload.sampleTime.utcOffset);
  if (payload.interval) {
    out.start = localIso(payload.interval.startTime, payload.interval.startUtcOffset);
    out.end = localIso(payload.interval.endTime, payload.interval.endUtcOffset);
  }
  if (payload.date) out.date = dateStr(payload.date);
  const rest: Record<string, unknown> = { ...payload };
  delete rest.sampleTime;
  delete rest.interval;
  delete rest.date;
  if (info.key === "electrocardiogram" && Array.isArray(rest.waveformSamples)) {
    out.waveform_sample_count = (rest.waveformSamples as unknown[]).length;
    delete rest.waveformSamples;
  }
  Object.assign(out, deepNumbers(rest));
  out.source = sourceLabel(dp.dataSource);
  return out;
}

/**
 * Reduce a RollupDataPoint / DailyRollupDataPoint payload for `dataType` to
 * friendly units. Returns null when the window carried no value.
 */
export function rollupValue(dataType: string, point: any): Record<string, unknown> | null {
  const info = DATA_TYPES[dataType];
  const p = info ? point[info.key] : undefined;
  if (!p) {
    // daily rollups of daily types use different keys
    if (dataType === "daily-resting-heart-rate" && point.restingHeartRatePersonalRange) {
      const r = point.restingHeartRatePersonalRange;
      return { personal_range_min_bpm: num(r.beatsPerMinuteMin), personal_range_max_bpm: num(r.beatsPerMinuteMax) };
    }
    if (dataType === "daily-heart-rate-variability" && point.heartRateVariabilityPersonalRange) {
      const r = point.heartRateVariabilityPersonalRange;
      return {
        personal_range_min_ms: num(r.averageHeartRateVariabilityMillisecondsMin),
        personal_range_max_ms: num(r.averageHeartRateVariabilityMillisecondsMax),
      };
    }
    return null;
  }
  switch (dataType) {
    case "steps":
    case "floors":
      return { count: num(p.countSum) };
    case "distance": {
      const mm = num(p.millimetersSum);
      return mm === null ? null : { km: r3(mm / 1e6), mi: r3((mm / 1e6) * KM_TO_MI) };
    }
    case "altitude": {
      const mm = num(p.gainMillimetersSum);
      return mm === null ? null : { gain_m: r1(mm / 1000) };
    }
    case "active-energy-burned":
    case "total-calories":
      return { kcal: num(p.kcalSum) };
    case "heart-rate":
      return { avg_bpm: num(p.beatsPerMinuteAvg), min_bpm: num(p.beatsPerMinuteMin), max_bpm: num(p.beatsPerMinuteMax) };
    case "weight": {
      const g = num(p.weightGramsAvg);
      return g === null ? null : { kg: r2(g / 1000), lb: r2((g / 1000) * KG_TO_LB) };
    }
    case "body-fat":
      return { percent: num(p.bodyFatPercentageAvg) };
    case "active-zone-minutes": {
      const fat = num(p.sumInFatBurnHeartZone) ?? 0;
      const cardio = num(p.sumInCardioHeartZone) ?? 0;
      const peak = num(p.sumInPeakHeartZone) ?? 0;
      return { total: fat + cardio + peak, fat_burn: fat, cardio, peak };
    }
    case "active-minutes": {
      const out: Record<string, unknown> = {};
      let total = 0;
      for (const lvl of p.activeMinutesRollupByActivityLevel ?? []) {
        const v = num(lvl.activeMinutesSum) ?? 0;
        out[String(lvl.activityLevel ?? "").toLowerCase()] = v;
        total += v;
      }
      return { total, ...out };
    }
    case "calories-in-heart-rate-zone": {
      const out: Record<string, unknown> = {};
      for (const z of p.caloriesInHeartRateZones ?? []) out[String(z.heartRateZone ?? "").toLowerCase() + "_kcal"] = num(z.kcal);
      return out;
    }
    case "time-in-heart-rate-zone": {
      const out: Record<string, unknown> = {};
      for (const z of p.timeInHeartRateZones ?? []) out[String(z.heartRateZone ?? "").toLowerCase() + "_min"] = minutes(z.duration);
      return out;
    }
    case "activity-level": {
      const out: Record<string, unknown> = {};
      for (const z of p.activityLevelRollupsByActivityLevelType ?? []) {
        out[String(z.activityLevelType ?? "").toLowerCase() + "_min"] = minutes(z.totalDuration);
      }
      return out;
    }
    case "sedentary-period":
      return { sedentary_min: minutes(p.durationSum) };
    case "blood-glucose":
      return { avg_mg_dl: num(p.bloodGlucoseMilligramsPerDeciliterAvg) };
    case "core-body-temperature":
      return { avg_c: num(p.temperatureCelsiusAvg), min_c: num(p.temperatureCelsiusMin), max_c: num(p.temperatureCelsiusMax) };
    case "run-vo2-max":
      return { avg: num(p.rateAvg), min: num(p.rateMin), max: num(p.rateMax) };
    case "swim-lengths-data":
      return { strokes: num(p.strokeCountSum) };
    case "hydration-log":
      return { ml: num(p.amountConsumed?.millilitersSum) };
    case "nutrition-log": {
      const out: Record<string, unknown> = {
        kcal: num(p.energy?.kcalSum),
        carbs_g: num(p.totalCarbohydrate?.gramsSum),
        fat_g: num(p.totalFat?.gramsSum),
      };
      for (const n of p.nutrients ?? []) out[String(n.nutrient ?? "").toLowerCase() + "_g"] = num(n.quantity?.gramsSum);
      return out;
    }
    default:
      return deepNumbers(p);
  }
}
