// Family Calendar — TRMNL middleware
// One or more calendars (iCal) -> per-person columns -> JSON for the TRMNL
// display. Supports two ways to route events to a column, mixable:
//   1. Shared calendar + title-prefix tags ("IL: Dentist" -> Ian's column)
//   2. One dedicated calendar per person (everything on it -> that column)
// Handles MULTI-person tags, MULTI-DAY expansion, weather (NWS for US
// locations, Open-Meteo elsewhere), computed sun times.
//
// All family/location-specific values are configured via env vars — see
// SETUP.md. Nothing personal is hardcoded below.

import ICAL from "npm:ical.js@2";
import { blob } from "https://esm.town/v/std/blob";

// ---- CONFIG --------------------------------------------------------------
// Read from env vars (set these on your Val Town val — see SETUP.md).
// Values are validated in validateConfig(), called at the start of every
// request, so a misconfigured val fails with a clear message instead of a
// silent wrong-city/wrong-family render.
const LOCATION_LABEL = Deno.env.get("LOCATION_LABEL") || "";
const LAT = Number(Deno.env.get("LAT") || NaN);
const LON = Number(Deno.env.get("LON") || NaN);
const TZ = Deno.env.get("TIMEZONE") || "";
const BUILD = "familycal-1";
const WINDOW = 14; // days shown, starting today

// Standard US public holidays by default (Google's public holiday calendar).
// Set HOLIDAYS_ENABLED=false to turn the holiday banner off entirely, or
// override HOLIDAYS_ICAL_URL with a public holiday iCal feed for another
// region (Google publishes one per country, e.g. "en.uk#holiday@...").
const HOLIDAYS_ENABLED = (Deno.env.get("HOLIDAYS_ENABLED") ?? "true") !== "false";
const HOLIDAYS_ICAL_URL = Deno.env.get("HOLIDAYS_ICAL_URL") ||
  "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics";

// Optional override: "nws" | "open-meteo" | "none". Left unset, the provider
// is auto-detected from LAT/LON (NWS is US-only; everywhere else falls back
// to Open-Meteo). See "Weather" in SETUP.md for the tradeoffs.
const WEATHER_PROVIDER_OVERRIDE = (Deno.env.get("WEATHER_PROVIDER") || "auto")
  .toLowerCase();

// Family members: comma-separated "CODE:Column Name" pairs. Title prefix
// "CODE:" routes an event to that column (case-insensitive); multiple codes
// before the colon ("P2 K1:") route to several columns at once. The FIRST
// person listed is the default column for untagged events on the *shared*
// calendar (see ICAL_URL / ICAL_URL_<CODE> below). Example:
//   "P1:Parent 1, P2:Parent 2, K1:Kid 1, K2:Kid 2, FF:Friends & Family"
// Keep names short (~10 characters) — up to 5-6 columns share a 780px row.
const PERSON_CODES_RAW = Deno.env.get("PERSON_CODES") || "";

function parsePersonCodes(raw: string) {
  const tagToColumn: Record<string, string> = {};
  const columnOrder: string[] = [];
  const codeForColumn: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const code = part.slice(0, idx).trim().toUpperCase();
    const name = part.slice(idx + 1).trim();
    if (!code || !name) continue;
    tagToColumn[code] = name;
    if (!columnOrder.includes(name)) {
      columnOrder.push(name);
      codeForColumn[name] = code;
    }
  }
  return {
    TAG_TO_COLUMN: tagToColumn,
    COLUMNS: columnOrder,
    DEFAULT_COLUMN: columnOrder[0] || "",
    CODE_FOR_COLUMN: codeForColumn,
  };
}
const { TAG_TO_COLUMN, COLUMNS, DEFAULT_COLUMN, CODE_FOR_COLUMN } =
  parsePersonCodes(PERSON_CODES_RAW);

