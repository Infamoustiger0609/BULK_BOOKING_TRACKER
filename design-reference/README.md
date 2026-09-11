# Handoff: BulkBooking Dashboard Redesign (PVR INOX)

## Overview
Internal ops tool for PVR INOX's bulk/corporate booking team. Five pages — Summary, Client Leaderboard, Genre Affinity, Dormant Clients, Client Detail — behind a left sidebar nav with global filters (Financial Year, Month, Region). Surfaces revenue/ticket trends, top clients, genre/industry loyalty patterns, and win-back prospects.

## About the Design Files
The bundled file (`BulkBooking Dashboard.dc.html`) is a **design reference built in an internal HTML prototyping tool**, not production code to copy verbatim. It uses a proprietary component/templating syntax (custom tags like `<x-dc>`, `<sc-if>`, `<sc-for>`, `{{ }}` bindings, a `DCLogic` base class) that will not run as-is in a normal web app. Treat it as a fully-specified visual and behavioral spec — layout, colors, typography, states, chart math, filter logic, CSV export — and **recreate it using your codebase's existing stack** (React/Vue/etc. and its existing component library, routing, and data layer). If no frontend exists yet, React + a lightweight chart approach (inline SVG, as done here — no chart library was used) is the closest match to what's built.

`bookings-data.js` IS plain, dependency-free JavaScript (ES module) — its data-generation and calculation functions can likely be ported directly or lightly adapted into your data layer.

## Fidelity
**High-fidelity.** Exact colors, typography, spacing, and component states are specified below and in the file. Recreate pixel-close using your codebase's existing UI primitives (buttons, tables, dropdowns) rather than inventing new ones, but match these visual values where your primitives don't already define them.

## Screens / Views

### 1. Summary
- 5 KPI cards in a row (`grid-template-columns: repeat(5, 1fr)`, gap 10px): Revenue, Clients, Total Tickets, SPH (spend per head), Avg Ticket Value. Each card: label (9px, uppercase, letter-spacing 0.08em, `#5a5a6e`), big value (Georgia serif, 24px/700), optional delta chip (▲/▼ + %, green `#3f8a5b` / coral `#d9362c`), optional 76×28 SVG sparkline.
- Revenue Trend: full-width line chart, 210px tall, gridlines at 0/50/100%, axis labels as HTML overlays (see Charts note below).
- SPH Trend / ATV Trend: two line charts side by side (`grid-template-columns: repeat(2,1fr)`, gap 14px), 180px tall each.
- Region-wise Revenue (or City-wise, when a single region is filtered): bar chart, 250px tall, 4-color rotation.
- Granularity auto-switches: monthly buckets when exactly one FY is selected, otherwise FY buckets.

### 2. Client Leaderboard
- Two local filter dropdowns (Client Type, Client Category) above 4 KPI cards (Total Revenue, Total Tickets, Active Clients, Top-10 Concentration %).
- Table header row: caption ("All N clients by revenue"), 3-way sort toggle (Revenue/Tickets/Bookings — active pill is dark `#1e1e2c` bg, white text), Export CSV button.
- Scrollable table (max-height 480px, sticky header): rank, client name + type badge, revenue (with % of total + inline bar), tickets, bookings, avg ticket price. Row click → Client Detail.

### 3. Genre Affinity
- Dimension switch (Movie Industry / Language / Category) as a 3-segment pill control.
- Search box to filter by a specific value (e.g. "Hollywood"), with autocomplete dropdown showing match counts; selecting one filters the list and shows a Clear button.
- Business rule shown as a caption: clients with 3+ bookings where one value accounts for 65%+ of bookings.
- 4 KPI cards, then a ranked list (not a table) of loyal clients: name + category badge, inline bar showing the loyal value + its %, revenue + booking count. Row click → Client Detail.

### 4. Dormant Clients
- Caption states the rule: 2+ historical bookings, last booking 6+ months before the dataset's latest activity date.
- 4 KPIs: Dormant Clients, Revenue at Stake, Avg Months Dormant, Reference Date.
- Table: client + badge, coral "DORMANT · Nmo" status pill (bg `#fbdad7`, text `#d9362c`), last booking date, bookings, lifetime revenue. Export CSV. Row click → Client Detail.

### 5. Client Detail
- Back link to whichever page linked here (Leaderboard / Affinity / Dormant — tracked in state).
- Client name (Georgia serif 22px) + category badge.
- 4 KPI cards (Lifetime Revenue w/ sparkline, Lifetime Tickets, Booking Count w/ sparkline, Avg Ticket Price).
- Monthly Revenue (bar chart) + Monthly Booking Count (line chart), side by side.
- Booking Type Mix + Region Breakdown: horizontal stacked segment bars with legend dots below (top 3 values + "Other").
- City Breakdown: top-8 cities as label + inline bar + % rows, 2-column grid.
- Affinity Sections: 3 cards (one per dimension) with the same segment-bar treatment.
- All Bookings table: date, movie, cinema, city, tickets, amount. Sticky header, scrollable (max-height 380px), Export CSV.

