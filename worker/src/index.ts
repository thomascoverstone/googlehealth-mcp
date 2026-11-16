/**
 * Google Health MCP server as a Cloudflare Worker (remote MCP, streamable HTTP).
 *
 * Routes (everything except / and /callback is behind the secret ACCESS_KEY):
 *   GET  /                    liveness text
 *   GET  /callback            Google OAuth redirect target: exchanges the code, stores tokens in KV
 *   GET  /auth/<ACCESS_KEY>   starts the Google login (redirects to the consent page)
 *   POST /mcp/<ACCESS_KEY>    MCP endpoint (stateless streamable HTTP) - add this URL as a custom connector
 *   GET  /mcp/<ACCESS_KEY>    405: no event stream, so idle clients have nothing to keep open
 *   *    /sse/<ACCESS_KEY>    410: the legacy SSE transport was retired on 2026-11-15
 */
import { DurableObject } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  type DataTypeInfo,
  type Env,
  DATA_TYPES,
  HealthClient,
  HealthError,
  KG_TO_LB,
  addDays,
  assertDay,
  civilDayFilter,
  consumeState,
  daysBetween,
  dateStr,
  ecgFilter,
  instantToLocal,
  loadTokens,
  localIso,
  minutes,
  num,
  r1,
  r2,
  rememberState,
  requestedScopes,
  resolveDataType,
  rollupValue,
  shortScope,
  simplifyDataPoint,
  simplifyExercise,
  simplifySleep,
  sourceLabel,
  statBlock,
  todayIn,
  zonedMidnight,
} from "./health";

type Props = { origin: string };

const INSTRUCTIONS =
  "Live, read-only access to the user's Google Health account (Fitbit trackers, Pixel Watch, the " +
  "Google Health app; formerly the Fitbit Web API). Dates are the user's local calendar days " +
  "(YYYY-MM-DD) and times are ISO-8601 with the user's UTC offset. Distances come back in km and " +
  "miles, weights in kg and lb, durations in minutes. Use googlehealth_get_daily_summary for " +
  "'how did I do today / yesterday', googlehealth_get_daily_series for trends over days or weeks, " +
  "googlehealth_get_sleep and googlehealth_list_exercises for sessions, googlehealth_get_intraday " +
  "for minute-level detail within a day, and googlehealth_list_data_points for anything else " +
  "(raw samples, ECG, SpO2, HRV, nutrition). If a tool answers with an error saying no login is " +
  "saved or the login expired, give the user the login link it contains.";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const dump = (data: unknown) => JSON.stringify(data, null, 2);
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: dump(data) }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: dump({ error: err instanceof Error ? err.message : String(err) }) }],
  isError: true,
});
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --------------------------------------------------------------------------
// Per-day metric registry shared by the summary and series tools
// --------------------------------------------------------------------------

type Row = Record<string, number | string | null>;

interface SeriesMetric {
  source: { kind: "dailyRollUp" | "dailyList"; dataType: string } | { kind: "sleep" };
  /** Row fields extracted from one rollup point (dailyRollUp) or data point payload (dailyList / sleep). */
  fields: (p: any) => Row;
  /** Field used for the statistics block. */
  primary: string;
}