// ---- CALENDAR SOURCES ------------------------------------------------
// Two ways to feed events in, and you can use either or both together:
//
//   ICAL_URL             one shared calendar; events are routed by their
//                         "CODE:" title prefix (falls back to the first
//                         person in PERSON_CODES if untagged).
//   ICAL_URL_<CODE>       a calendar dedicated to one person (e.g.
//                         ICAL_URL_P1) — every event on it goes straight to
//                         that person's column, no tagging needed. A "CODE:"
//                         prefix still works here too, if you want a specific
//                         event redirected (e.g. tag a personal-calendar
//                         event "FF:" to put it under Friends & Family).
//
// Roommates/co-parents who each keep their own calendar: give everyone a
// dedicated ICAL_URL_<CODE> and skip ICAL_URL entirely. One shared family
// calendar with a single owner (kids without their own accounts, etc.): just
// set ICAL_URL and use tags, as in the original design. Both at once works
// too — e.g. two dedicated personal feeds plus one shared ICAL_URL_FF for
// household events.
type FeedSource = { url: string; column: string | null };
function resolveFeedSources(): FeedSource[] {
  const sources: FeedSource[] = [];
  for (const col of COLUMNS) {
    const code = CODE_FOR_COLUMN[col];
    const url = Deno.env.get(`ICAL_URL_${code}`);
    if (url) sources.push({ url, column: col });
  }
  const shared = Deno.env.get("ICAL_URL");
  if (shared) sources.push({ url: shared, column: null });
  return sources;
}
const FEED_SOURCES = resolveFeedSources();

class ConfigError extends Error {}

function validateConfig() {
  const missing: string[] = [];
  if (!LOCATION_LABEL) missing.push('LOCATION_LABEL (e.g. "Portland, OR")');
  if (!Number.isFinite(LAT)) missing.push('LAT (e.g. "45.5152")');
  if (!Number.isFinite(LON)) missing.push('LON (e.g. "-122.6784")');
  if (!TZ) {
    missing.push('TIMEZONE (IANA zone, e.g. "America/New_York")');
  }
  if (!PERSON_CODES_RAW) {
    missing.push(
      'PERSON_CODES (e.g. "P1:Parent 1, P2:Parent 2, FF:Friends & Family")',
    );
  } else if (COLUMNS.length === 0) {
    missing.push('PERSON_CODES is set but has no valid "CODE:Name" pairs');
  }
  if (FEED_SOURCES.length === 0) {
    missing.push(
      "At least one calendar feed: set ICAL_URL (shared, tag-routed) and/or " +
        "ICAL_URL_<CODE> per person (e.g. ICAL_URL_P1) for a dedicated feed",
    );
  }
  if (!Deno.env.get("FEED_SECRET")) {
    missing.push("FEED_SECRET (a long random string you choose)");
  }
  if (missing.length) {
    throw new ConfigError(
      `Missing/invalid required env vars:\n- ${missing.join("\n- ")}\nSee SETUP.md.`,
    );
  }
}

const DOW_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const MON3 = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const MONFULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ---- HELPERS -----------------------------------------------------------
function easternParts(date: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    ampm: p.dayPeriod || "AM",
  };
}
function easternHour24(date: Date) {
  return +new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
function easternDateStr(d: Date) {
  const p: Record<string, string> = {};
  for (
    const part of new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d)
  ) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}
