# BulkBooking Dashboard — Project Reference

This file is the single source of truth for any Claude session (or human) picking up this
project cold. Read this before touching code. It explains what the project is, how data
flows through it, every file's role, the conventions that must not be broken, and the
history of decisions that shaped the current state.

## 1. What this project is

PVR INOX's bulk-booking sales team tracks corporate/bulk cinema bookings (corporate movie
screenings, school bookings, birthday events, gift cards, etc.) in a hand-maintained Excel
workbook with **42 monthly sheets** (`BULK BOOKING SALES TRACKER.xlsx`, one sheet per
month from roughly Apr 2022 to mid-2026, inconsistent column names/formats across sheets
because it's been edited by hand for years).

This project turns that workbook into a live, filterable analytics dashboard:

```
BULK BOOKING SALES TRACKER.xlsx
        │  (node etl.cjs)
        ▼
data/bookings.json  +  5 companion report JSONs (data-quality artifacts)
        │  (npm run sync-data, auto-runs before dev/build)
        ▼
public/data/bookings.json
        │  (fetched at runtime by the React app)
        ▼
React + Vite dashboard  →  deployed on Vercel, source on GitHub
```

There is **no backend/database**. The dashboard is a static site that fetches a static
JSON file. All "querying" (filtering, aggregation, grouping) happens client-side in
JavaScript against the full in-memory record array.

- GitHub: `https://github.com/Infamoustiger0609/BULK_BOOKING_TRACKER`
- Deploy: Vercel (auto-deploys on push to `main` via Vercel's GitHub integration)
- Local dev: `npm run dev` (Vite)

## 2. Repo layout

```
BULK BOOKING SALES TRACKER.xlsx    the raw source workbook (git-ignored, never pushed)
etl.cjs                            the ETL: xlsx -> data/*.json (run manually, not on every build)
verify-filters.js                  standalone ground-truth test script for filter/aggregation logic
scripts/syncData.js                copies data/bookings.json -> public/data/bookings.json (auto, pre-dev/pre-build)
data/                               ETL OUTPUT — tracked in git (see §7, Vercel needs it)
  bookings.json                     the unified dataset the whole app runs on (5,968 records)
  flaggedValues.json                categorical values the ETL couldn't confidently auto-correct
  dataIssues.json                   rows/fields that failed to parse (dropped or nulled)
  regionDerivations.json            audit trail of how each record's `region` was inferred
  nullCityRows.json                 rows where `city` ended up null, for manual review
  unresolvedCityRows.json           superset report of every still-open city/region gap (see §6)
public/
  data/bookings.json                the file the running app actually fetches (git-ignored, regenerated)
  pvr-inox-logo.jpeg, favicons
design-reference/                   a one-time external design spec used for a redesign pass (see §8) — reference only, not imported by the app
  README.md, BulkBooking Dashboard.dc.html, bookings-data.js
src/
  App.jsx                           React Router route table
  main.jsx                          Vite entry point
  index.css                         Tailwind v4 CSS-first @theme — every design token (see §5)
  lib/
    BookingsProvider.jsx            fetches bookings.json once, holds ALL global filter state, React context
    dataUtils.js                    the entire data/business logic layer — pure functions, no React (see §4)
    filterState.js                  pure checkbox-toggle helpers for FilterBar
    format.js                       formatCurrency/formatNumber/formatDate/formatPercent etc.
    csv.js                          toCsv/downloadCsv — pure CSV export helpers
    chartLabel.jsx                  shared Recharts label/axis-tick renderers
    useDropdownPanel.js             hook for animated dropdown open/close (multi-select filters)
  components/                       presentational + shared interactive components (see §5)
  views/                            one file per route/page (see §3)
Data inconsistencies to be fixed.txt   living data-quality punch list, kept in sync with data/*.json (see §6)
CLAUDE.md                           this file
```

## 3. Pages (routes)

Router: `src/App.jsx`, all routes nested under `<Layout />` (sidebar + top bar chrome).
Default route redirects to `/summary`.

| Route | File | Purpose |
|---|---|---|
| `/summary` | `views/Summary.jsx` | KPI overview (revenue, tickets, clients, SPH, ATV) with sparklines, period-over-period delta badges, a revenue trend chart, top-15-cities and top-10-region revenue bar charts. Only the 3 global filters apply here. |
| `/leaderboard` | `views/Leaderboard.jsx` | Ranked client table (by revenue/tickets/bookings), Client Type + Client Category page-local filters on top of the global filters, revenue-concentration KPI (top 10 clients' % of total), CSV export, row click → Client Detail. |
| `/affinity` | `views/Affinity.jsx` | "Genre loyalty" — which clients are ≥65%-loyal (≥3 bookings) to one Movie Industry / Language / Category value; reverse-lookup by value ("who's loyal to Hollywood"), search, row click → Client Detail. |
| `/dormant` | `views/Dormant.jsx` | Win-back prospecting list: clients with ≥2 historical bookings whose last booking was ≥6 months before the dataset's latest activity date, sorted by revenue at stake. CSV export. |
| `/client/:clientKey` | `views/ClientDetail.jsx` | Per-client drill-down: monthly revenue trend, affinity distributions, full booking history table, CSV export. "← Back to ..." respects which list page linked here (via router state), defaults to Leaderboard. |

All 4 list-ish pages (Summary/Leaderboard/Affinity/Dormant) share the same global header
filters (Financial Year, Month, Region) via `BookingsProvider` — switching tabs never
resets that selection. Client Type / Client Category filters are page-local to Leaderboard
only.

## 4. Data & business logic layer (`src/lib/dataUtils.js`)

This is the most important file to understand — it's the single source of truth for every
number the dashboard shows. **No component computes a metric itself**; every view calls
into here. Rules baked into this file that must not be violated:

- **Rates are never averaged directly.** SPH is ticket-weighted (`Σ sph·tickets / Σ
  tickets`); ATV is derived from aggregated totals (`Σ totalAmount / Σ tickets`), never by
  averaging each record's own `atp`/`sph` field. `aggregateMetrics()` is the only function
  that computes these, and every KPI card + every trend chart calls it — so the header KPI
  and a chart can never disagree about how a rate was aggregated.
- **Standard checkbox filter semantics** (documented at length in the file, §"Multi-select
  filter semantics"): a filter's state is always an *explicit array of ticked values*.
  `[]` means "nothing ticked, matches nothing" — never "everything". "Everything selected"
  is an explicit array containing every current option. Fields with null/blank values get
  a synthetic `BLANK_FILTER_VALUE` option ("(No value)") that must itself be ticked for
  those records to show — this is deliberate, to prevent silent undercounting.
- **Global vs. page-local filters are separate functions**: `applyGlobalFilters()` (FY +
  Month + Region, lives in `BookingsProvider`) vs. `applyClientFilters()` (Client
  Type/Category, page-local). `applyStandardFilters()` is an older combined function kept
  only because `verify-filters.js`'s broader tests still call it — the app itself always
  calls the two separately now.
- **Financial Year is Apr–Mar**, not calendar year. `financialYearOf()`/
  `getFinancialYearRange()`/`financialYearLabel()` are the only places FY math happens.
- **Trend granularity auto-adapts**: month-level bars when exactly one FY is selected,
  year-level (by FY) otherwise. KPI sparklines go one step finer still (drops to
  week-of-month once the view is narrowed to a single month). Week-of-month is derived
  from `dateOfScreening`'s day-of-number (days 1–7 = wk1, etc.), not the source workbook's
  own inconsistent `week` column.
- **"Prior period" for delta badges** (`getPriorPeriodFilter`) is only well-defined for a
  single FY (→ prior FY) or a single FY + single month (→ prior calendar month). Any other
  selection (0, 2+, or "all" FYs; a partial multi-month pick) has no single well-defined
  prior, so the delta badge renders nothing — this is intentional, not a bug.
- **Client identity** (`normalizeClientKey`) = trimmed, whitespace-collapsed, lowercased
  `corporateName || clientName`. This key is used everywhere a client needs to be grouped
  or looked up (Leaderboard, Affinity, Dormant, `/client/:clientKey`). **No typo-correction
  happens on client names** (unlike city/movieIndustry/movieLanguage) — see §6 item 7, this
  is a known open gap.
- **Dormancy reference date** is always the dataset's true latest activity date
  (`getDatasetReferenceDate`), regardless of the current global filter — narrowing the view
  to a past period must not change what "now" means for dormancy math.
- **Affinity/"loyalty"** = a client with ≥3 bookings where one value of a dimension
  (movieIndustry / movieLanguage / movieCategory) accounts for ≥65% of their bookings. A
  client can be loyal on more than one dimension simultaneously.

`BookingsProvider.jsx` fetches `/data/bookings.json` once on mount, builds the client index
and derived filter options via `useMemo`, and resolves each filter's "not yet touched by
the user" (`null`) state to "everything selected" **synchronously during render** — never
via an effect, which would flash an empty result for one frame.

## 5. Design system (`src/index.css`, components)

Tailwind v4, CSS-first `@theme` tokens (not a `tailwind.config.js`). Full palette, with its
intended meaning per the comments in `index.css`:

| Token | Hex | Meaning |
|---|---|---|
| `--color-ink` | `#1e1e2c` | headers, dividers, emphasis cards, body text |
| `--color-ink-2` | `#141420` | header bar / active nav (deeper shade) |
| `--color-ink-soft` | `#5a5a6e` | muted secondary/meta text |
| `--color-cream` | `#f6f8fb` | page background |
| `--color-cream-2` | `#eaeef4` | card background, one step down from cream |
| `--color-gold` | `#f29f67` | primary accent — **revenue/monetary figures**, primary actions |
| `--color-teal` | `#3b8ff3` | secondary accent — **volume figures** (tickets, footfalls) |
| `--color-jade` | `#34b1aa` | tertiary accent — a third distinct data meaning (e.g. booking counts) |
| `--color-highlight` | `#e0b50f` | chrome only — active filter, selected tab, ranking badges. **Never a data series.** |
| `--color-coral` | `#d9362c` | negative deltas, warnings, dormant-client alerts only |
| `--color-green` | `#3f8a5b` | positive deltas only |

Each accent has a `-soft` tint variant for backgrounds/badges. **Respect the semantic
assignment** — gold is always money, teal is always volume, highlight is never used to
encode data. This mapping was deliberately chosen in an earlier redesign pass and is relied
on throughout the KPI cards and charts.

Shared component patterns:
- `.card`, `.row-interactive`, `.interactive`, `.dropdown-panel` — shared CSS classes for
  elevation/hover/interaction states, used across components rather than repeated inline.
- `useDropdownPanel.js` — the hook behind every animated multi-select filter dropdown
  (`FilterBar`, `GlobalFilters`).
- `KPICard` — the one component every page's stat tiles go through (label, value,
  optional delta badge, optional sparkline, optional `valueColor`).
- `ChartTooltip`, `chartLabel.jsx` (`AXIS_TICK_STYLE`, `verticalBarLabel`, `pointLabel`) —
  shared Recharts styling so every chart's tooltip/axis/label typography matches.
- `ExportCsvButton` + `src/lib/csv.js` — CSV export, used on Leaderboard/Dormant/
  ClientDetail. `toCsv`/`downloadCsv` are pure formatting utilities ported from the design
  reference bundle (see §8) — deliberately the *only* thing ported from that bundle,
  because they're pure formatting with no business logic.

Chart library: **Recharts** (kept, after an explicit evaluation during the redesign — see
§8) — `BarChart`, `ComposedChart`, area/line charts throughout.

## 6. Data quality — what's clean, what's still open

The workbook is hand-maintained across 42 sheets with inconsistent headers, spellings, and
formats. `etl.cjs` does **aggressive but conservative** normalization: it will
auto-canonicalize a value it's confident about, but it will **never guess** — anything
ambiguous gets flagged into a report file instead of silently "fixed."

**Current state (last ETL run):** 5,968 total records, 219 canonical distinct cities (down
from 393 raw values), 75/75 `verify-filters.js` checks passing, clean production build.

Two files together describe data quality and must be kept in sync with each other and with
the live `data/*.json` files whenever the ETL changes:

- **`Data inconsistencies to be fixed.txt`** — the human-readable running punch list,
  organized by report file, with a "DONE" section at the top listing what's already been
  resolved. **Always re-verify this file's numbers against the live JSON files before
  trusting it** — it's a snapshot, and has gone stale before (see history below).
- **`data/unresolvedCityRows.json`** — the comprehensive machine-readable version of the
  same open gaps, three `gapType`s: `state-name-in-city-unresolved` (a handful of rows
  where even the cinema name doesn't resolve the city), `correctly-spelled-state-name-in-
  city-field` (a real state name sitting in the `city` column instead of a city — these
  never got flagged as *suspicious* because they're spelled correctly, just wrong), and
  `unresolved-cinema-location` (region is null because `cinemaLocation` doesn't match
  anything in the region-derivation maps — many of these need PVR's own internal property
  list to identify, not a general web search).

**Still open as of the last pass** (see the txt file for exact current counts — do not
hardcode these numbers into other docs, they change every ETL run):
1. A residual set of flagged city values needing a human judgment call (ambiguous
   one-offs, plus some high-volume-but-unreviewed real place names).
2. A couple of individually-unresolved rows where even the named cinema/mall isn't enough
   to confirm a city.
3. Rows with a correctly-spelled state name sitting in the city field.
4. Rows with an unrecognized `cinemaLocation` (region stays null) — many tied to
   old "Year 2022 data" sheet's now-defunct region coding.
5. `bookingType` has a few flagged-but-legitimate distinct categories (Web Lead, School
   Booking, Birthday, Event, Physical Gift Cards) — **confirmed not a data problem**, they
   are genuinely distinct categories, not typos.
6. Unparseable/dropped rows in `dataIssues.json` (bad month/date/amount/clientType values).
7. **Client name normalization is not audited.** `normalizeClientKey` does zero
   typo-correction, unlike city/movieIndustry/movieLanguage — this could be inflating the
   distinct-client count with near-duplicate misspelled names. Would need the same
   edit-distance review treatment as city if it starts affecting Leaderboard/Dormant
   accuracy.

### The normalization engine (`etl.cjs`)

- `CITY_CANON`, `MOVIE_INDUSTRY_CANON`, `MOVIE_LANGUAGE_CANON` — curated maps of known
  misspelling → canonical value (or → `null` for a known non-city value, e.g. a state name
  that leaked into the city field — nulled rather than guessed).
- `normalizeCategoricalField(allRecords, field, curatedMap, flagKey)` — the generic engine
  behind all of the above: curated-map entries always resolve first (bypassing frequency);
  remaining raw values resolve most-frequent-first, checked via Levenshtein edit-distance
  against already-resolved canonical values (`closeMatchThreshold`); only ever auto-merges
  through the curated map — everything else either flags-if-uncertain or self-canonicalizes
  as its own new canonical value. **This function must never be changed to guess** — that's
  the whole point of the flagged-values report existing.
- `resolveRegions(allRecords)` — derives `region` for records missing it via majority-vote
  city→region and cinemaLocation→region maps, built only from records that already have
  both a real city/cinemaLocation *and* a real region. Full audit trail written to
  `regionDerivations.json`.
- `MANUAL_CITY_BY_ROW` — a hand-confirmed override table keyed by `` `${sourceSheet}|
  ${_excelRow}` ``, applied *before* the general city normalizer runs, for specific rows
  where a state name leaked into `city` but the `cinemaLocation` value was enough to
  identify the real city with certainty (confirmed one row at a time with the user, never
  inferred automatically). Rows deliberately left out of this table (because the named
  mall/cinema was still ambiguous) flow through to `unresolvedCityRows.json` instead.
- A near-identical override pattern exists for "Sapna Sngeeta Inox" cinemaLocation rows,
  whose `city` field held a corrupted literal string (`"Ci"`) rather than being blank —
  forced to `Indore` (confirmed via public listing) regardless of the garbage `city` value.
- `movieCategory` "na"/"NA"/"Na" string values are coerced to real `null`.

**Standing principle for any future data-cleanup pass**: verify claims against the live
`data/*.json` output with a quick `node -e "..."` one-liner rather than trusting memory or
a prior report — this project has caught real regressions this way (a stale client-key
count, a corrupted city value assumed to be blank, a false-positive flag introduced as a
side effect of adding a new canonical city). Never auto-merge an ambiguous value; when in
doubt, flag it into a report and ask.

## 7. Deployment (GitHub + Vercel)

- Repo: `https://github.com/Infamoustiger0609/BULK_BOOKING_TRACKER` (`origin`, branch
  `main`). Vercel auto-deploys on every push via its GitHub integration.
- **`.gitignore`**: excludes `node_modules/`, `dist/`, `public/data/` (regenerated by
  `sync-data`, not source), `.DS_Store`, and `*.xlsx` (the raw source workbook — never
  pushed, per explicit instruction: no raw workbook or anything sensitive on GitHub).
  **`data/*.json` IS tracked** — this was a deliberate fix (see history below): Vercel's
  `prebuild` step (`sync-data`) needs `data/bookings.json` to physically exist in the
  cloned repo, since Vercel never runs `etl.cjs` (no access to the xlsx workbook, which is
  intentionally excluded).
- **Ongoing workflow**: whenever `etl.cjs` is re-run locally (new data, corrections, etc.),
  the regenerated `data/*.json` files must be `git add`ed and committed/pushed for Vercel's
  next deploy to pick up the change. This is a manual step — nothing automates it.
- `scripts/syncData.js` has a safety check: if `data/bookings.json` doesn't exist, it
  exits with a clear error rather than silently building a broken app. Do not remove this
  check — it's what originally surfaced the missing-file Vercel build failure.
- Vercel CLI is available locally (`npx --no-install vercel`), already authenticated.

## 8. History of major changes (for context, not to redo)

These are already done — don't re-litigate them, but they explain *why* the code looks the
way it does:

1. **Initial ETL + dashboard build** — 42-sheet workbook unified into one schema, initial
   Leaderboard/Affinity/Dormant/Summary/ClientDetail views built.
2. **Data-inconsistency audits** — multiple rounds of finding and reporting (then fixing)
   gaps: city misspellings, region derivation, flagged categorical values, unparseable
   rows. See §6.
3. **Visual redesign passes** — several rounds of re-theming (navy/blue/orange/amber, then
   the current specific hex palette in §5), then a depth/elevation/typography/interaction
   pass that introduced the shared `.card`/`.row-interactive`/`.dropdown-panel` classes and
   `useDropdownPanel.js`.
4. **Full redesign against an external design spec** (`design-reference/` — a one-time
   input, not a live dependency) done in 4 phases: (1) sidebar/top-bar chrome + design
   tokens ported verbatim, (2) chart-library decision — Recharts was **kept** after
   evaluation, only exact visual values (stroke width, dot styling, bar radius) were
   matched to spec, (3) page content rebuilt to spec (KPI typography, grid gaps, and the
   CSV export feature was added new), (4) regression pass extending `verify-filters.js` to
   75/75 checks. **Important constraint from that pass, still binding**: the design
   reference's own data file (`bookings-data.js`) and its calculation functions were never
   to be ported or imported — only pure formatting/CSV utilities (`formatCurrency`,
   `toCsv`, `downloadCsv`, etc.) were pre-approved for reuse. This app's own
   `dataUtils.js`/`BookingsProvider.jsx` implementations remain the only source of business
   logic — the design reference is a visual/structural reference only.
5. **GitHub push** — pushed everything except the raw `.xlsx` workbook, per explicit
   instruction that nothing else was sensitive.
6. **Vercel build failure fix** — `data/*.json` had been gitignored (too broad an initial
   `.gitignore`), so it existed locally but never reached GitHub, so Vercel's `sync-data`
   prebuild step failed. Fixed by un-ignoring `data/*.json` and committing it; verified via
   a genuine fresh `git clone` that `sync-data` succeeds without needing `etl.cjs` to run
   first. This is why `data/` is tracked but `public/data/` is not (§7).
7. **Large confirmed-corrections batch** (most recent ETL change) — 8 new city canonical
   merges, 18 rows resolved via a per-row manual cinemaLocation-based city override table,
   4 corrupted-city "Sapna Sngeeta Inox" rows fixed, 1,525 `movieCategory` "na" values
   coerced to null, and the new comprehensive `unresolvedCityRows.json` report introduced.
   Also fixed two unrelated bugs found along the way: a corrupted leading-whitespace-before-
   shebang syntax error in `etl.cjs`, and a false-positive "VASHI" flag regression caused
   as a side effect of adding "Nashik" as a new canonical value (fixed by pinning `vashi:
   'Vashi'` as its own curated entry).

## 9. Working conventions for this project

- **Never guess a data value.** If a categorical value or a city/region can't be confirmed
  with certainty, flag it into a report file and ask — don't auto-merge or infer, even when
  a plausible answer exists. This is the single most important rule in the codebase and is
  enforced throughout `etl.cjs`.
- **Verify against live data before reporting.** Run a real `node -e "..."` one-liner
  against the current `data/*.json` rather than trusting a memory of past state or an old
  report file — this project has been burned by stale numbers before.
- **`dataUtils.js` is the only place business logic lives.** Views must call into it, never
  recompute a metric inline. Keep this discipline when adding new pages/features.
- **`verify-filters.js` is the regression gate.** Run it after any `etl.cjs` or
  `dataUtils.js` change; it should stay at 100% passing (currently 75/75).
- **After any `etl.cjs` re-run**, remember to `git add`/commit/push the regenerated
  `data/*.json` files, or Vercel's next deploy will keep serving stale data.
- **Respect the color semantics** in §5 (gold = money, teal = volume, highlight = chrome
  only) when adding new charts or KPI cards.
- Financial Year is Apr–Mar throughout the app — never treat FY as calendar year.
