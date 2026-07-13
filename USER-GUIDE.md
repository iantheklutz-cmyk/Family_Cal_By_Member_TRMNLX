# Adding events to the family calendar

A quick cheat-sheet for adding events so they show up correctly on the
calendar display.

## Which mode does your family use?

Ask whoever set up the calendar — it'll be one of these:

- **Everyone shares one calendar** and events get routed by a short code at
  the start of the title → use the tagging rules below.
- **Everyone has their own calendar** → just add events to your own
  calendar normally. Nothing to type, no tags needed — it shows up under
  your own column automatically. (You can skip the rest of this guide.)
- **Both** — your personal events go straight to your column; add
  something to the shared calendar (or tag it) if it's a household event
  everyone should see, or if you want to put it on someone else's column.

## Tagging cheat-sheet (shared-calendar mode)

Whoever set this up should fill in the table below with your family's real
codes (from `PERSON_CODES` in the setup) — here's a filled-in example:

| Code | Person |
|---|---|
| `P1` | Parent 1 |
| `P2` | Parent 2 |
| `K1` | Kid 1 |
| `K2` | Kid 2 |
| `FF` | Friends & Family |

**To tag an event, start the title with the code and a colon:**

```
P1: Dentist appointment
```
→ shows up only under Parent 1's column.

**Multiple people at once** — separate codes with a space, `/`, or `,`:

```
K1 K2: Piano recital
```
→ shows up under both kids' columns.

**No tag?** The event goes to the default column (usually whoever owns the
shared calendar) — ask your setup person which column that is.

**Case doesn't matter** — `ff:`, `FF:`, and `Ff:` all work the same.

## Tips

- The colon right after the code is required — `IL Dentist` (no colon)
  won't be recognized as a tag and the whole thing becomes the title.
- Keep titles reasonably short — long titles get truncated on the display.
- **Multi-day events** (vacations, trips) — just set the event to span
  multiple days as usual; the display automatically collapses it into a
  single bar instead of repeating it every day.
- Want something to visually pop (a small star icon)? End the title with an
  exclamation point, e.g. `Family reunion!`.
- Certain keywords automatically get a small icon — no need to do anything
  special, just use natural words in the title: `birthday`, `anniversary`,
  `vacation` / `trip` / `travel`, `baby shower` / `due date`, `visiting` /
  `in town` / `guests`.