function easternClock(d: Date) {
  const p: Record<string, string> = {};
  for (
    const part of new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(d)
  ) p[part.type] = part.value;
  const ap = (p.dayPeriod || "AM").toUpperCase() === "PM" ? "p" : "a";
  const h = +p.hour, m = +p.minute;
  return m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, "0")}${ap}`;
}
function cToF(c: number) {
  return c * 9 / 5 + 32;
}
function pad(n: number) {
  return String(n).padStart(2, "0");
}
function dstr(y: number, m: number, d: number) {
  return `${y}-${pad(m)}-${pad(d)}`;
}
function timeLabel(hour: number, minute: number, ampm: string) {
  const ap = ampm.toUpperCase() === "PM" ? "p" : "a";
  return minute === 0
    ? `${hour}${ap}`
    : `${hour}:${String(minute).padStart(2, "0")}${ap}`;
}

// --- TAG PARSING ---
// Accepts one OR more codes before a colon: "BL: x", "BL LL: x", "BL/LL: x".
// Returns { columns:[...], title } — columns may be several (multi-person).
// If no valid code, columns is empty and the caller falls back to whatever
// default makes sense for that feed (the feed's dedicated column, or the
// first person in PERSON_CODES for the shared feed).
function parseTag(summary: string) {
  const m = summary.match(
    /^\s*([A-Za-z0-9]{1,4}(?:\s*[\/,& ]\s*[A-Za-z0-9]{1,4})*)\s*:\s*(.*)$/,
  );
  if (m) {
    const codes = m[1].toUpperCase().split(/[\/,& ]+/).filter(Boolean);
    const cols = codes.map((c) => TAG_TO_COLUMN[c]).filter(Boolean) as string[];
    if (cols.length) {
      return {
        columns: [...new Set(cols)],
        title: m[2].trim() || summary.trim(),
      };
    }
  }
  return { columns: [] as string[], title: summary.trim() };
}

function iconFor(text: string) {
  const t = (text || "").toLowerCase();
  if (t.includes("thunder") || t.includes("storm")) return "storm";
  if (t.includes("rain") || t.includes("shower") || t.includes("drizzle")) {
    return "rain";
  }
  if (
    t.includes("snow") || t.includes("sleet") || t.includes("ice") ||
    t.includes("flurr")
  ) return "cloud";
  if (t.includes("fog") || t.includes("haze") || t.includes("smoke")) {
    return "cloud";
  }
  if (t.includes("partly")) return "partly";
  if (t.includes("mostly sunny") || t.includes("mostly clear")) return "partly";
  if (t.includes("sun") || t.includes("clear")) return "sun";
  if (t.includes("cloud")) return "cloud";
  return "cloud";
}

// ---- SUNRISE/SUNSET (computed, no network) -----------------------------
function sunTimes(date: Date, lat: number, lng: number) {
  const PI = Math.PI,
    rad = PI / 180,
    dayMs = 86400000,
    J1970 = 2440588,
    J2000 = 2451545;
  const toDays = (d: Date) => (d.valueOf() / dayMs - 0.5 + J1970) - J2000;
  const e = rad * 23.4397;
  const M = (d: number) => rad * (357.5291 + 0.98560028 * d);
  const eclLng = (M: number) => {
    const C = rad *
      (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) +
        0.0003 * Math.sin(3 * M));
    return M + C + rad * 102.9372 + PI;
  };
  const transit = (ds: number, M: number, L: number) =>
    J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const fromJ = (j: number) => new Date((j + 0.5 - J1970) * dayMs);
  const J0 = 0.0009, lw = rad * -lng, phi = rad * lat, d = toDays(date);
  const n = Math.round(d - J0 - lw / (2 * PI)), ds = J0 + lw / (2 * PI) + n;
  const m = M(ds),
    L = eclLng(m),
    dec = Math.asin(Math.sin(L) * Math.sin(e)),
    Jn = transit(ds, m, L);
  const h0 = -0.833 * rad,
    w = Math.acos(
      (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) /
        (Math.cos(phi) * Math.cos(dec)),
    );
  const Jset = transit(J0 + (w + lw) / (2 * PI) + n, m, L),
    Jrise = Jn - (Jset - Jn);
  return { sunrise: fromJ(Jrise), sunset: fromJ(Jset) };
}

// ---- WEATHER -------------------------------------------------------------
// Two providers behind one interface: { current, forecast }.
//  - NWS (weather.gov): free, keyless, no rate limit — but US-only.
//  - Open-Meteo: free, keyless, global — but shares Val Town's outbound IP
//    pool across ALL Val Town users, so it can occasionally 429. That's a
//    platform-wide risk, not specific to this app; caching + graceful
//    degradation below absorb it. See "Weather" in SETUP.md.
// Provider is auto-selected from LAT/LON unless WEATHER_PROVIDER overrides it.
function isLikelyUS(lat: number, lon: number): boolean {
  const conus = lat >= 24.5 && lat <= 49.5 && lon >= -125 && lon <= -66.9;
  const alaska = lat >= 51 && lat <= 72 && lon >= -170 && lon <= -129;
  const hawaii = lat >= 18.5 && lat <= 22.5 && lon >= -160.5 && lon <= -154.5;
  return conus || alaska || hawaii;
}
function resolveWeatherProvider(): "nws" | "open-meteo" | "none" {
  if (
    WEATHER_PROVIDER_OVERRIDE === "nws" ||
    WEATHER_PROVIDER_OVERRIDE === "open-meteo" ||
    WEATHER_PROVIDER_OVERRIDE === "none"
  ) {
    return WEATHER_PROVIDER_OVERRIDE;
  }
  return isLikelyUS(LAT, LON) ? "nws" : "open-meteo";
}

const USER_AGENT = "FamilyCalendarTRMNL/1.0 (val.town)";
const WEATHER_CACHE_KEY = "familycal_weather_cache_v1",
  POINTS_CACHE_KEY = "familycal_points_cache_v1";
const NWS_TTL_MS = 30 * 60 * 1000; // NWS has no rate limit; keep a "live" feel
const OPEN_METEO_TTL_MS = 60 * 60 * 1000; // matches device refresh_rate; cuts shared-IP load
async function blobGet(k: string): Promise<any> {
  try {
    return await blob.getJSON(k);
  } catch {
    return null;
  }
}
async function blobSet(k: string, v: any): Promise<void> {
  try {
    await blob.setJSON(k, v);
  } catch {}
}

// ---- NWS (weather.gov) ---
const NWS_HEADERS = { "User-Agent": USER_AGENT, "Accept": "application/geo+json" };

// Cache the point lookup (forecast URL, grid URL, and observation stations URL).
async function getPointData() {
  const c = await blobGet(POINTS_CACHE_KEY);
  if (c && c.forecastUrl && c.gridUrl && c.stationsUrl) return c;
  const r = await fetch(`https://api.weather.gov/points/${LAT},${LON}`, {
    headers: NWS_HEADERS,
  });
  if (!r.ok) throw new Error(`NWS points ${r.status}`);
  const j = await r.json();
  const data = {
    forecastUrl: j.properties.forecast,
    gridUrl: j.properties.forecastGridData,
    stationsUrl: j.properties.observationStations,
  };
  await blobSet(POINTS_CACHE_KEY, data);
  return data;
}