## Shared Chrome
- **Sidebar** (dark `#141420`, 224px wide, collapsible to 60px via a toggle button top-right): PVR INOX badge (gold `#e0b50f` bg, dark text), serif wordmark "BulkBooking Dashboard", nav list (Summary / Client Leaderboard / Genre Affinity / Dormant Clients — active item filled teal `#3b8ff3`), footer showing record count + data-through date. Collapsed state shows only first-letter nav labels.
- **Top bar**: sticky, translucent white blur background, page title (Georgia serif 19px), global filter dropdowns pinned right (FY / Month / Region — checkbox multi-select with "Select all", summary text shows "All"/"None"/value/"N selected"). Month options recompute when FY changes.
- All cards: `border-radius: 10px`, `border: 1px solid rgba(30,30,44,0.08)`, gradient bg `linear-gradient(180deg,#fff,#eaeef4)`, shadow `0 1px 2px rgba(30,30,44,.05), 0 4px 12px rgba(30,30,44,.06)`.

## Charts — important implementation note
Charts are hand-built inline SVG (no chart library): `<path>`/`<rect>`/`<circle>` for the geometry, laid out with pixel math in `lineChart()` / `barChart()` (see file). **Axis labels, gridline labels, and bar value/category labels are absolutely-positioned HTML `<div>` overlays** on top of the SVG (matched by `left:%/top:%` to the chart's coordinate space), not SVG `<text>` — this was a deliberate fix for a text-rendering bug in the prototyping tool and is **not required in your stack**. You're free to use real SVG `<text>`, or a proper charting library (Recharts/Visx/D3), as long as the visual result matches: thin gridlines at `rgba(30,30,44,0.08)`, 2px stroke lines, 3px point circles (white fill, colored stroke), rounded bar corners (rx 3), tooltips on hover (native `<title>` in the prototype — use a proper tooltip component in production).

## Interactions & Behavior
- Nav click → switches `page` state; sidebar collapse toggles width + label truncation.
- Global filter dropdowns: click to open, click outside (a full-screen invisible overlay) or the caret to close; changing FY recomputes available Month options and clears/keeps month selection.
- Leaderboard/Affinity/Dormant row click → navigates to Client Detail, remembering which page to "Back" to.
- Affinity search: typing filters an autocomplete list; selecting a result pins the whole page to that value (with a Clear action) instead of a live table filter.
- CSV export buttons trigger an in-browser Blob download (see `downloadCsv` in `bookings-data.js`) — reimplement using your stack's standard file-download pattern.
- Sort toggle (Leaderboard) re-sorts client list client-side, no reload.

## State Management
Needed state: `page`, `fy[]`, `month[]`, `region[]` (global filters), `openFilterKey` (which dropdown is open), `clientType[]`, `clientCategory[]` (leaderboard-local filters), `sortKey`, `affinityDimension`, `affinitySearch`, `affinitySelectedValue`, `selectedClientKey` + `detailOrigin` (for Client Detail + its back link), `sidebarCollapsed`.
Data requirements: a bookings dataset (see schema below) queried/filtered client-side in the prototype; in production this is a natural candidate for server-side filtering/pagination once record volume grows past a few thousand rows.

## Design Tokens
**Colors**
- Ink (text): `#1e1e2c`
- Muted text: `#5a5a6e`
- Background: `#f6f8fb`
- Card gradient: `linear-gradient(180deg, #ffffff 0%, #eaeef4 100%)`
- Sidebar: `#141420`
- Gold (primary accent / revenue): `#f29f67`
- Teal (secondary accent / tickets): `#3b8ff3`
- Jade (clients): `#34b1aa`
- Highlight/brand gold (PVR INOX badge): `#e0b50f`
- Green (positive delta): `#3f8a5b`
- Coral (negative delta / dormant status): `#d9362c`
- Chart color rotation order: Gold → Teal → Jade → Highlight-gold

**Typography**
- UI font: Inter (400/500/600/700/800), fallback `ui-sans-serif, system-ui, sans-serif`
- Display/serif accents (big KPI values, page titles, client names): Georgia, Cambria, 'Times New Roman', serif
- Scale: 9–10px labels (uppercase, letter-spacing 0.06–0.08em) · 11–12px body/table · 15–24px headings/KPI values

**Spacing / Radius**
- Card radius 10px, pill/badge radius 999px, button radius 5–7px
- Page content padding 18px 24px 32px, max content width 1560px
- Card gaps: 10px (KPI grids), 14px (chart grids)

## Assets
No image assets — the design uses inline SVG charts and CSS-drawn UI only. No icons beyond a text-based caret (▾), arrows (▲▼, ←), and the sidebar collapse glyphs («/»).

## Files in this bundle
- `BulkBooking Dashboard.dc.html` — full design reference (markup + logic) for all 5 screens.
- `bookings-data.js` — plain JS data generator + calculation/formatting helpers (currency/number/date formatting, filtering, aggregation, client indexing, affinity/dormancy detection, CSV export). Directly portable logic.
- Note: `support.js` (the prototyping tool's runtime shim) is intentionally **not** included — it has no equivalent in a real codebase and should be ignored.
