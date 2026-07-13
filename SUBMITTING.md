# Publishing this plugin

Two independent things you can do: publish to GitHub (so people can find and
deploy their own copy), and/or publish to TRMNL as a "Recipe" (so people can
one-click install it, and it appears in TRMNL's own directory). You don't
need to do both, and you don't need to do TRMNL's review process at all —
"Unlisted" skips it. Verify against TRMNL's current docs before submitting;
their process does change.

## Before you publish anything

- [ ] Double-check nothing personal is committed: search the repo for your
      real calendar URL, `FEED_SECRET`, family names, and home coordinates.
      `git grep` is your friend. `src/settings.yml` should not exist in the
      repo (it's gitignored) — only `src/settings.example.yml` with
      placeholders.
- [ ] Fill in the `[Your Name]` placeholder in `LICENSE`.
- [ ] Add a real screenshot (README.md has a placeholder note for this) —
      capture it from your own `trmnlp` preview or device with demo/fake
      event data, not your family's real calendar contents.

## Publishing to GitHub

1. `git init`, commit everything in this folder, push to a new public repo.
2. Add the `trmnl` topic to the repo (Settings → topics) — TRMNL's community
   showcase pulls from repos tagged this way.
3. Consider opening a PR against [usetrmnl/plugins](https://github.com/usetrmnl/plugins)
   or posting in the TRMNL Discord if you want more visibility beyond the
   topic tag.

## Publishing to TRMNL as a Recipe

TRMNL's private-plugin file format is exactly what's in `src/` here
(`settings.yml` + `full.liquid` / `half_horizontal.liquid` /
`half_vertical.liquid` / `quadrant.liquid`), so this repo doubles as a ready
private-plugin export.

1. Build it as a **Private Plugin** in the TRMNL UI first (paste in
   `full.liquid`, configure `settings.yml`-equivalent fields, point the
   polling URL at your own deployed val) and confirm it renders correctly.
2. On the plugin's settings page, click **Publish plugin?**.
3. TRMNL's linter ("Chef") runs automated checks; the TRMNL team then
   manually reviews (their docs currently say ~1-2 days). Once approved it's
   listed at `trmnl.com/recipes` and you become "recipe master" — future
   edits you push propagate automatically to everyone who installed it.
4. If you'd rather skip review (e.g. mature-content default, or you just
   don't want the review cycle), publish as **Unlisted** instead — same
   shareable link, no moderation, but it won't appear in TRMNL's public
   directory or get promoted by the team.

### Things TRMNL's review looks for (verify current requirements before submitting — this list can go stale)

- **`author_bio`** with at least one real contact method for support
  requests — publishing a recipe is an ongoing support commitment, not a
  one-time upload.
- **No personal data** in the shipped config — demo/placeholder values only.
  This repo's defaults are already placeholders; don't accidentally publish
  your own filled-in `settings.yml`.
- **Distinct value** — a quick look at existing recipes at `trmnl.com/recipes`
  to make sure this isn't a near-duplicate of something already there.
- **Layout discipline** — no horizontal cutoff or vertical overflow, tested
  in the TRMNL preview at the correct canvas size (780×1040 for TRMNL X
  portrait — not the physical panel's pixel count).
- Since only the `full` view is implemented, expect this to be described in
  the submission as "TRMNL X full-screen portrait" rather than a
  universal-layout plugin — that's a deliberate scope choice (see
  `src/half_horizontal.liquid`'s comment), not an oversight, but it's worth
  calling out explicitly to reviewers.

### The "each installer plugs in their own secret" mechanism

Because this plugin's backend (Val Town) is entirely self-hosted per family,
there's no shared secret or calendar to protect at the recipe level — every
installer deploys their own val and pastes their own polling URL (with their
own `FEED_SECRET`) into their own plugin instance, exactly as described in
[SETUP.md](SETUP.md). Nothing about one family's setup is visible to, or
shared with, another installer of the same recipe.
