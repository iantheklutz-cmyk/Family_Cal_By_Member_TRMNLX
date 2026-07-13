# Setup guide

Everything here is config you set yourself — nothing in this repo needs to
be edited to deploy your own copy. Budget about 20-30 minutes.

## What you'll need

- A [TRMNL](https://usetrmnl.com) device (TRMNL X, portrait) — or just the
  free local preview tool (`trmnlp`) if you want to try it before buying one.
- A free [Val Town](https://val.town) account — this hosts the small
  middleware script that fetches your calendar(s) and builds the JSON TRMNL
  reads. The Developer add-on (or BYOD) is required on the TRMNL side to
  create a private plugin — check TRMNL's current plan requirements.
- At least one Google Calendar with a **secret iCal URL** (see below).

## Step 1 — Get your calendar's secret iCal address

Decide which mode fits your household first (you can change your mind later
— nothing here is one-way):

- **Tag mode (one shared calendar).** Everyone's events live on one
  calendar; you prefix a title with a short code to route it to a person's
  column (`P1: Dentist` → Parent 1's column). Good if one adult owns the family
  calendar and other members (kids, etc.) don't need their own.
- **Multi-feed mode (one calendar per person).** Each person keeps their own
  calendar; every event on it lands in that person's column automatically,
  no tagging needed. Good for roommates or co-parents who each already
  maintain their own calendar.
- **Both at once.** e.g. two personal calendars (multi-feed) plus one shared
  calendar for household events, tag-routed or defaulting to a "Friends &
  Family" column.

For **each** calendar you'll use:

1. Open Google Calendar → Settings → select the calendar → **Integrate
   calendar**.
2. Copy the **Secret address in iCal format** (`https://calendar.google.com/calendar/ical/.../private-.../basic.ics`).
   Treat this like a password — anyone with it can read that calendar.

## Step 2 — Deploy the middleware to Val Town

1. Create a new **HTTP val** on Val Town.
2. Paste in the contents of [`src/main.ts`](src/main.ts).
3. In the val's environment variables, set the following:

| Variable | Required | Example | Notes |
|---|---|---|---|
| `FEED_SECRET` | yes | a long random string | Generate one (e.g. `openssl rand -hex 24`). This gates the feed endpoint — see "Security" below. |
| `PERSON_CODES` | yes | `P1:Parent 1, P2:Parent 2, FF:Friends & Family` | Comma-separated `CODE:Column Name` pairs. The **first** person listed is the default column for untagged events on the shared feed. Keep names short — up to 5-6 columns share a 780px row. |
| `ICAL_URL` | see below | your shared calendar's secret iCal URL | The **tag-routed shared feed**. Required if you're using tag mode; optional/omit for pure multi-feed mode. |
| `ICAL_URL_<CODE>` | see below | `ICAL_URL_P1` = that person's secret iCal URL | One per person using multi-feed mode, `<CODE>` matching a code from `PERSON_CODES` (e.g. `ICAL_URL_P1`). Every event on this feed goes to that person's column automatically. You need **at least one** of `ICAL_URL` or an `ICAL_URL_<CODE>` set — mix and match freely. |
| `LOCATION_LABEL` | yes | `Portland, OR` | Display label for the weather panel. |
| `LAT` | yes | `45.5152` | Latitude, decimal degrees. |
| `LON` | yes | `-122.6784` | Longitude, decimal degrees. |
| `TIMEZONE` | yes | `America/New_York` | IANA timezone name — this drives all date/time math, not just display. |
| `HOLIDAYS_ENABLED` | no | `false` | Defaults to `true` (US public holidays). Set `false` to turn off the holiday banner entirely. |
| `HOLIDAYS_ICAL_URL` | no | a public holiday iCal feed URL | Overrides the default US holiday feed — Google publishes one per country (e.g. search "Google Calendar `en.uk#holiday`"). |
| `WEATHER_PROVIDER` | no | `nws` \| `open-meteo` \| `none` | Overrides auto-detection (NWS for US coordinates, Open-Meteo elsewhere). See "Weather" below. |

4. Deploy. Visit `https://<your-val>.web.val.run?key=<FEED_SECRET>` in a
   browser — you should get a JSON payload. If instead you get
   `{"error":"config_error","message":"..."}`, the message tells you exactly
   which env var is missing or invalid.

## Step 3 — Create the TRMNL plugin

1. In TRMNL, create a new **Private Plugin**.
2. Strategy: **Polling**, verb **GET**.
3. Polling URL: `https://<your-val>.web.val.run?key=<FEED_SECRET>` — same
   URL you tested in Step 2. (You can instead send the secret as an
   `Authorization: Bearer <FEED_SECRET>` polling header and drop `?key=...`
   from the URL, if you'd rather not have the secret in the URL at all.)
4. Refresh rate: `3600` (1 hour) is a sensible default — matches the
   Open-Meteo cache window (see Weather below).
5. Paste [`src/full.liquid`](src/full.liquid) into the **Full** view. Leave
   the other views empty — this plugin is designed for TRMNL X full-screen
   portrait only (see `src/half_horizontal.liquid` etc. for why).
6. Add the plugin to your playlist and refresh the device (or check the
   `trmnlp` preview — see below).

## Local preview (`trmnlp`)

If you have the `trmnlp` Docker preview tool running (`localhost:4567`):

1. Copy `src/settings.example.yml` to `src/settings.yml`.
2. Fill in your real Val Town URL and `FEED_SECRET` in `polling_url`.
   `src/settings.yml` is gitignored — it will never be committed.
3. Iterate against the live preview rather than screenshots; the canvas is
   fixed at **780×1040 CSS px** (TRMNL X portrait), not the physical panel's
   pixel count.

## Weather

Provider is auto-selected from `LAT`/`LON`:

- **US coordinates → NWS** (weather.gov). Free, keyless, no rate limit,
  gives a genuinely live current temperature from the nearest observation
  station. Cached 30 minutes.
- **Everywhere else → Open-Meteo.** Free, keyless, global — but it shares
  Val Town's outbound IP pool across *all* Val Town users, so it can
  occasionally return `429`. This isn't specific to this app; it's a
  platform-wide tradeoff of using a free shared-IP host against a
  rate-limited API. Cached 1 hour (matches the default `refresh_rate`) to
  keep request volume down, and the middleware serves the last good reading
  if a fetch fails rather than breaking the render — you'll see a brief
  "Weather unavailable" instead.
- You can force a provider (or turn weather off) with `WEATHER_PROVIDER`.

## Security

- The feed endpoint **fails closed**: no `FEED_SECRET` configured means no
  request is ever served, even to someone who has the URL.
- Requests need either `?key=<FEED_SECRET>` or an
  `Authorization: Bearer <FEED_SECRET>` header, checked with a
  timing-safe comparison.
- No `Access-Control-Allow-Origin` header is set, so the JSON isn't readable
  cross-origin from a browser — not that it matters much here, since TRMNL
  polls it server-side, not from a browser.
- Never commit `src/settings.yml` (it embeds your secret in the URL) — it's
  gitignored by default. Don't paste your real `FEED_SECRET` or calendar
  URLs into issues, PRs, or screenshots.

## Troubleshooting

- **`config_error` response** — the JSON body's `message` field lists every
  missing/invalid env var by name.
- **Empty columns** — check `PERSON_CODES` codes match what you're typing in
  event titles (case-insensitive, but the code itself must match exactly),
  and that `ICAL_URL`/`ICAL_URL_<CODE>` point at the right calendars.
- **One person's events missing, others fine** — if using multi-feed mode,
  that person's dedicated feed may be unreachable; check the val's logs for
  a `FEED ERROR (<column>)` line. A broken feed is skipped, not fatal to the
  rest of the board.
- **Weather stuck on "unavailable"** — check the val's logs for a
  `WEATHER ERROR` line; often a transient Open-Meteo `429` that will clear
  on the next cache expiry.