// Numeric daily highs/lows from the grid (accurate all day).
async function fetchDailyExtremes(gridUrl: string) {
  const r = await fetch(gridUrl, { headers: NWS_HEADERS });
  if (!r.ok) throw new Error(`grid ${r.status}`);
  const j = await r.json();
  const P = j.properties || {};
  const mx = P.maxTemperature?.values || [],
    mn = P.minTemperature?.values || [];
  const mxC = !/degF/i.test(P.maxTemperature?.uom || "degC"),
    mnC = !/degF/i.test(P.minTemperature?.uom || "degC");
  const maxBy: Record<string, number> = {}, minBy: Record<string, number> = {};
  for (const v of mx) {
    if (v.value == null) continue;
    const d = easternDateStr(new Date(String(v.validTime).split("/")[0]));
    const f = mxC ? cToF(v.value) : v.value;
    maxBy[d] = maxBy[d] == null ? f : Math.max(maxBy[d], f);
  }
  for (const v of mn) {
    if (v.value == null) continue;
    const d = easternDateStr(new Date(String(v.validTime).split("/")[0]));
    const f = mnC ? cToF(v.value) : v.value;
    minBy[d] = minBy[d] == null ? f : Math.min(minBy[d], f);
  }
  return { maxBy, minBy };
}

// LIVE current temperature from the nearest observation station.
async function fetchCurrentTemp(stationsUrl: string): Promise<number | null> {
  try {
    const sj = await (await fetch(stationsUrl, { headers: NWS_HEADERS }))
      .json();
    const stationId = sj.features?.[0]?.properties?.stationIdentifier;
    if (!stationId) return null;
    const oj = await (await fetch(
      `https://api.weather.gov/stations/${stationId}/observations/latest`,
      { headers: NWS_HEADERS },
    )).json();
    const tv = oj.properties?.temperature?.value; // number (Celsius) or null
    const unit = oj.properties?.temperature?.unitCode || "";
    if (tv == null) return null;
    return /degF/i.test(unit) ? Math.round(tv) : Math.round(cToF(tv));
  } catch {
    return null;
  }
}