const SERIES_METRICS: Record<string, SeriesMetric> = {
  steps: {
    source: { kind: "dailyRollUp", dataType: "steps" },
    fields: (p) => ({ steps: rollupValue("steps", p)?.count as number | null ?? null }),
    primary: "steps",
  },
  distance: {
    source: { kind: "dailyRollUp", dataType: "distance" },
    fields: (p) => {
      const v = rollupValue("distance", p);
      return { distance_km: (v?.km as number) ?? null, distance_mi: (v?.mi as number) ?? null };
    },
    primary: "distance_km",
  },
  floors: {
    source: { kind: "dailyRollUp", dataType: "floors" },
    fields: (p) => ({ floors: (rollupValue("floors", p)?.count as number) ?? null }),
    primary: "floors",
  },
  altitude: {
    source: { kind: "dailyRollUp", dataType: "altitude" },
    fields: (p) => ({ altitude_gain_m: (rollupValue("altitude", p)?.gain_m as number) ?? null }),
    primary: "altitude_gain_m",
  },
  active_zone_minutes: {
    source: { kind: "dailyRollUp", dataType: "active-zone-minutes" },
    fields: (p) => {
      const v = rollupValue("active-zone-minutes", p);
      return {
        active_zone_minutes: (v?.total as number) ?? null,
        azm_fat_burn: (v?.fat_burn as number) ?? null,
        azm_cardio: (v?.cardio as number) ?? null,
        azm_peak: (v?.peak as number) ?? null,
      };
    },
    primary: "active_zone_minutes",
  },
  active_minutes: {
    source: { kind: "dailyRollUp", dataType: "active-minutes" },
    fields: (p) => {
      const v = rollupValue("active-minutes", p);
      return {
        active_minutes: (v?.total as number) ?? null,
        active_light_min: (v?.light as number) ?? null,
        active_moderate_min: (v?.moderate as number) ?? null,
        active_vigorous_min: (v?.vigorous as number) ?? null,
      };
    },
    primary: "active_minutes",
  },
  total_calories: {
    source: { kind: "dailyRollUp", dataType: "total-calories" },
    fields: (p) => ({ calories_kcal: (rollupValue("total-calories", p)?.kcal as number) ?? null }),
    primary: "calories_kcal",
  },
  active_calories: {
    source: { kind: "dailyRollUp", dataType: "active-energy-burned" },
    fields: (p) => ({ active_calories_kcal: (rollupValue("active-energy-burned", p)?.kcal as number) ?? null }),
    primary: "active_calories_kcal",
  },
  heart_rate: {
    source: { kind: "dailyRollUp", dataType: "heart-rate" },
    fields: (p) => {
      const v = rollupValue("heart-rate", p);
      return {
        hr_avg_bpm: v?.avg_bpm !== null && v?.avg_bpm !== undefined ? r1(v.avg_bpm as number) : null,
        hr_min_bpm: (v?.min_bpm as number) ?? null,
        hr_max_bpm: (v?.max_bpm as number) ?? null,
      };
    },
    primary: "hr_avg_bpm",
  },
  weight: {
    source: { kind: "dailyRollUp", dataType: "weight" },
    fields: (p) => {
      const v = rollupValue("weight", p);
      return { weight_kg: (v?.kg as number) ?? null, weight_lb: (v?.lb as number) ?? null };
    },
    primary: "weight_kg",
  },
  body_fat: {
    source: { kind: "dailyRollUp", dataType: "body-fat" },
    fields: (p) => ({ body_fat_pct: (rollupValue("body-fat", p)?.percent as number) ?? null }),
    primary: "body_fat_pct",
  },
  sedentary_minutes: {
    source: { kind: "dailyRollUp", dataType: "sedentary-period" },
    fields: (p) => ({ sedentary_min: (rollupValue("sedentary-period", p)?.sedentary_min as number) ?? null }),
    primary: "sedentary_min",
  },
  hydration: {
    source: { kind: "dailyRollUp", dataType: "hydration-log" },
    fields: (p) => ({ hydration_ml: (rollupValue("hydration-log", p)?.ml as number) ?? null }),
    primary: "hydration_ml",
  },
  calories_in: {
    source: { kind: "dailyRollUp", dataType: "nutrition-log" },
    fields: (p) => {
      const v = rollupValue("nutrition-log", p);
      return {
        calories_in_kcal: (v?.kcal as number) ?? null,
        carbs_g: (v?.carbs_g as number) ?? null,
        fat_g: (v?.fat_g as number) ?? null,
        protein_g: (v?.protein_g as number) ?? null,
      };
    },
    primary: "calories_in_kcal",
  },
  resting_heart_rate: {
    source: { kind: "dailyList", dataType: "daily-resting-heart-rate" },
    fields: (p) => ({ resting_heart_rate_bpm: num(p.beatsPerMinute) }),
    primary: "resting_heart_rate_bpm",
  },
  hrv: {
    source: { kind: "dailyList", dataType: "daily-heart-rate-variability" },
    fields: (p) => ({
      hrv_rmssd_ms: num(p.averageHeartRateVariabilityMilliseconds),
      hrv_deep_sleep_rmssd_ms: num(p.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds),
      hrv_entropy: num(p.entropy),
      non_rem_heart_rate_bpm: num(p.nonRemHeartRateBeatsPerMinute),
    }),
    primary: "hrv_rmssd_ms",
  },
  spo2: {
    source: { kind: "dailyList", dataType: "daily-oxygen-saturation" },
    fields: (p) => ({
      spo2_avg_pct: num(p.averagePercentage),
      spo2_low_pct: num(p.lowerBoundPercentage),
      spo2_high_pct: num(p.upperBoundPercentage),
    }),
    primary: "spo2_avg_pct",
  },
  respiratory_rate: {
    source: { kind: "dailyList", dataType: "daily-respiratory-rate" },
    fields: (p) => ({ respiratory_rate_bpm: num(p.breathsPerMinute) }),
    primary: "respiratory_rate_bpm",
  },
  vo2_max: {
    source: { kind: "dailyList", dataType: "daily-vo2-max" },
    fields: (p) => ({ vo2_max: num(p.vo2Max), cardio_fitness_level: p.cardioFitnessLevel ?? null }),
    primary: "vo2_max",
  },
  skin_temperature: {
    source: { kind: "dailyList", dataType: "daily-sleep-temperature-derivations" },
    fields: (p) => {
      const nightly = num(p.nightlyTemperatureCelsius);
      const base = num(p.baselineTemperatureCelsius);
      return {
        skin_temp_nightly_c: nightly,
        skin_temp_baseline_c: base,
        skin_temp_deviation_c: nightly !== null && base !== null ? r2(nightly - base) : null,
      };
    },
    primary: "skin_temp_deviation_c",
  },
  sleep: {
    source: { kind: "sleep" },
    fields: (dp) => {
      const s = simplifySleep(dp);
      const st = (s.stages_minutes ?? {}) as Record<string, number>;
      return {
        sleep_asleep_min: (s.minutes_asleep as number) ?? null,
        sleep_in_bed_min: (s.minutes_in_sleep_period as number) ?? null,
        sleep_awake_min: (s.minutes_awake as number) ?? null,
        sleep_deep_min: st.deep ?? null,
        sleep_rem_min: st.rem ?? null,
        sleep_light_min: st.light ?? null,
        sleep_efficiency_pct: (s.efficiency_pct as number) ?? null,
        sleep_start: (s.start as string) ?? null,
        sleep_end: (s.end as string) ?? null,
      };
    },
    primary: "sleep_asleep_min",
  },
};

const METRIC_ALIASES: Record<string, string> = {
  rhr: "resting_heart_rate",
  resting_hr: "resting_heart_rate",
  azm: "active_zone_minutes",
  zone_minutes: "active_zone_minutes",
  calories: "total_calories",
  calories_burned: "total_calories",
  calories_out: "total_calories",
  active_energy: "active_calories",
  hr: "heart_rate",
  heartrate: "heart_rate",
  oxygen: "spo2",
  oxygen_saturation: "spo2",
  breathing_rate: "respiratory_rate",
  vo2max: "vo2_max",
  cardio_fitness: "vo2_max",
  bodyfat: "body_fat",
  fat: "body_fat",
  water: "hydration",
  temperature: "skin_temperature",
  skin_temp: "skin_temperature",
  food: "calories_in",
  nutrition: "calories_in",
  sedentary: "sedentary_minutes",
  elevation: "altitude",
};

const DEFAULT_SERIES = ["steps", "distance", "active_zone_minutes", "total_calories", "resting_heart_rate", "sleep", "weight"];
const SUMMARY_METRICS = [
  "steps", "distance", "floors", "active_zone_minutes", "active_minutes", "total_calories", "active_calories",
  "sedentary_minutes", "heart_rate", "resting_heart_rate", "hrv", "spo2", "respiratory_rate", "vo2_max",
  "skin_temperature", "weight", "body_fat", "sleep",
];
const NUTRITION_METRICS = ["hydration", "calories_in"];

function resolveMetric(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const name = SERIES_METRICS[key] ? key : METRIC_ALIASES[key];
  if (!name) {
    throw new HealthError(`Unknown metric '${raw}'. Known metrics: ${Object.keys(SERIES_METRICS).join(", ")}`);
  }
  return name;
}

// --------------------------------------------------------------------------
// MCP server: a fresh, stateless instance for every HTTP request
// --------------------------------------------------------------------------