async function fetchNWSWeather() {
  const { forecastUrl, gridUrl, stationsUrl } = await getPointData();
  const fr = await fetch(forecastUrl, { headers: NWS_HEADERS });
  if (!fr.ok) throw new Error(`forecast ${fr.status}`);
  const periods = (await fr.json()).properties?.periods || [];
  if (!periods.length) throw new Error("no periods");

  const condBy: Record<string, string> = {},
    pairBy: Record<string, { high: number | null; low: number | null }> = {};
  for (const p of periods) {
    const d = String(p.startTime).slice(0, 10);
    if (!pairBy[d]) pairBy[d] = { high: null, low: null };
    if (p.isDaytime) {
      pairBy[d].high = p.temperature;
      condBy[d] = p.shortForecast;
    } else {
      pairBy[d].low = p.temperature;
      if (!condBy[d]) condBy[d] = p.shortForecast;
    }
  }
  let ext = {
    maxBy: {} as Record<string, number>,
    minBy: {} as Record<string, number>,
  };
  try {
    ext = await fetchDailyExtremes(gridUrl);
  } catch {}
  const hi = (d: string) =>
    ext.maxBy[d] ?? pairBy[d]?.high ?? pairBy[d]?.low ?? null;
  const lo = (d: string) =>
    ext.minBy[d] ?? pairBy[d]?.low ?? pairBy[d]?.high ?? null;
  const today = easternDateStr(new Date()), p0 = periods[0];

  // live "right now" temperature (falls back to the day's high if the station read fails)
  const liveTemp = await fetchCurrentTemp(stationsUrl);

  const current = {
    condition: p0.shortForecast,
    temp: liveTemp ??
      (hi(today) != null ? Math.round(hi(today) as number) : p0.temperature),
    high: hi(today) != null ? Math.round(hi(today) as number) : p0.temperature,
    low: lo(today) != null ? Math.round(lo(today) as number) : p0.temperature,
    icon: iconFor(p0.shortForecast),
  };

  const forecast = [];
  const base = new Date();
  for (let i = 0; i < 5; i++) {
    const dd = new Date(base.getTime() + i * 86400000);
    const d = easternDateStr(dd);
    const wd = new Date(d + "T00:00:00Z").getUTCDay();
    const h = hi(d), l = lo(d);
    const txt = condBy[d] || (i === 0 ? p0.shortForecast : "");
    forecast.push({
      label: i === 0
        ? "TODAY"
        : `${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][wd]} ${
          parseInt(d.slice(8, 10), 10)
        }`,
      high: h != null ? Math.round(h) : null,
      low: l != null ? Math.round(l) : null,
      cond: txt || "—",
      icon: iconFor(txt || ""),
    });
  }
  return { current, forecast };
}

// ---- Open-Meteo (global fallback) ---
const WMO_ICON: Record<number, string> = {
  0: "sun",
  1: "sun",
  2: "partly",
  3: "cloud",
  45: "cloud",
  48: "cloud",
  51: "rain",
  53: "rain",
  55: "rain",
  56: "rain",
  57: "rain",
  61: "rain",
  63: "rain",
  65: "rain",
  66: "rain",
  67: "rain",
  71: "snow",
  73: "snow",
  75: "snow",
  77: "snow",
  80: "rain",
  81: "rain",
  82: "rain",
  85: "snow",
  86: "snow",
  95: "storm",
  96: "storm",
  99: "storm",
};
const WMO_LABEL: Record<number, string> = {
  0: "Clear",
  1: "Mostly Clear",
  2: "Partly Cloudy",
  3: "Cloudy",
  45: "Fog",
  48: "Fog",
  51: "Drizzle",
  53: "Drizzle",
  55: "Drizzle",
  56: "Freezing Drizzle",
  57: "Freezing Drizzle",
  61: "Light Rain",
  63: "Rain",
  65: "Heavy Rain",
  66: "Freezing Rain",
  67: "Freezing Rain",
  71: "Light Snow",
  73: "Snow",
  75: "Heavy Snow",
  77: "Snow Grains",
  80: "Rain Showers",
  81: "Rain Showers",
  82: "Heavy Showers",
  85: "Snow Showers",
  86: "Snow Showers",
  95: "Thunderstorm",
  96: "Thunderstorm",
  99: "Thunderstorm",
};