class GoogleHealthServer {
  server = new McpServer({ name: "googlehealth", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  private client!: HealthClient;
  private readonly env: Env;
  private readonly props: Props | undefined;

  constructor(env: Env, props?: Props) {
    this.env = env;
    this.props = props;
  }

  private envWithOrigin(): Env {
    const origin = this.props?.origin;
    return origin ? { ...this.env, PUBLIC_URL: this.env.PUBLIC_URL || origin } : this.env;
  }

  /** Fetch several per-day metrics for [startDay, endDayExclusive); errors are reported per metric. */
  private async fetchSeries(
    metricNames: string[],
    startDay: string,
    endDayExclusive: string,
  ): Promise<{ rows: Map<string, Row>; errors: Record<string, string> }> {
    const rows = new Map<string, Row>();
    for (let d = startDay; d < endDayExclusive; d = addDays(d, 1)) rows.set(d, { date: d });
    const errors: Record<string, string> = {};
    const merge = (date: string | null, fields: Row) => {
      if (!date) return;
      const row = rows.get(date);
      if (!row) return;
      for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) row[k] = v;
    };
    await Promise.all(
      metricNames.map(async (name) => {
        const m = SERIES_METRICS[name];
        try {
          if (m.source.kind === "dailyRollUp") {
            const points = await this.client.dailyRollUp(m.source.dataType, { startDay, endDayExclusive });
            for (const p of points) merge(p.date, m.fields(p));
          } else if (m.source.kind === "dailyList") {
            const dt = m.source.dataType;
            const info = DATA_TYPES[dt];
            const r = await this.client.listDataPoints(dt, {
              filter: civilDayFilter(dt, info, startDay, endDayExclusive),
              pageSize: 1000,
              maxPages: 3,
            });
            for (const dp of r.dataPoints) merge(dateStr(dp[info.key]?.date), m.fields(dp[info.key] ?? {}));
          } else {
            const days = daysBetween(startDay, endDayExclusive);
            const r = await this.client.listDataPoints("sleep", {
              filter: civilDayFilter("sleep", DATA_TYPES.sleep, startDay, endDayExclusive),
              pageSize: 25,
              maxPages: Math.min(20, Math.ceil((days * 1.5 + 5) / 25)),
            });
            // one row per night: the main sleep, else the longest session ending that day
            const best = new Map<string, any>();
            for (const dp of r.dataPoints) {
              const s = simplifySleep(dp);
              const date = s.date as string;
              const cur = best.get(date);
              const isMain = s.main_sleep === true;
              const curMain = cur ? simplifySleep(cur).main_sleep === true : false;
              const longer = !cur || (num(s.minutes_in_sleep_period) ?? 0) > (num(simplifySleep(cur).minutes_in_sleep_period) ?? 0);
              if (!cur || (isMain && !curMain) || (isMain === curMain && longer)) best.set(date, dp);
            }
            for (const [date, dp] of best) merge(date, m.fields(dp));
          }
        } catch (e) {
          errors[name] = errMsg(e);
        }
      }),
    );
    return { rows, errors };
  }

  private async grantedScopes(): Promise<string[]> {
    const t = await loadTokens(this.envWithOrigin());
    return (t?.scope ?? "").split(/\s+/).filter(Boolean).map(shortScope);
  }

  async init(): Promise<void> {
    const env = this.envWithOrigin();
    this.client = new HealthClient(env);

    // ------------------------------------------------------------------
    this.server.registerTool(
      "googlehealth_get_daily_summary",
      {
        title: "Daily summary",
        description:
          "Everything Google Health recorded for one calendar day: steps, distance, floors, active zone " +
          "minutes, active minutes, calories, sedentary time, heart rate (avg/min/max), resting heart rate, " +
          "HRV, SpO2, respiratory rate, VO2 max, skin temperature, weight, body fat, the night's sleep " +
          "(asleep/in-bed/stages) and the day's workouts. Use for 'how did I do today / yesterday / on " +
          "2026-08-30'. Metrics the user's devices do not record come back null. Returns JSON " +
          "{date, timezone, activity:{...}, heart:{...}, vitals:{...}, body:{...}, sleep:{...}, " +
          "exercises:[...], unavailable:{metric: reason}}.",
        inputSchema: {
          date: z.string().optional().describe("Calendar day YYYY-MM-DD in the user's timezone (default: today)."),
        },
        annotations: READ_ONLY,
      },
      async ({ date }) => {
        try {
          await this.client.accessToken(); // fail fast with the login link when not logged in
          const tz = await this.client.timezone();
          const day = date ? assertDay(date, "date") : todayIn(tz);
          const next = addDays(day, 1);
          const granted = await this.grantedScopes();
          const metrics = [...SUMMARY_METRICS, ...(granted.includes("nutrition.readonly") ? NUTRITION_METRICS : [])];
          const [series, exercises] = await Promise.all([
            this.fetchSeries(metrics, day, next),
            this.client
              .listDataPoints("exercise", { filter: civilDayFilter("exercise", DATA_TYPES.exercise, day, next), pageSize: 25 })
              .then((r) => r.dataPoints.map(simplifyExercise))
              .catch((e) => ({ error: errMsg(e) })),
          ]);
          const row = series.rows.get(day) ?? { date: day };
          const pick = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
          const out: Record<string, unknown> = {
            date: day,
            timezone: tz,
            activity: pick([
              "steps", "distance_km", "distance_mi", "floors", "altitude_gain_m", "active_zone_minutes", "azm_fat_burn",
              "azm_cardio", "azm_peak", "active_minutes", "active_light_min", "active_moderate_min",
              "active_vigorous_min", "calories_kcal", "active_calories_kcal", "sedentary_min",
            ]),
            heart: pick(["hr_avg_bpm", "hr_min_bpm", "hr_max_bpm", "resting_heart_rate_bpm", "hrv_rmssd_ms", "hrv_deep_sleep_rmssd_ms"]),
            vitals: pick([
              "spo2_avg_pct", "spo2_low_pct", "spo2_high_pct", "respiratory_rate_bpm", "vo2_max", "cardio_fitness_level",
              "skin_temp_nightly_c", "skin_temp_baseline_c", "skin_temp_deviation_c",
            ]),
            body: pick(["weight_kg", "weight_lb", "body_fat_pct"]),
            sleep: pick([
              "sleep_start", "sleep_end", "sleep_asleep_min", "sleep_in_bed_min", "sleep_awake_min", "sleep_deep_min",
              "sleep_rem_min", "sleep_light_min", "sleep_efficiency_pct",
            ]),
            exercises,
          };
          if (granted.includes("nutrition.readonly")) {
            out.nutrition = pick(["hydration_ml", "calories_in_kcal", "carbs_g", "fat_g", "protein_g"]);
          }
          if (Object.keys(series.errors).length) out.unavailable = series.errors;
          out.note =
            "The sleep block is the night that ENDED on this date. Null values mean nothing was recorded " +
            "(no device for that metric, not synced yet, or scope not granted; see 'unavailable').";
          return ok(out);
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ------------------------------------------------------------------
    this.server.registerTool(
      "googlehealth_get_daily_series",
      {
        title: "Day-by-day series and trend",
        description:
          "One row per calendar day for the chosen metrics, plus per-metric statistics (first/last, change, " +
          "min/max/mean, last-7-day vs previous-7-day averages). Metrics: steps, distance, floors, altitude, " +
          "active_zone_minutes, active_minutes, total_calories, active_calories, sedentary_minutes, heart_rate " +
          "(daily avg/min/max), resting_heart_rate, hrv, spo2, respiratory_rate, vo2_max, skin_temperature, " +
          "weight, body_fat, sleep, hydration, calories_in. Use for 'how has my resting heart rate changed " +
          "this month', 'average steps per day in August', 'weight trend'. Ranges are chunked automatically " +
          "(up to 366 days). Returns JSON {start, end, days, metrics, rows:[{date, ...}], stats:{metric:{n, " +
          "first, last, change, min, max, mean, last_7d_avg?, previous_7d_avg?, week_over_week_change?}}, unavailable?}.",
        inputSchema: {
          metrics: z.array(z.string()).optional().describe(
            "Metric names to include (default: steps, distance, active_zone_minutes, total_calories, " +
              "resting_heart_rate, sleep, weight). Aliases like 'rhr', 'azm', 'calories', 'hr', 'spo2' work.",
          ),
          start_date: z.string().optional().describe("First day YYYY-MM-DD (default: 29 days before end_date)."),
          end_date: z.string().optional().describe("Last day YYYY-MM-DD, inclusive (default: today)."),
          include_rows: z.boolean().default(true).describe("Return the per-day rows (default true). Set false for stats only."),
        },
        annotations: READ_ONLY,
      },
      async ({ metrics, start_date, end_date, include_rows }) => {
        try {
          const names = [...new Set((metrics?.length ? metrics : DEFAULT_SERIES).map(resolveMetric))];
          await this.client.accessToken(); // fail fast with the login link when not logged in
          const tz = await this.client.timezone();
          const end = end_date ? assertDay(end_date, "end_date") : todayIn(tz);
          const start = start_date ? assertDay(start_date, "start_date") : addDays(end, -29);
          if (end < start) throw new HealthError("end_date must be on or after start_date.");
          const days = daysBetween(start, addDays(end, 1));
          if (days > 366) throw new HealthError("Range too long; ask for at most 366 days at a time.");
          const { rows, errors } = await this.fetchSeries(names, start, addDays(end, 1));
          const list = [...rows.values()];
          const stats: Record<string, unknown> = {};
          for (const name of names) {
            const key = SERIES_METRICS[name].primary;
            const points = list
              .filter((r) => typeof r[key] === "number")
              .map((r) => [r.date as string, r[key] as number] as [string, number]);
            const block = statBlock(points, end);
            if (block) {
              const extra: Record<string, unknown> = {};
              if (key === "weight_kg") {
                extra.change_lb = r2(block.change * KG_TO_LB);
                extra.last_lb = r2(block.last.value * KG_TO_LB);
              }
              stats[key] = { ...block, ...extra };
            }
          }
          const out: Record<string, unknown> = {
            start,
            end,
            days,
            timezone: tz,
            metrics: names,
            days_with_any_data: list.filter((r) => Object.keys(r).length > 1).length,
            stats,
          };
          if (include_rows) out.rows = list;
          if (Object.keys(errors).length) out.unavailable = errors;
          return ok(out);
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ------------------------------------------------------------------
    this.server.registerTool(
      "googlehealth_get_sleep",
      {
        title: "Sleep sessions",
        description:
          "Sleep sessions (newest first) with bed/wake times, minutes asleep, time in bed, awake time, " +
          "efficiency, and minutes per stage (deep/rem/light/awake). Each session is filed under the date it " +
          "ENDED. Optionally includes the full stage timeline. Also returns averages across the main sleeps " +
          "in the range. Returns JSON {start, end, returned, averages:{...}, sessions:[{date, start, end, " +
          "type, main_sleep, nap, minutes_asleep, minutes_in_sleep_period, minutes_awake, efficiency_pct, " +
          "stages_minutes:{deep, rem, light, awake}, stages?:[...]}]}.",
        inputSchema: {
          start_date: z.string().optional().describe("First wake-up date YYYY-MM-DD (default: 13 days before end_date)."),
          end_date: z.string().optional().describe("Last wake-up date YYYY-MM-DD, inclusive (default: today)."),
          limit: z.number().int().min(1).max(200).default(30).describe("Maximum sessions to return (default 30)."),
          main_only: z.boolean().default(false).describe("Skip naps and secondary sleeps (default false)."),
          include_stages: z.boolean().default(false).describe("Include the minute-level stage timeline (default false; verbose)."),
        },
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date, limit, main_only, include_stages }) => {
        try {
          const tz = await this.client.timezone();
          const end = end_date ? assertDay(end_date, "end_date") : todayIn(tz);
          const start = start_date ? assertDay(start_date, "start_date") : addDays(end, -13);
          if (end < start) throw new HealthError("end_date must be on or after start_date.");
          const r = await this.client.listDataPoints("sleep", {
            filter: civilDayFilter("sleep", DATA_TYPES.sleep, start, addDays(end, 1)),
            pageSize: 25,
            maxPages: Math.min(40, Math.ceil(limit / 25) + 2),
            maxItems: limit * 2,
          });
          let sessions = r.dataPoints.map((dp) => simplifySleep(dp, include_stages));
          if (main_only) sessions = sessions.filter((s) => s.main_sleep === true || s.nap === false);
          sessions.sort((a, b) => String(b.end ?? "").localeCompare(String(a.end ?? "")));
          sessions = sessions.slice(0, limit);
          const mains = sessions.filter((s) => s.main_sleep === true || (s.main_sleep === null && s.nap !== true));
          const avg = (key: string) => {
            const vals = mains.map((s) => s[key]).filter((v): v is number => typeof v === "number");
            return vals.length ? r1(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
          };
          const stageAvg = (stage: string) => {
            const vals = mains.map((s) => (s.stages_minutes as Record<string, number>)?.[stage]).filter((v): v is number => typeof v === "number");
            return vals.length ? r1(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
          };
          return ok({
            start,
            end,
            timezone: tz,
            returned: sessions.length,
            more_available: !!r.nextPageToken,
            averages: {
              nights: mains.length,
              minutes_asleep: avg("minutes_asleep"),
              minutes_in_sleep_period: avg("minutes_in_sleep_period"),
              minutes_awake: avg("minutes_awake"),
              efficiency_pct: avg("efficiency_pct"),
              deep_min: stageAvg("deep"),
              rem_min: stageAvg("rem"),
              light_min: stageAvg("light"),
            },
            sessions,
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ------------------------------------------------------------------
    this.server.registerTool(
      "googlehealth_list_exercises",
      {
        title: "Workouts / exercise sessions",
        description:
          "Exercise sessions (runs, walks, rides, strength, swims, ...) newest first with type, duration, " +
          "distance, calories, steps, average heart rate, active zone minutes, pace, elevation gain and " +
          "heart-rate-zone minutes. Returns JSON {start, end, returned, totals_by_type:{TYPE:{count, " +
          "minutes, km, kcal}}, exercises:[{id, start, end, type, name, duration_min, active_duration_min, " +
          "distance_km, distance_mi, calories_kcal, steps, avg_heart_rate_bpm, active_zone_minutes, " +
          "pace_min_per_km, elevation_gain_m, heart_rate_zone_minutes, ...}]}.",
        inputSchema: {
          start_date: z.string().optional().describe("First day YYYY-MM-DD (default: 29 days before end_date)."),
          end_date: z.string().optional().describe("Last day YYYY-MM-DD, inclusive (default: today)."),
          exercise_type: z.string().optional().describe("Only this exercise type, e.g. RUNNING, WALKING, BIKING, STRENGTH_TRAINING, SWIMMING, YOGA."),
          limit: z.number().int().min(1).max(500).default(50).describe("Maximum sessions to return (default 50)."),
        },
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date, exercise_type, limit }) => {
        try {
          const tz = await this.client.timezone();
          const end = end_date ? assertDay(end_date, "end_date") : todayIn(tz);
          const start = start_date ? assertDay(start_date, "start_date") : addDays(end, -29);
          if (end < start) throw new HealthError("end_date must be on or after start_date.");
          const r = await this.client.listDataPoints("exercise", {
            filter: civilDayFilter("exercise", DATA_TYPES.exercise, start, addDays(end, 1)),
            pageSize: 25,
            maxPages: Math.min(60, Math.ceil(limit / 25) + 2),
            maxItems: exercise_type ? limit * 4 : limit,
          });
          let exercises = r.dataPoints.map(simplifyExercise);
          if (exercise_type) {
            const want = exercise_type.trim().toUpperCase().replace(/[\s-]+/g, "_");
            exercises = exercises.filter(
              (e) => String(e.type ?? "").toUpperCase() === want || String(e.name ?? "").toUpperCase().replace(/[\s-]+/g, "_") === want,
            );
          }
          exercises.sort((a, b) => String(b.start ?? "").localeCompare(String(a.start ?? "")));
          exercises = exercises.slice(0, limit);
          const totals: Record<string, { count: number; minutes: number; km: number; kcal: number }> = {};
          for (const e of exercises) {
            const t = String(e.type ?? "UNKNOWN");
            const acc = (totals[t] ??= { count: 0, minutes: 0, km: 0, kcal: 0 });
            acc.count += 1;
            acc.minutes = r1(acc.minutes + ((e.active_duration_min as number) ?? (e.duration_min as number) ?? 0));
            acc.km = r2(acc.km + ((e.distance_km as number) ?? 0));
            acc.kcal = Math.round(acc.kcal + ((e.calories_kcal as number) ?? 0));
          }
          return ok({ start, end, timezone: tz, returned: exercises.length, more_available: !!r.nextPageToken, totals_by_type: totals, exercises });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ------------------------------------------------------------------
    this.server.registerTool(
      "googlehealth_get_intraday",
      {
        title: "Intraday detail (minute-level roll-up)",
        description:
          "Aggregate one data type into fixed windows within a day (or an explicit time range): heart-rate " +
          "(avg/min/max per window), steps, distance, floors, altitude, active-zone-minutes, active-minutes, " +
          "total-calories, active-energy-burned, calories-in-heart-rate-zone, time-in-heart-rate-zone, " +
          "sedentary-period, weight, body-fat, blood-glucose, core-body-temperature, run-vo2-max, " +
          "swim-lengths-data, hydration-log, nutrition-log. Use for 'what was my heart rate during my run', " +
          "'steps per hour today'. Empty windows are omitted. Returns JSON {data_type, date, window_minutes, " +
          "timezone, windows_total, windows_with_data, summary:{field:{sum, min, max, mean}}, " +
          "series:[{start, end, ...values}]}.",
        inputSchema: {
          data_type: z.string().describe("Data type, e.g. 'heart-rate', 'steps', 'active-zone-minutes' (aliases like 'hr', 'azm', 'calories' work)."),
          date: z.string().optional().describe("Calendar day YYYY-MM-DD in the user's timezone (default: today). Ignored when start/end are given."),
          window_minutes: z.number().min(0.25).max(1440).default(15).describe("Window size in minutes (default 15; use 1 for minute-level, 60 for hourly)."),
          start: z.string().optional().describe("Optional ISO-8601 start instant (e.g. 2026-09-04T06:30:00-05:00) for a custom range."),
          end: z.string().optional().describe("Optional ISO-8601 end instant (exclusive)."),
          data_source_family: z.enum(["all-sources", "google-wearables", "google-sources"]).optional()
            .describe("Restrict to wearable-recorded data ('google-wearables') or first-party sources; default all sources."),
        },
        annotations: READ_ONLY,
      },
      async ({ data_type, date, window_minutes, start, end, data_source_family }) => {
        try {
          const { name, info } = resolveDataType(data_type);
          if (!info.ops.includes("rollUp")) {
            throw new HealthError(`'${name}' cannot be rolled up. Use googlehealth_list_data_points for it instead.`);
          }
          const tz = await this.client.timezone();
          let from: Date;
          let to: Date;
          let day: string | null = null;
          if (start || end) {
            if (!start || !end) throw new HealthError("Give both start and end, or neither.");
            from = new Date(start);
            to = new Date(end);
            if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HealthError("start/end must be ISO-8601 instants.");
          } else {
            day = date ? assertDay(date, "date") : todayIn(tz);
            from = zonedMidnight(day, tz);
            to = zonedMidnight(addDays(day, 1), tz);
          }
          if (to <= from) throw new HealthError("end must be after start.");
          if (to.getTime() - from.getTime() > 31 * 86_400_000) throw new HealthError("Intraday ranges are limited to 31 days.");
          const points = await this.client.rollUp(name, {
            start: from,
            end: to,
            windowSeconds: window_minutes * 60,
            dataSourceFamily: data_source_family ? `users/me/dataSourceFamilies/${data_source_family}` : undefined,
          });
          const series: Array<Record<string, unknown>> = [];
          const acc: Record<string, number[]> = {};
          for (const p of points) {
            const v = rollupValue(name, p);
            if (!v || Object.values(v).every((x) => x === null || x === undefined)) continue;
            series.push({ start: instantToLocal(p.startTime, tz), end: instantToLocal(p.endTime, tz), ...v });
            for (const [k, x] of Object.entries(v)) if (typeof x === "number") (acc[k] ??= []).push(x);
          }
          const summary: Record<string, unknown> = {};
          for (const [k, vals] of Object.entries(acc)) {
            summary[k] = {
              sum: r2(vals.reduce((a, b) => a + b, 0)),
              min: Math.min(...vals),
              max: Math.max(...vals),
              mean: r2(vals.reduce((a, b) => a + b, 0) / vals.length),
            };
          }
          return ok({
            data_type: name,
            date: day,
            range: { start: instantToLocal(from.toISOString(), tz), end: instantToLocal(to.toISOString(), tz) },
            window_minutes,
            timezone: tz,
            windows_total: points.length,
            windows_with_data: series.length,
            summary,
            note: "For counts (steps, distance, calories) read 'sum'; for rates (heart rate, temperature) read mean/min/max.",
            series,
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ------------------------------------------------------------------
    this.server.registerTool(
      "googlehealth_get_body_measurements",
      {
        title: "Weight, body fat and height samples",
        description:
          "Individual weight, body-fat and height readings (scale weigh-ins and manual entries) newest first, " +
          "merged into sessions when taken within 10 minutes of each other, plus a trend block. Returns JSON " +
          "{days, timezone, returned, trend:{weight_kg?:{...}, body_fat_pct?:{...}}, sessions:[{time, " +
          "weight_kg, weight_lb, body_fat_pct, height_cm, source}]}.",
        inputSchema: {
          days: z.number().int().min(1).max(3650).default(90).describe("Look-back window in days (default 90)."),
          limit: z.number().int().min(1).max(1000).default(100).describe("Maximum sessions to return (default 100)."),
        },
        annotations: READ_ONLY,
      },
      async ({ days, limit }) => {
        try {
          await this.client.accessToken(); // fail fast with the login link when not logged in
          const tz = await this.client.timezone();
          const today = todayIn(tz);
          const startDay = addDays(today, -(days - 1));
          const endEx = addDays(today, 1);
          const fetch = (dt: string) =>
            this.client
              .listDataPoints(dt, { filter: civilDayFilter(dt, DATA_TYPES[dt], startDay, endEx), pageSize: 2000, maxPages: 3 })
              .then((r) => r.dataPoints)
              .catch((e) => ({ error: errMsg(e) }));
          const [w, f, h] = await Promise.all([fetch("weight"), fetch("body-fat"), fetch("height")]);
          const errors: Record<string, string> = {};
          type Sample = { t: number; time: string | null; kind: string; value: number; source: string | null };
          const samples: Sample[] = [];
          const collect = (res: any, kind: string, key: string, value: (p: any) => number | null) => {
            if (!Array.isArray(res)) {
              errors[kind] = res.error;
              return;
            }
            for (const dp of res) {
              const p = dp[key];
              const v = value(p);
              if (!p?.sampleTime?.physicalTime || v === null) continue;
              samples.push({
                t: Date.parse(p.sampleTime.physicalTime),
                time: localIso(p.sampleTime.physicalTime, p.sampleTime.utcOffset),
                kind,
                value: v,
                source: sourceLabel(dp.dataSource),
              });
            }
          };
          collect(w, "weight_kg", "weight", (p) => (num(p?.weightGrams) === null ? null : r2(num(p.weightGrams)! / 1000)));
          collect(f, "body_fat_pct", "bodyFat", (p) => num(p?.percentage));
          collect(h, "height_cm", "height", (p) => (num(p?.heightMillimeters) === null ? null : r1(num(p.heightMillimeters)! / 10)));
          samples.sort((a, b) => b.t - a.t);
          const sessions: Array<Record<string, unknown> & { _oldest: number }> = [];
          for (const s of samples) {
            const last = sessions[sessions.length - 1];
            if (last && last._oldest - s.t <= 10 * 60 * 1000) {
              if (!(s.kind in last)) last[s.kind] = s.value;
              last._oldest = s.t;
            } else {
              sessions.push({ time: s.time, [s.kind]: s.value, source: s.source, _oldest: s.t });
            }
          }
          const cleaned = sessions.map(({ _oldest, ...rest }) => {
            if (typeof rest.weight_kg === "number") rest.weight_lb = r2(rest.weight_kg * KG_TO_LB);
            return rest;
          });
          const chrono = [...cleaned].reverse();
          const trend: Record<string, unknown> = {};
          for (const key of ["weight_kg", "body_fat_pct"]) {
            const pts = chrono
              .filter((s) => typeof s[key] === "number")
              .map((s) => [String(s.time).slice(0, 10), s[key] as number] as [string, number]);
            const block = statBlock(pts, today);
            if (block) trend[key] = key === "weight_kg" ? { ...block, change_lb: r2(block.change * KG_TO_LB), last_lb: r2(block.last.value * KG_TO_LB) } : block;
          }
          const out: Record<string, unknown> = {
            days,
            timezone: tz,
            total_sessions: cleaned.length,
            returned: Math.min(limit, cleaned.length),
            trend,
            sessions: cleaned.slice(0, limit),
          };
          if (Object.keys(errors).length) out.unavailable = errors;
          return ok(out);
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ------------------------------------------------------------------
    this.server.registerTool(
      "googlehealth_list_data_points",
      {
        title: "Raw data points for any data type",
        description:
          "Escape hatch: list the raw data points of any readable Google Health data type for a range of " +
          "days, with times converted to the user's local time. Types: steps, distance, floors (reconcile " +
          "only), altitude, active-energy-burned, basal-energy-burned, active-minutes, active-zone-minutes, " +
          "activity-level, sedentary-period, swim-lengths-data, time-in-heart-rate-zone, heart-rate (per " +
          "sample), heart-rate-variability, oxygen-saturation, respiratory-rate-sleep-summary, vo2-max, " +
          "run-vo2-max, core-body-temperature, blood-glucose, weight, body-fat, height, daily-resting-heart-rate, " +
          "daily-heart-rate-variability, daily-heart-rate-zones, daily-oxygen-saturation, daily-respiratory-rate, " +
          "daily-vo2-max, daily-sleep-temperature-derivations, sleep, exercise, electrocardiogram, " +
          "irregular-rhythm-notification, hydration-log, nutrition-log, food, food-measurement-unit. " +
          "Returns JSON {data_type, kind, filter, returned, next_page_token?, points:[{id?, time|start,end|date, " +
          "...fields, source}]}.",
        inputSchema: {
          data_type: z.string().describe("Data type name (hyphenated) or alias such as 'hrv', 'spo2', 'ecg', 'rhr'."),
          start_date: z.string().optional().describe("First day YYYY-MM-DD (default: 6 days before end_date)."),
          end_date: z.string().optional().describe("Last day YYYY-MM-DD, inclusive (default: today)."),
          limit: z.number().int().min(1).max(10000).default(200).describe("Maximum points to return (default 200)."),
          reconcile: z.boolean().default(false).describe("Use the reconciled stream (deduplicated across devices/apps) instead of raw points."),
          data_source_family: z.enum(["all-sources", "google-wearables", "google-sources"]).optional()
            .describe("With reconcile=true: restrict to wearables or first-party sources."),
          filter: z.string().optional().describe("Advanced: a raw AIP-160 filter expression that replaces the date filter."),
          page_token: z.string().optional().describe("Continue a previous listing from its next_page_token."),
        },
        annotations: READ_ONLY,
      },
      async ({ data_type, start_date, end_date, limit, reconcile, data_source_family, filter, page_token }) => {
        try {
          const { name, info } = resolveDataType(data_type);
          if (!info.ops.includes("list") && !info.ops.includes("reconcile")) {
            throw new HealthError(`'${name}' is write-only in the Google Health API; it cannot be read.`);
          }
          const useReconcile = reconcile || !info.ops.includes("list");
          if (useReconcile && !info.ops.includes("reconcile")) {
            throw new HealthError(`'${name}' does not support reconcile; set reconcile=false.`);
          }
          const tz = await this.client.timezone();
          const end = end_date ? assertDay(end_date, "end_date") : todayIn(tz);
          const start = start_date ? assertDay(start_date, "start_date") : addDays(end, -6);
          if (end < start) throw new HealthError("end_date must be on or after start_date.");
          const endEx = addDays(end, 1);
          let effectiveFilter = filter?.trim() || undefined;
          let clipEcgBefore: number | null = null;
          if (!effectiveFilter) {
            if (info.kind === "ecg") {
              effectiveFilter = ecgFilter(zonedMidnight(start, tz));
              clipEcgBefore = zonedMidnight(endEx, tz).getTime();
            } else {
              effectiveFilter = civilDayFilter(name, info, start, endEx);
            }
          }
          const sessionType = name === "exercise" || name === "sleep";
          const pageSize = sessionType ? 25 : Math.min(limit, 10000);
          const r = await this.client.listDataPoints(name, {
            filter: effectiveFilter,
            pageSize,
            pageToken: page_token,
            reconcile: useReconcile,
            dataSourceFamily: data_source_family ? `users/me/dataSourceFamilies/${data_source_family}` : undefined,
            maxPages: Math.min(40, Math.ceil(limit / pageSize)),
            maxItems: limit,
          });
          let points = r.dataPoints.map((dp) => simplifyDataPoint(dp, info));
          if (clipEcgBefore !== null) {
            points = points.filter((p) => {
              const s = typeof p.start === "string" ? Date.parse(p.start) : NaN;
              return Number.isNaN(s) || s < clipEcgBefore!;
            });
          }
          points = points.slice(0, limit);
          return ok({
            data_type: name,
            kind: info.kind,
            operation: useReconcile ? "reconcile" : "list",
            scope: info.scope,
            filter: effectiveFilter ?? null,
            start,
            end,
            timezone: tz,
            returned: points.length,
            next_page_token: r.nextPageToken ?? null,
            points,
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ------------------------------------------------------------------
    this.server.registerTool(
      "googlehealth_get_devices",
      {
        title: "Paired devices",
        description:
          "List the Fitbit / Pixel Watch devices and scales paired to the account with battery level, " +
          "last sync time and supported features. Useful to check whether the tracker has synced recently. " +
          "Needs the settings.readonly scope. Returns JSON {count, devices:[{id, type, model, battery_level, " +
          "battery_status, last_sync, features}]}.",
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () => {
        try {
          const tz = await this.client.timezone();
          const devices = await this.client.pairedDevices();
          return ok({
            count: devices.length,
            timezone: tz,
            devices: devices.map((d) => ({
              id: d.name ? String(d.name).split("/").pop() : null,
              type: d.deviceType ?? null,
              model: d.deviceVersion ?? null,
              battery_level: d.batteryLevel ?? null,
              battery_status: d.batteryStatus ?? null,
              last_sync: instantToLocal(d.lastSyncTime, tz),
              features: d.features ?? [],
            })),
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ------------------------------------------------------------------
    this.server.registerTool(
      "googlehealth_get_profile",
      {
        title: "Profile and settings",
        description:
          "The user's Google Health identity (health and legacy Fitbit user ids), profile (age, membership " +
          "start, stride lengths) and settings (timezone, preferred units, locale). Sections the granted " +
          "scopes do not cover are reported under 'unavailable'. Returns JSON {identity, profile, settings, unavailable?}.",
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () => {
        try {
          await this.client.accessToken(); // fail fast with the login link when not logged in
          const [id, profile, settings] = await Promise.allSettled([this.client.identity(), this.client.profile(), this.client.settings()]);
          const out: Record<string, unknown> = {};
          const unavailable: Record<string, string> = {};
          if (id.status === "fulfilled") out.identity = { health_user_id: id.value.healthUserId ?? null, legacy_fitbit_user_id: id.value.legacyUserId ?? null };
          else unavailable.identity = errMsg(id.reason);
          if (profile.status === "fulfilled") {
            const p = profile.value;
            out.profile = {
              age: p.age ?? null,
              membership_start_date: dateStr(p.membershipStartDate),
              walking_stride_length_mm: p.userConfiguredWalkingStrideLengthMm ?? p.autoWalkingStrideLengthMm ?? null,
              running_stride_length_mm: p.userConfiguredRunningStrideLengthMm ?? p.autoRunningStrideLengthMm ?? null,
            };
          } else unavailable.profile = errMsg(profile.reason);
          if (settings.status === "fulfilled") {
            const s = settings.value;
            out.settings = {
              timezone: s.timeZone ?? null,
              utc_offset: s.utcOffset ?? null,
              locale: s.languageLocale ?? null,
              distance_unit: s.distanceUnit ?? null,
              weight_unit: s.weightUnit ?? null,
              height_unit: s.heightUnit ?? null,
              temperature_unit: s.temperatureUnit ?? null,
              water_unit: s.waterUnit ?? null,
              glucose_unit: s.glucoseUnit ?? null,
              swim_unit: s.swimUnit ?? null,
            };
          } else unavailable.settings = errMsg(settings.reason);
          if (Object.keys(unavailable).length) out.unavailable = unavailable;
          return ok(out);
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ------------------------------------------------------------------
    this.server.registerTool(
      "googlehealth_auth_status",
      {
        title: "Google Health login status",
        description:
          "Report whether this server is logged in to Google Health: granted vs requested scopes, access and " +
          "refresh token expiry, user ids, an optional live API check, and the login link to use if not. Call " +
          "this first when another tool returns an auth or permission error.",
        inputSchema: {
          verify: z.boolean().default(true).describe("Also make a live API call to prove the saved login works (default true)."),
        },
        annotations: READ_ONLY,
      },
      async ({ verify }) => {
        const requested = requestedScopes(env).map(shortScope);
        const info: Record<string, unknown> = {
          login_url: `${env.PUBLIC_URL ?? ""}/auth/${env.ACCESS_KEY}`,
          requested_scopes: requested,
        };
        try {
          const tokens = await loadTokens(env);
          if (!tokens) {
            return ok({ ...info, logged_in: false, next_step: "Open login_url in a browser, pick the Google account and allow every permission." });
          }
          const granted = tokens.scope.split(/\s+/).filter(Boolean).map(shortScope);
          const missing = requested.filter((s) => !granted.includes(s));
          const now = Date.now() / 1000;
          Object.assign(info, {
            logged_in: true,
            health_user_id: tokens.health_user_id ?? null,
            legacy_fitbit_user_id: tokens.legacy_user_id ?? null,
            granted_scopes: granted,
            missing_scopes: missing,
            access_token_expires: new Date(tokens.expires_at * 1000).toISOString(),
            refresh_token_expires: tokens.refresh_expires_at ? new Date(tokens.refresh_expires_at * 1000).toISOString() : null,
            tokens_obtained: new Date(tokens.obtained_at * 1000).toISOString(),
          });
          if (tokens.refresh_expires_at) {
            const daysLeft = (tokens.refresh_expires_at - now) / 86400;
            info.refresh_token_days_left = r1(daysLeft);
            info.warning =
              "Google issues 7-day refresh tokens while the Cloud project's OAuth consent screen is in " +
              "'Testing'. Log in again via login_url before it expires, or publish the app in the Cloud console " +
              "to get long-lived tokens.";
          }
          if (missing.length) {
            info.note = "Some requested scopes were not granted; tools needing them will fail with 403. Log in again and tick every permission.";
          }
          if (verify) {
            try {
              const id = await this.client.identity();
              info.live_check = "ok";
              info.health_user_id = id.healthUserId ?? info.health_user_id;
              info.timezone = await this.client.timezone();
            } catch (e) {
              info.live_check = `failed: ${errMsg(e)}`;
            }
          }
          return ok(info);
        } catch (e) {
          return fail(e);
        }
      },
    );
  }
}

/**
 * The MCP endpoint's Durable Object. Every client shares ONE instance ("shared") and nothing is
 * written to its storage, so it uses no Durable Object rows. Tool calls run here rather than in
 * the Worker only to keep the Durable Object CPU budget (Free plan Workers get 10 ms of CPU, and
 * intraday or long-range queries need more).
 *
 * Until 2026-11-15 this class was an agents McpAgent: one new Durable Object per MCP session,
 * roughly 60 SQLite rows written each time. Claude Code re-initialises an open session every
 * ~18 minutes when Cloudflare drops its idle event stream, and with many sessions open that
 * reached 90% of the Free plan's 100,000 rows written per day.
 */
export class GoogleHealthMCP extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const mcp = new GoogleHealthServer(this.env, { origin: new URL(request.url).origin });
    await mcp.init();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session ids, nothing to remember
      enableJsonResponse: true, // plain JSON replies instead of event streams
    });
    await mcp.server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await mcp.server.close();
    }
  }

  /** Objects left from the per-session design may still hold a keep-alive alarm: let it lapse. */
  async alarm(): Promise<void> {}
}

// --------------------------------------------------------------------------
// HTTP routing
// --------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") {
    // Stateless server: no event stream to open (GET) and no session to end (DELETE).
    // MCP clients treat 405 as "not offered" and carry on.
    return withCors(
      Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        { status: 405, headers: { Allow: "POST, OPTIONS" } },
      ),
    );
  }
  const shared = env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName("shared"));
  return withCors(await shared.fetch(request));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(status: number, title: string, detail: string): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:36rem;text-align:center;line-height:1.5">
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function startLogin(url: URL, env: Env): Promise<Response> {
  const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await rememberState(env, state);
  const client = new HealthClient(env);
  return Response.redirect(client.authorizeUrl(state, `${url.origin}/callback`), 302);
}

async function handleCallback(url: URL, env: Env): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) {
    return page(400, "Google Health login failed", `${error} ${url.searchParams.get("error_description") ?? ""}`.trim());
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return page(400, "Missing code or state", "Start the login from the /auth link instead.");
  if (!(await consumeState(env, state))) {
    return page(400, "Login link expired", "Login links are valid for 10 minutes. Open the /auth link again.");
  }
  try {
    const tokens = await new HealthClient(env).exchangeCode(code, `${url.origin}/callback`);
    const granted = tokens.scope.split(/\s+/).filter(Boolean).map(shortScope);
    const missing = requestedScopes(env).map(shortScope).filter((s) => !granted.includes(s));
    const who = tokens.health_user_id ? ` (health user ${tokens.health_user_id})` : "";
    const expiry = tokens.refresh_expires_at
      ? ` This login expires on ${new Date(tokens.refresh_expires_at * 1000).toISOString().slice(0, 10)} because the Cloud project is still in Testing mode; log in again before then or publish the app.`
      : "";
    const missingNote = missing.length ? ` Not granted: ${missing.join(", ")} - tools needing those will not work.` : "";
    return page(
      200,
      "Google Health connected",
      `Logged in${who}. Granted: ${granted.join(", ") || "(none)"}.${missingNote}${expiry} You can close this tab and ask Claude about your data.`,
    );
  } catch (e) {
    return page(502, "Google Health login failed", errMsg(e));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const key = env.ACCESS_KEY;

    if (path === "/") return new Response("googlehealth-mcp is running.\n", { headers: { "content-type": "text/plain" } });
    if (path === "/callback") {
      if (request.method === "HEAD") return new Response(null, { status: 200 });
      return handleCallback(url, env);
    }
    if (!key || key.length < 12) return new Response("Worker is not configured: ACCESS_KEY secret missing.", { status: 500 });

    if (path === `/auth/${key}`) return startLogin(url, env);

    const mcpPath = `/mcp/${key}`;
    const ssePath = `/sse/${key}`;
    if (path === mcpPath) return handleMcp(request, env);
    if (path === ssePath || path === `${ssePath}/message`) {
      return new Response("The legacy SSE endpoint was retired; use /mcp/<key>.\n", { status: 410 });
    }
    return new Response("Not found", { status: 404 });
  },
};