async function fetchOpenMeteoWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code` +
    `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(TZ)}&forecast_days=6`;
  const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  const j = await r.json();
  const cur = j.current || {};
  const daily = j.daily || {};
  const times: string[] = daily.time || [];
  const maxes: number[] = daily.temperature_2m_max || [];
  const mins: number[] = daily.temperature_2m_min || [];
  const codes: number[] = daily.weather_code || [];

  const current = {
    condition: WMO_LABEL[cur.weather_code] || "—",
    temp: cur.temperature_2m != null
      ? Math.round(cur.temperature_2m)
      : (maxes[0] != null ? Math.round(maxes[0]) : 0),
    high: maxes[0] != null ? Math.round(maxes[0]) : 0,
    low: mins[0] != null ? Math.round(mins[0]) : 0,
    icon: WMO_ICON[cur.weather_code] || "cloud",
  };

  const forecast = times.slice(0, 5).map((d, i) => {
    const wd = new Date(d + "T00:00:00Z").getUTCDay();
    return {
      label: i === 0
        ? "TODAY"
        : `${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][wd]} ${
          parseInt(d.slice(8, 10), 10)
        }`,
      high: maxes[i] != null ? Math.round(maxes[i]) : null,
      low: mins[i] != null ? Math.round(mins[i]) : null,
      cond: WMO_LABEL[codes[i]] || "—",
      icon: WMO_ICON[codes[i]] || "cloud",
    };
  });
  return { current, forecast };
}

async function getWeather() {
  const provider = resolveWeatherProvider();
  if (provider === "none") return null;
  const ttl = provider === "nws" ? NWS_TTL_MS : OPEN_METEO_TTL_MS;
  const c = await blobGet(WEATHER_CACHE_KEY);
  if (
    c && c.ts && c.provider === provider && (Date.now() - c.ts) < ttl && c.data
  ) {
    return c.data;
  }
  try {
    const data = provider === "nws"
      ? await fetchNWSWeather()
      : await fetchOpenMeteoWeather();
    await blobSet(WEATHER_CACHE_KEY, { ts: Date.now(), data, provider });
    return data;
  } catch (e) {
    if (c && c.data) return c.data; // stale cache beats no weather at all
    throw e;
  }
}

// ---- CALENDAR ----------------------------------------------------------
// Parses one feed's raw iCal text, expanding recurrences and multi-day
// spans, and calls push() once per (date, column) occurrence. defaultColumn
// is what an untagged event on THIS feed falls back to: the feed's own
// dedicated column, or (for the shared feed) null -> caller substitutes
// DEFAULT_COLUMN (the first person in PERSON_CODES).
type PushFn = (
  dateStr: string,
  col: string,
  tl: string,
  title: string,
  sortKey: number,
) => void;

function parseFeedText(
  text: string,
  defaultColumn: string | null,
  push: PushFn,
  windowEnd: Date,
) {
  const comp = new ICAL.Component(ICAL.parse(text));
  const vevents = comp.getAllSubcomponents("vevent");

  const place = (startTime: any, endTime: any, summary: string) => {
    if (!startTime) return;
    const parsed = parseTag(summary || "");
    const cols = parsed.columns.length
      ? parsed.columns
      : [defaultColumn || DEFAULT_COLUMN];
    const title = parsed.title;

    const allDay = !!startTime.isDate;
    const startD = allDay
      ? new Date(Date.UTC(startTime.year, startTime.month - 1, startTime.day))
      : startTime.toJSDate();
    let endD = startD;
    if (endTime) {
      endD = endTime.isDate
        ? new Date(Date.UTC(endTime.year, endTime.month - 1, endTime.day))
        : endTime.toJSDate();
      if (allDay) endD = new Date(endD.getTime() - 86400000); // ical all-day end is exclusive
    }
    const oneDay = 86400000;
    const startDayStr = allDay
      ? dstr(startTime.year, startTime.month, startTime.day)
      : easternDateStr(startD);
    const endDayStr = easternDateStr(endD);
    const dates: string[] = [];
    let cur = allDay
      ? new Date(Date.UTC(startTime.year, startTime.month - 1, startTime.day))
      : new Date(startD);
    let curStr = startDayStr, guard = 0;
    while (curStr <= endDayStr && guard++ < 40) {
      dates.push(curStr);
      cur = new Date(cur.getTime() + oneDay);
      curStr = easternDateStr(cur);
    }
    if (dates.length === 0) dates.push(startDayStr);
    const multi = dates.length > 1;

    let tl = "", sortKey = -1;
    if (!allDay) {
      const p = easternParts(startD);
      tl = timeLabel(p.hour, p.minute, p.ampm);
      sortKey = easternHour24(startD) * 60 + p.minute;
    }

    dates.forEach((ds, idx) => {
      const dayTitle = multi ? `${title} (${idx + 1}/${dates.length})` : title;
      for (const col of cols) {
        push(ds, col, multi ? "" : tl, dayTitle, multi ? -1 : sortKey);
      }
    });
  };

  // Split masters from recurrence overrides (VEVENTs carrying RECURRENCE-ID).
  // A single edited instance of a recurring event shows up as its own VEVENT
  // in the export *in addition to* the master's RRULE still generating that
  // same date -- relating the override to its master (below) makes the
  // iterator substitute it for that date instead of adding a second entry.
  const masters: Record<string, any> = {};
  const exceptionsByUid: Record<string, any[]> = {};
  for (const ve of vevents) {
    const uid = ve.getFirstPropertyValue("uid");
    if (ve.getFirstProperty("recurrence-id")) {
      (exceptionsByUid[uid] ||= []).push(ve);
    } else {
      masters[uid] = ve;
    }
  }

  for (const uid in masters) {
    const event = new ICAL.Event(masters[uid]);
    if (!event.startDate) continue;
    for (const ex of exceptionsByUid[uid] || []) {
      event.relateException(ex);
    }
    delete exceptionsByUid[uid];
    if (event.isRecurring()) {
      const it = event.iterator();
      let next: any, guard = 0;
      while ((next = it.next()) && guard++ < 3000) {
        if (next.toJSDate() > windowEnd) break;
        const det = event.getOccurrenceDetails(next);
        place(
          det.startDate,
          det.endDate,
          (det.item && det.item.summary) || event.summary,
        );
      }
    } else {
      place(event.startDate, event.endDate, event.summary);
    }
  }

  // Any leftover overrides have no master in this feed (e.g. the master
  // recurrence already ended) -- place them individually so they still show.
  for (const uid in exceptionsByUid) {
    for (const ve of exceptionsByUid[uid]) {
      const event = new ICAL.Event(ve);
      if (!event.startDate) continue;
      place(event.startDate, event.endDate, event.summary);
    }
  }
}

// Fetches + merges all configured feeds. A single broken/unreachable feed
// (bad URL, revoked share, transient 5xx) is logged and skipped rather than
// taking down the whole board -- with several people's calendars in play,
// one bad feed shouldn't blank out everyone else's.
async function getEvents(startStr: string, endStr: string) {
  const byDate: Record<string, Record<string, [string, string, number][]>> = {};
  const push: PushFn = (dateStr, col, tl, title, sortKey) => {
    if (dateStr < startStr || dateStr > endStr) return;
    byDate[dateStr] ||= {};
    byDate[dateStr][col] ||= [];
    byDate[dateStr][col].push([tl, title, sortKey]);
  };
  const [ey, em, ed] = endStr.split("-").map(Number);
  const windowEnd = new Date(Date.UTC(ey, em - 1, ed + 3));

  for (const source of FEED_SOURCES) {
    try {
      const text = await (await fetch(source.url)).text();
      parseFeedText(text, source.column, push, windowEnd);
    } catch (e) {
      console.error(
        `FEED ERROR (${source.column || "shared"}):`,
        String(e),
      );
    }
  }
  return byDate;
}

// ---- HOLIDAYS ----------------------------------------------------------
// Day-level list of holiday names: { "YYYY-MM-DD": ["Independence Day", ...] }.
// Cached 24h (holidays change yearly). Everyone's a default "attendee", so this
// is a per-DAY field, not per-person — the display can turn it into a band/icon.
const HOLIDAYS_CACHE_KEY = "familycal_holidays_v1";
const HOLIDAYS_TTL_MS = 24 * 60 * 60 * 1000;
async function getHolidays(
  startStr: string,
  endStr: string,
): Promise<Record<string, string[]>> {
  if (!HOLIDAYS_ENABLED) return {};
  let all = await blobGet(HOLIDAYS_CACHE_KEY);
  if (!(all && all.ts && (Date.now() - all.ts) < HOLIDAYS_TTL_MS && all.map)) {
    try {
      const text = await (await fetch(HOLIDAYS_ICAL_URL)).text();
      const comp = new ICAL.Component(ICAL.parse(text));
      const map: Record<string, string[]> = {};
      for (const ve of comp.getAllSubcomponents("vevent")) {
        const ev = new ICAL.Event(ve);
        const st = ev.startDate;
        if (!st) continue;
        const dateStr = st.isDate
          ? dstr(st.year, st.month, st.day)
          : easternDateStr(st.toJSDate());
        const name = (ev.summary || "").trim();
        if (!name) continue;
        (map[dateStr] ||= []).push(name);
      }
      all = { ts: Date.now(), map };
      await blobSet(HOLIDAYS_CACHE_KEY, all);
    } catch (e) {
      console.error("HOLIDAYS ERROR:", String(e));
      all = (all && all.map) ? all : { ts: Date.now(), map: {} };
    }
  }
  const out: Record<string, string[]> = {};
  for (const d in all.map) {
    if (d >= startStr && d <= endStr) out[d] = all.map[d];
  }
  return out;
}

// ---- BUILD PAYLOAD -----------------------------------------------------
async function buildPayload() {
  validateConfig();

  const now = new Date(), nowE = easternParts(now);
  const sY = nowE.year, sM = nowE.month, sD = nowE.day;
  const dates: { y: number; m: number; d: number; str: string }[] = [];
  for (let i = 0; i < WINDOW; i++) {
    const b = new Date(Date.UTC(sY, sM - 1, sD + i));
    dates.push({
      y: b.getUTCFullYear(),
      m: b.getUTCMonth() + 1,
      d: b.getUTCDate(),
      str: dstr(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate()),
    });
  }
  const startStr = dates[0].str,
    endStr = dates[WINDOW - 1].str,
    todayStr = dstr(sY, sM, sD);

  const [byDate, holidays, weather] = await Promise.all([
    getEvents(startStr, endStr),
    getHolidays(startStr, endStr),
    getWeather().catch((e) => {
      console.error("WEATHER ERROR:", String(e?.stack || e));
      return null;
    }),
  ]);

  const days = dates.map((dt, i) => {
    const wd = new Date(Date.UTC(dt.y, dt.m - 1, dt.d)).getUTCDay();
    const cell = byDate[dt.str] || {};
    const ev: Record<string, [string, string][]> = {};
    for (const col of COLUMNS) {
      const list = (cell[col] || []).slice().sort((a, b) => a[2] - b[2]);
      ev[col] = list.map(([t, title]) => [t, title]);
    }
    return {
      d: dt.d,
      dow: DOW_LETTERS[wd],
      today: dt.str === todayStr,
      ev,
      holiday: holidays[dt.str] || [],
      month_start: i > 0 && dt.m !== dates[i - 1].m,
      month_name: MONFULL[dt.m - 1],
    };
  });

  const first = dates[0], last = dates[WINDOW - 1];
  const rangeLabel = first.m === last.m
    ? `${MON3[first.m - 1]} ${first.d} – ${last.d}`
    : `${MON3[first.m - 1]} ${first.d} – ${MON3[last.m - 1]} ${last.d}`;

  const st = sunTimes(new Date(), LAT, LON);
  const current = weather?.current
    ? { ...weather.current, available: true }
    : {
      condition: "—",
      temp: null,
      high: null,
      low: null,
      icon: "cloud",
      available: false,
    };
  current.sunrise = easternClock(st.sunrise);
  current.sunset = easternClock(st.sunset);

  const wdS = now.toLocaleString("en-US", { timeZone: TZ, weekday: "short" });
  const moS = now.toLocaleString("en-US", { timeZone: TZ, month: "short" });
  const dyS = now.toLocaleString("en-US", { timeZone: TZ, day: "numeric" });
  const tmS = now.toLocaleString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return {
    meta: {
      range_label: rangeLabel,
      month_label: MONFULL[sM - 1],
      year: String(sY),
      updated: `${wdS} ${moS} ${dyS} · ${tmS}`,
      device_label: "TRMNL X · portrait",
      build: BUILD,
    },
    location: LOCATION_LABEL,
    current,
    forecast: weather?.forecast ?? [],
    columns: COLUMNS,
    days,
  };
}

// ---- AUTH ---------------------------------------------------------------
// This feed contains the family's full calendar (names, event titles, times).
// It must not be servable to anyone who doesn't present the shared secret,
// even though the URL itself is a long random val.town subdomain -- URLs get
// leaked (screenshots, forks, accidental public repos, log scraping) far more
// often than secrets checked on every request do.
//
// Accepts either:
//   Authorization: Bearer <secret>   (set as a Polling Header in the TRMNL
//                                      cloud dashboard -- never stored in git)
//   ?key=<secret>                     (for local trmnlp preview / manual curl;
//                                      only lives in the gitignored local
//                                      src/settings.yml, never committed)
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(req: Request): boolean {
  const secret = Deno.env.get("FEED_SECRET");
  if (!secret) return false; // fail closed: unconfigured secret means no access
  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer && timingSafeEqual(bearer, secret)) return true;
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (key && timingSafeEqual(key, secret)) return true;
  return false;
}

// ---- HTTP HANDLER ------------------------------------------------------
export default async function (req: Request): Promise<Response> {
  const h = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: h,
    });
  }
  try {
    return new Response(JSON.stringify(await buildPayload(), null, 2), {
      headers: h,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("CONFIG ERROR:", err.message);
      return new Response(
        JSON.stringify(
          { error: "config_error", message: err.message, build: BUILD },
          null,
          2,
        ),
        { status: 500, headers: h },
      );
    }
    console.error("BUILD PAYLOAD ERROR:", String((err as any)?.stack || err));
    return new Response(
      JSON.stringify({ error: "internal_error", build: BUILD }, null, 2),
      { status: 500, headers: h },
    );
  }
}
