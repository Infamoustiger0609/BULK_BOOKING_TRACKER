#!/usr/bin/env node
/**
 * ETL: unifies all sheets of the Bulk Booking Sales Tracker workbook into one JSON dataset.
 * Usage: node etl.cjs path/to/file.xlsx
 * (renamed from etl.js -> etl.cjs because the dashboard's package.json sets
 * "type": "module", which would otherwise make Node treat this CommonJS
 * script's `require()` calls as an error)
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DEFAULT_INPUT = 'BULK BOOKING SALES TRACKER.xlsx';
const OUT_DIR = path.join(__dirname, 'data');
  
// ---------------------------------------------------------------------------
// Header name -> unified schema field. Anything not listed here is dropped
// (this also drops "Zone (India A/B)" and the invoice/payment tracking
// columns that only exist on a couple of 2025 sheets).
// Month, Total Amount / TOTAL GBOC + GCC and Date Of Screening are handled
// separately because they need parsing rather than a straight copy.
// ---------------------------------------------------------------------------
const HEADER_ALIASES = {
  'sr.no': 'srNo',
  'week': 'week',
  'client type': 'clientType',
  'client name': 'clientName',
  'corporate name': 'corporateName',
  'industry': 'industry',
  'booking type': 'bookingType',
  'region': 'region',
  'city': 'city',
  'cinema location': 'cinemaLocation',
  'movie name': 'movieName',
  'no. of tickets (footfalls)': 'tickets',
  'atp': 'atp',
  'sph': 'sph',
  'gboc (lacs)': 'gboc',
  'gcc (lacs)': 'gcc',
  'branding': 'branding',
  'movie industry': 'movieIndustry',
  'movie langaguage': 'movieLanguage',
  'audi format': 'audiFormat',
  'movie category': 'movieCategory',
  'weekday/weekend': 'weekdayWeekend',
  'campaign/remarks': 'remarks',
  'any remarks while execution': 'remarks',
  'remarks': 'remarks',
};
const TOTAL_AMOUNT_HEADERS = new Set(['total amount', 'total gboc + gcc']);
const MONTH_HEADER = 'month';
const DATE_OF_SCREENING_HEADER = 'date of screening';

const SCHEMA_FIELDS = [
  'srNo', 'week', 'month', 'year', 'clientType', 'clientCategory', 'clientName', 'corporateName',
  'industry', 'bookingType', 'region', 'city', 'cinemaLocation', 'movieName',
  'dateOfScreening', 'tickets', 'atp', 'sph', 'gboc', 'gcc', 'branding',
  'totalAmount', 'movieIndustry', 'movieLanguage', 'audiFormat', 'movieCategory',
  'weekdayWeekend', 'remarks', 'sourceSheet',
];

const MONTH_NAME_TO_NUM = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// ---------------------------------------------------------------------------
// Reporting accumulators
// ---------------------------------------------------------------------------
const flaggedValues = { bookingType: new Map(), clientCategory: new Map(), movieIndustry: new Map(), movieLanguage: new Map(), city: new Map(), clientName: new Map(), corporateName: new Map() };
const dataIssues = [];
const recordsPerSheet = {};

function flagValue(field, rawValue, sheet, row, clientName) {
  const key = String(rawValue).trim();
  const map = flaggedValues[field];
  if (!map.has(key)) map.set(key, { count: 0, examples: [] });
  const entry = map.get(key);
  entry.count += 1;
  if (entry.examples.length < 3) entry.examples.push({ sheet, row, clientName: clientName || null });
}

function logIssue(sheet, row, field, rawValue, reason) {
  dataIssues.push({ sheet, row, field, rawValue: rawValue === undefined ? null : rawValue, reason });
}

// ---------------------------------------------------------------------------
// Excel date helpers
// ---------------------------------------------------------------------------
function excelSerialToISODate(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function excelSerialToYearMonth(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function monthsDiffCtx(a, b) {
  return Math.abs((a.year - b.year) * 12 + (a.month - b.month));
}

// "Apr`22" -> { year: 2022, month: 4 }
function parseYear2022MonthText(text) {
  if (text == null) return null;
  const m = String(text).trim().match(/^([A-Za-z]{3})`(\d{2})$/);
  if (!m) return null;
  const monthNum = MONTH_NAME_TO_NUM[m[1].toLowerCase()];
  if (!monthNum) return null;
  return { year: 2000 + parseInt(m[2], 10), month: monthNum };
}

// Fallback: derive year/month from the sheet's own tab name, e.g. "Aug - 2024".
function parseSheetName(name) {
  const m = String(name).match(/([A-Za-z]+)\D*(\d{4})/);
  if (!m) return null;
  const monthNum = MONTH_NAME_TO_NUM[m[1].toLowerCase()];
  if (!monthNum) return null;
  return { year: parseInt(m[2], 10), month: monthNum };
}

// Resolves messy "Date Of Screening" strings ("7th Aug", "21st-Sep", "18.07.2026")
// against the sheet's own year/month context.
function parseDateOfScreening(raw, context, sheet, row) {
  if (raw == null || String(raw).trim() === '') return null;
  if (typeof raw === 'number') {
    const iso = excelSerialToISODate(raw);
    if (context) {
      const d = new Date(iso);
      const diffMonths = monthsDiffCtx({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }, context);
      if (diffMonths > 2) {
        logIssue(sheet, row, 'dateOfScreening', raw, `resolves to ${iso}, ${diffMonths} months from the booking's own ${context.year}-${String(context.month).padStart(2, '0')} — likely a data entry error`);
        return null;
      }
    }
    return iso;
  }

  const text = String(raw).trim();

  let m = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
  if (m) {
    let [, day, month, year] = m;
    year = year.length === 2 ? 2000 + parseInt(year, 10) : parseInt(year, 10);
    day = parseInt(day, 10);
    month = parseInt(month, 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
    }
  }

  m = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-]*([A-Za-z]+)\.?$/i);
  if (m) {
    const day = parseInt(m[1], 10);
    const monthNum = MONTH_NAME_TO_NUM[m[2].toLowerCase()];
    if (monthNum && day >= 1 && day <= 31 && context) {
      let year = context.year;
      if (monthNum <= 2 && context.month >= 11) year += 1;
      else if (monthNum >= 11 && context.month <= 2) year -= 1;
      return new Date(Date.UTC(year, monthNum - 1, day)).toISOString().slice(0, 10);
    }
  }

  logIssue(sheet, row, 'dateOfScreening', raw, 'unparseable date string');
  return null;
}

function coerceTotalAmount(raw, sheet, row) {
  if (raw == null || String(raw).trim() === '') return null;
  if (typeof raw === 'number') return raw;
  const cleaned = String(raw).replace(/,/g, '').trim();
  const num = Number(cleaned);
  if (cleaned === '' || Number.isNaN(num)) {
    logIssue(sheet, row, 'totalAmount', raw, 'non-numeric total amount');
    return null;
  }
  return num;
}

function toNumberOrNull(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  if (typeof raw === 'number') return raw;
  const num = Number(String(raw).replace(/,/g, '').trim());
  return Number.isNaN(num) ? null : num;
}

// ---------------------------------------------------------------------------
// Categorical normalization (region / booking type / client type)
// ---------------------------------------------------------------------------
const CANONICAL_REGION_MAP = { west: 'West', north: 'North', south: 'South', east: 'East', central: 'Central' };

// The "direct recognition" half of region normalization — everything
// resolveRegions() below can decide WITHOUT falling back to a city/
// cinemaLocation-based derivation. Pulled out on its own so the Year-2022
// manual region-correction override (main()) can canonicalize its values
// the same way resolveRegions would, without going through the full
// derivation pass (that file's Region values are meant to be trusted
// directly, not re-derived).
function canonicalizeDirectRegion(raw) {
  const lower = raw == null ? null : String(raw).trim().toLowerCase();
  if (!lower) return null;
  if (CANONICAL_REGION_MAP[lower]) return CANONICAL_REGION_MAP[lower];
  // "North East" is no longer a distinct region — full merge into "North",
  // dataset-wide, supersedes the earlier decision to keep it separate.
  if (lower === 'ne' || lower === 'north east' || lower === 'northeast') return 'North';
  if (lower === 'multi') return 'Multi';
  if (lower === 'sount') return 'South';
  return null; // not directly recognized — caller decides what to do
}

// Region is normalized in two passes: parseMonthlySheet/parseYear2022Sheet store
// the raw trimmed value on record.region; resolveRegions() (called once all
// sheets are parsed, so a workbook-wide city lookup can be built) does the
// final normalization/derivation. See resolveRegions() below.

function normalizeBookingType(raw, sheet, row, clientName) {
  if (raw == null || String(raw).trim() === '') return null;
  const norm = String(raw).trim().replace(/\s+/g, ' ');
  const lower = norm.toLowerCase();
  if (lower.includes('bulk') && (lower.includes('book') || lower.includes('bok'))) return 'Bulk Booking';
  if ((lower.includes('pvt') || lower.includes('private')) && lower.includes('scre')) return 'Private Screening';
  if (lower === 'physcial guft cards') {
    flagValue('bookingType', 'Physical Gift Cards', sheet, row, clientName);
    return 'Physical Gift Cards';
  }
  flagValue('bookingType', norm, sheet, row, clientName);
  return norm;
}

// Values that aren't actually New/Existing (Corporate, Trustee, Web Lead, ...)
// look like they belong to a different dimension (industry/relationship type),
// so they're split out into clientCategory instead of being forced into
// clientType. Casing/typo variants are merged into one canonical spelling.
const CLIENT_CATEGORY_MAP = {
  'corporate': 'Corporate',
  'trustee': 'Trustee',
  'web lead': 'Web Lead',
  'wl': 'Web Lead',
  'agency': 'Agency',
  'distributor': 'Distributor',
  'event agency': 'Event Agency',
  'event': 'Event',
  'school': 'School',
  'bank': 'Bank',
  'it': 'IT',
  'individual': 'Individual',
  'ngo': 'NGO',
  'car dealers': 'Car Dealers',
  'real estate': 'Real Estate',
  'gas distributor': 'Gas Distributor',
  'pvr internal': 'PVR Internal',
  'production house': 'Production House',
  'productions house': 'Production House',
  'price water': 'PWC',
};

// Rows where the client identity columns got corrupted with a copy-pasted
// cinema/venue name instead of a real client (e.g. "PVR Kuamr pacfic" filled
// into Client Type, Client name, Corporate name, AND Industry all at once).
// These carry no usable client identity, so the whole row is dropped rather
// than kept as an unmapped clientCategory.
const CORRUPTED_IDENTITY_VALUES = new Set(['pvr kuamr pacfic']);

function normalizeClientTypeAndCategory(raw, sheet, row, clientName) {
  if (raw == null || String(raw).trim() === '') return { clientType: null, clientCategory: null };
  const norm = String(raw).trim().replace(/\s+/g, ' ');
  const lower = norm.toLowerCase();
  if (lower === 'new') return { clientType: 'New', clientCategory: null };
  if (lower === 'existing' || lower === 'exsisting') return { clientType: 'Existing', clientCategory: null };
  const canon = CLIENT_CATEGORY_MAP[lower];
  if (canon) return { clientType: null, clientCategory: canon };
  flagValue('clientCategory', norm, sheet, row, clientName);
  return { clientType: null, clientCategory: norm };
}

function normalizeWeek(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const m = String(raw).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : String(raw).trim();
}

const normCityKey = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');

// Final region pass, run once across every record from every sheet so a
// city/cinemaLocation -> region lookup can be built from the data itself.
// - west/north/south/east/central (any case) -> Title case, no report entry.
// - "NE" -> "North East" and "Multi" stay as their own values, unchanged.
// - "Sount" is a straight typo fix -> "South".
// - Anything else (a stray venue name like "TLC", a typo like "lot 2", a
//   city name that leaked into the field like "DELHI", or a blank/missing
//   region) falls back to the majority region already seen for that row's
//   city (or cinemaLocation, if city is absent/unmatched). Every row that
//   takes this fallback path is logged to regionDerivations.json, whether or
//   not the lookup actually resolved to a region.
function resolveRegions(allRecords) {
  const cityToRegionCounts = new Map();
  const cinemaToRegionCounts = new Map();

  for (const rec of allRecords) {
    if (rec.region == null) continue;
    const canon = CANONICAL_REGION_MAP[rec.region.toLowerCase()];
    if (!canon) continue;
    if (rec.city) {
      const key = normCityKey(rec.city);
      const m = cityToRegionCounts.get(key) || new Map();
      m.set(canon, (m.get(canon) || 0) + 1);
      cityToRegionCounts.set(key, m);
    }
    if (rec.cinemaLocation) {
      const key = normCityKey(rec.cinemaLocation);
      const m = cinemaToRegionCounts.get(key) || new Map();
      m.set(canon, (m.get(canon) || 0) + 1);
      cinemaToRegionCounts.set(key, m);
    }
  }

  const majorityRegion = (counts) => {
    let best = null;
    let bestCount = -1;
    for (const [region, count] of counts.entries()) {
      if (count > bestCount) { best = region; bestCount = count; }
    }
    return best;
  };

  const cityToRegion = new Map([...cityToRegionCounts].map(([k, v]) => [k, majorityRegion(v)]));
  const cinemaToRegion = new Map([...cinemaToRegionCounts].map(([k, v]) => [k, majorityRegion(v)]));

  const regionDerivations = [];

  for (const rec of allRecords) {
    const raw = rec.region;
    let finalRegion = canonicalizeDirectRegion(raw);

    if (finalRegion == null) {
      let derived = null;
      if (rec.city) derived = cityToRegion.get(normCityKey(rec.city)) || null;
      if (!derived && rec.cinemaLocation) derived = cinemaToRegion.get(normCityKey(rec.cinemaLocation)) || null;
      finalRegion = derived;
      regionDerivations.push({
        sheet: rec.sourceSheet,
        row: rec._excelRow,
        city: rec.city,
        cinemaLocation: rec.cinemaLocation,
        originalRegion: raw,
        derivedRegion: finalRegion,
      });
    }

    rec.region = finalRegion;
  }

  // NOTE: `_excelRow` is intentionally NOT deleted here — later steps in
  // main() (the cinema master-list resolution pass, and building
  // nullCityRows/unresolvedCityRows) still need it. It's stripped once, in
  // main(), right before bookings.json is written. (This used to happen
  // here, which silently dropped `row` from most of unresolvedCityRows.json
  // — see the fix note in main().)

  return regionDerivations;
}

// ---------------------------------------------------------------------------
// Movie Industry / Movie Language normalization
//
// Two-pass approach: (1) group raw values by lowercase+trim, which merges
// pure casing variants automatically; (2) known typo variants (identified by
// hand against this workbook's actual data — e.g. "Holyywood"/"Tolyywood",
// a one-letter l/y swap, or "Telughu"/"Telegu"/"Teleugu" around "Telugu")
// are resolved through a curated map, because picking the correct canonical
// spelling needs real-world knowledge a frequency count can get backwards
// (e.g. "Telughu" outnumbers correctly-spelled "Telugu" in this data).
// Anything left over becomes its own Title Case value, then gets checked by
// edit distance against every value already resolved for the field: a close
// match with no curated resolution isn't guessed at — it's logged to
// flaggedValues.json instead. That safety net is what would catch a *new*
// typo appearing in a future workbook re-run, even though it currently finds
// nothing (every close-spelling case in the initial run was confident enough
// to resolve directly).
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function titleCase(s) {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

const MOVIE_INDUSTRY_CANON = {
  bollywood: 'Bollywood',
  bollywod: 'Bollywood', // typo: missing an "o"
  hollywood: 'Hollywood',
  holyywood: 'Hollywood', // typo: "ll" -> "ly"
  tollywood: 'Tollywood',
  tolyywood: 'Tollywood', // typo: "ll" -> "ly" (same pattern as Holyywood)
  na: 'NA',
  regional: 'Regional',
  'own content': 'Own Content',
  evolution: 'Evolution',
  event: 'Event',
  'enviornement based': 'Environment Based', // typo, confirmed correct — no sibling spelling in the data to auto-merge against
  'kids centeric': 'Kids Centric', // typo, confirmed correct — no sibling spelling in the data to auto-merge against
};

const MOVIE_LANGUAGE_CANON = {
  hindi: 'Hindi',
  marathi: 'Marathi',
  english: 'English',
  englsih: 'English', // typo: "si" -> "is" transposed
  englis: 'English', // typo: missing trailing "h"
  na: 'NA',
  telugu: 'Telugu',
  telughu: 'Telugu', // typo: extra "h"
  telegu: 'Telugu', // typo: "u" -> "e"
  teleugu: 'Telugu', // typo: extra "e"
  regional: 'Regional',
  tamil: 'Tamil',
  'own content': 'Own Content',
  punjabi: 'Punjabi',
  gujrati: 'Gujarati', // typo, confirmed correct — no sibling spelling in the data to auto-merge against
};

// Confirmed client-identity merges only — same "never guess" discipline as
// CITY_CANON: applied to BOTH clientName and corporateName (an alias can
// show up in either field across different rows/sheets; the dashboard's own
// normalizeClientKey() reads `corporateName || clientName`, so both need
// the same treatment for the merge to take effect regardless of which
// field a given row actually used). Every entry here was explicitly
// confirmed by the user — this directly affects revenue attribution on the
// Leaderboard, so nothing gets merged on a guess, no matter how close two
// names look. See data/reports/clientNameCandidates.json for everything
// that looked similar but wasn't confirmed.
const CLIENT_NAME_CANON = {
  rbl: 'RBL Bank',
  'rbl bank': 'RBL Bank',
  // Confirmed by user: merge despite being different real business units
  // (mutual fund / AMC / bank arm), for this dashboard's purposes only.
  'bandhan mutual fund': 'Bandhan',
  'bandhan amc': 'Bandhan',
  'bandhan bank': 'Bandhan',
  // Extended from an earlier pass (which only had these 3 pointing at bare
  // "Khushi") once the candidate audit showed "Khushi" is itself shorthand
  // for "Khushi Advertising" — see the big merge batch below, which folds
  // all of these into that fuller name instead.
  khushi: 'Khushi Advertising',
  'khushi (4th jul)': 'Khushi Advertising',
  'khushi (viacom)': 'Khushi Advertising',
  'fervent communication': 'Fervent Communication',
  'fervent communication private limited': 'Fervent Communication',
  'global event': 'Global Events',
  'global events': 'Global Events',
  bcg: 'BCG',
  'bcg ( food)': 'BCG',
  // Confirmed by user. Data actually has 7 distinct raw spellings under
  // this cluster (one more than the 6 named) — "pidilite industries ltd."
  // (with a trailing period) is obviously the same entity, so it's merged
  // too rather than left out on a technicality.
  pidilite: 'Pidilite Industries Ltd',
  'pidilite industries': 'Pidilite Industries Ltd',
  'pidilite industries ltd': 'Pidilite Industries Ltd',
  'pidilite industries ltd.': 'Pidilite Industries Ltd',
  'pidilite ltd': 'Pidilite Industries Ltd',
  pidilitte: 'Pidilite Industries Ltd',
  'pidilite ind ltd': 'Pidilite Industries Ltd',

  // Large batch from the clientNameCandidates.json audit — confirmed by
  // user, 34 of the 42 candidate groups (full or partial). Deliberately
  // NOT merged, even though they showed up as candidates: "Bms"/"Bmw"
  // (BookMyShow vs BMW — unrelated), "Eco"/"Ey"/"Eo" (Ey is likely Ernst &
  // Young — left as 3 separate clients), "Zoom Communications" (not the
  // same as the Stroam/Strom/Strong cluster), "Everest Food Products"
  // (likely the unrelated Everest Masala/spice brand, not merged into
  // "Everest"), "Raman" (not the same as "Mr Aman"/"Aman"), and "Heera
  // Enterprises" (not the same as "Dheeraj Enterprises"). These stay as
  // their own canonical values so a future pass doesn't silently re-merge
  // them without asking again.
  'khushi advertising': 'Khushi Advertising',
  'khushi advertising (prince pipe)': 'Khushi Advertising',
  'khushi advertisings': 'Khushi Advertising',
  'aamika / khushi advertising': 'Khushi Advertising',
  'idfc bank': 'IDFC Bank',
  idfc: 'IDFC Bank',
  'idfc first': 'IDFC Bank',
  'idfc bank chennai': 'IDFC Bank',
  'idfc first bank': 'IDFC Bank',
  'cramo services': 'Cramo Services',
  'cramo swrvice': 'Cramo Services',
  'zee entertainment enterprises': 'Zee Entertainment Enterprises',
  'zee entertainment': 'Zee Entertainment Enterprises',
  nagaro: 'Nagarro', // "Nagarro" (the group's own less-frequent spelling) is the real, correctly-spelled company name
  nagarro: 'Nagarro',
  'gm moduler': 'Gm Modular',
  'gm modular': 'Gm Modular',
  'radio mirchi': 'Radio Mirchi',
  'radio mirchi kolkata': 'Radio Mirchi',
  'apollo hospitals enterprise limited': 'Apollo Hospitals Enterprise Limited',
  'apollo hospital': 'Apollo Hospitals Enterprise Limited',
  'apollo hospitals': 'Apollo Hospitals Enterprise Limited',
  'apolo hospital': 'Apollo Hospitals Enterprise Limited',
  interactive: 'Interactive Television',
  'interactive televison': 'Interactive Television',
  'interactive television': 'Interactive Television',
  intractive: 'Interactive Television',
  kotak: 'Kotak Mahindra',
  'kotak bank': 'Kotak Mahindra',
  'kotak mahindra': 'Kotak Mahindra',
  'kotal bank': 'Kotak Mahindra',
  'mercedes benze': 'Mercedes Benz',
  'mercedes benz': 'Mercedes Benz',
  'pine labs': 'Pine Labs',
  pinelab: 'Pine Labs',
  pinelabs: 'Pine Labs',
  'pine lab': 'Pine Labs',
  fervent: 'Fervent Communication',
  // "Roterry Club Chennai" candidate group — all 14 variants confirmed as
  // the same contact/club, including the bare "Yogesh" entries.
  'roterry club chennai': 'Rotary Club Chennai',
  'rotaary club': 'Rotary Club Chennai',
  'rotery club': 'Rotary Club Chennai',
  yogesh: 'Rotary Club Chennai',
  'mr yogesh (rottary club)': 'Rotary Club Chennai',
  '(rottary club)': 'Rotary Club Chennai',
  'yogesh rottery club chennai': 'Rotary Club Chennai',
  'rotarry club chennai': 'Rotary Club Chennai',
  'rotary club chennai': 'Rotary Club Chennai',
  'yogesh rottary club': 'Rotary Club Chennai',
  'yogesh rotarry club': 'Rotary Club Chennai',
  'yogesh rotary club chennai': 'Rotary Club Chennai',
  'yogesh rotarry club chennai': 'Rotary Club Chennai',
  'yogesh (rotary club)': 'Rotary Club Chennai',
  'dheeraj enterprises': 'Dheeraj Enterprises', // "Heera Enterprises" deliberately excluded — see note above
  dheeraj: 'Dheeraj Enterprises',
  'dlf gurgaon': 'DLF Limited',
  'dlf chandighar': 'DLF Limited',
  'dlf motinagar': 'DLF Limited',
  'dlf limited': 'DLF Limited',
  'dlf chandigarh': 'DLF Limited',
  dlf: 'DLF Limited',
  'panaroma studio': 'Panorama Studio',
  'panorama studio': 'Panorama Studio',
  'dav school ho': 'Dav School Ho',
  'dav school moi': 'Dav School Ho',
  'tata tele': 'Tata Tele Services',
  'tata tele services': 'Tata Tele Services',
  'tata tel': 'Tata Tele Services',
  'tata tele service': 'Tata Tele Services',
  'lutha & luthra': 'Luthra And Luthra',
  'luthra and luthra': 'Luthra And Luthra',
  luthra: 'Luthra And Luthra',
  'rajasthan club': 'Rajasthan Club',
  'mr. yogesh rajastan cliub chennai': 'Rajasthan Club',
  'mr yogesh rajastan club chennai': 'Rajasthan Club',
  'mr yogesh rajasthan club chennai': 'Rajasthan Club',
  'super cassettes industries pvt. ltd': 'Super Cassettes Industries Pvt. Ltd',
  'super cassettes industries pvt ltd': 'Super Cassettes Industries Pvt. Ltd',
  'coco cola': 'Coco Cola',
  'coco-cola': 'Coco Cola',
  'airtel - tamil nadu': 'Bharti Airtel',
  'bharti airtel': 'Bharti Airtel',
  'airtel delhi': 'Bharti Airtel',
  airtel: 'Bharti Airtel',
  'stroam communications': 'Stroam Communications', // "Zoom Communications" deliberately excluded — see note above
  'strom cummunication': 'Stroam Communications',
  'strom communications': 'Stroam Communications',
  'strong communications': 'Stroam Communications',
  'singapore airlines': 'Singapore Airlines',
  'singapore ailines': 'Singapore Airlines',
  'mr aman': 'Aman Goel', // "Raman" deliberately excluded — see note above
  'aman goel': 'Aman Goel',
  'aman madras club': 'Aman Goel',
  aman: 'Aman Goel',
  'audi south delhi': 'Audi South Delhi',
  'audi south': 'Audi South Delhi',
  'wings barnd actications pvt ltd': 'Wings Brand Activations Pvt Ltd',
  'wings brand activations pvt ltd': 'Wings Brand Activations Pvt Ltd',
  evenmark: 'Evenmark',
  'event mark': 'Evenmark',
  'madhuvan events & entertainments': 'Madhuvan Events & Entertainments',
  'madhuvan events': 'Madhuvan Events & Entertainments',
  sony: 'Sony Pictures',
  'sony pictures': 'Sony Pictures',
  'the stallions': 'The Stallions',
  stallions: 'The Stallions',
  amazon: 'Amazon',
  'amazon chennai': 'Amazon',
  'le-meridian': 'Le-meridian',
  lemeredian: 'Le-meridian',
  'meta acadmy': 'Meta Academy',
  'meta acadamy': 'Meta Academy',
  'meta academy': 'Meta Academy',
  'google it': 'Google',
  google: 'Google',
  'jw marriot': 'Jw Marriot',
  'jw merriot': 'Jw Marriot',
  'sun rise learning': 'Sunrise Learning',
  'sunrise learning': 'Sunrise Learning',
};

// Confirmed genuine typos from the flaggedValues.json city review — every
// other flagged city (suburb/neighborhood names that just happen to be
// edit-distance-close to an unrelated real city, e.g. "GOREGAON" near
// "Gurgaon") is deliberately left out of this map and stays untouched.
const CITY_CANON = {
  ahemdabad: 'Ahmedabad',
  kolkatta: 'Kolkata',
  gurgoan: 'Gurgaon',
  gurgona: 'Gurgaon',
  gaurgaon: 'Gurgaon',
  hyderbad: 'Hyderabad',
  hydrabad: 'Hyderabad',
  hyderabd: 'Hyderabad',
  delhii: 'Delhi',
  'delhi`': 'Delhi',
  dekhi: 'Delhi',
  bengalore: 'Bangalore',
  banglore: 'Bangalore',
  bangalaore: 'Bangalore',
  banaglore: 'Bangalore',
  bangalorw: 'Bangalore',
  vadodra: 'Vadodara',
  chandighar: 'Chandigarh',
  bhubhneshwar: 'Bhubaneswar',
  bhubneshwar: 'Bhubaneswar',
  deheradun: 'Dehradun',
  delheradun: 'Dehradun',
  vijaywada: 'Vijayawada',
  pondichery: 'Pondicherry',
  bangaluru: 'Bangalore',
  cuttak: 'Cuttack',
  madhurai: 'Madurai',
  ghwahati: 'Guwahati',
  ahmadabad: 'Ahmedabad',
  lacknow: 'Lucknow',
  vishakhapatnam: 'Visakhapatnam',
  'mumbai`': 'Mumbai',
  guruguam: 'Gurgaon',
  dhanabad: 'Dhanbad',
  kolktta: 'Kolkata',
  mumabi: 'Mumbai',
  'gurgaon,': 'Gurgaon',
  cochin: 'Kochi',
  mysuru: 'Mysore',
  'new delhi': 'Delhi',
  bengaluru: 'Bangalore',
  vishakhapatanam: 'Visakhapatnam', // a second, separate misspelling from "vishakhapatnam" above
  bhillai: 'Bhilai',
  velacherry: 'Velachery',
  // "Yamuna Nagar" (3 occurrences) outnumbers "Yamunanagar" (1) in the data,
  // so per the standard frequency-first rule, the less common spelling folds
  // into the more common one rather than the reverse.
  yamunanagar: 'Yamuna Nagar',
  gurugram: 'Gurgaon', // official 2016 rename — same city
  baroda: 'Vadodara', // old/new name — same city
  nasik: 'Nashik', // standardized to "Nashik" per explicit user decision
  cyberabad: 'Hyderabad',
  // Pinned as-is (not a merge): introducing "Nashik" as a canonical value
  // above put it within edit-distance of this real, unrelated Navi Mumbai
  // locality, which would otherwise start getting flagged as a false
  // positive purely as a side effect of that unrelated fix.
  vashi: 'Vashi',
  // State names that leaked into the City column — there's no way to
  // recover which actual city was meant, so these are nulled out rather
  // than guessed at (see the console note this produces, listing every
  // sheet+row affected, so the gap stays visible instead of being silently
  // dropped).
  maharashta: null,
  maharastra: null,
  chattisgarh: null,
  karnatak: null,
  'uttar paradesh': null,
  gujrat: null,
  kerala: null,
  'andhra pradesh': null, // found during the cinema-master-list resolution pass — same leaked-state-name pattern as the others above
};

// ---------------------------------------------------------------------------
// Cinema master-list resolution — an optional bonus pass that uses PVR's own
// internal cinema-pricing workbook (a *second* reference file, separate from
// the main booking tracker) to resolve rows whose city is still missing/a
// leaked state name, or whose region is still null, by matching the row's
// raw cinemaLocation text against PVR's real property list. If the
// reference file isn't present this whole pass is skipped — nothing else in
// the ETL depends on it.
// ---------------------------------------------------------------------------
const CINEMA_MASTER_INPUT = 'Final_Consolidated_Cinema_Pricing_private_screening.xlsx';

// A hand-corrected copy of just the "Year 2022 data" sheet, Region column
// only — the user manually reviewed and fixed ambiguous/wrong Region values
// for that sheet. These are trusted directly (see main()): applied as the
// final word on rec.region for that sheet, after every other region step
// (resolveRegions' derivation, the cinema master-list pass's "Multi"
// tagging), so nothing else in the pipeline second-guesses them. Does NOT
// touch city — that sheet has no City column, and city resolution for its
// rows is untouched by this file.
const YEAR_2022_REGION_FIX_INPUT = 'YEAR 2022 SHEET FIXED WITH MULTI AND NE.xlsx';

/**
 * Reads YEAR_2022_REGION_FIX_INPUT and returns a Map of excelRow (1-based,
 * matching parseYear2022Sheet's own row numbering) -> canonicalized region
 * string, for every row where the corrected file has a non-blank Region.
 * Rows left blank in the corrected file are omitted from the map entirely
 * (not forced to null) — the sheet's own author only corrected the rows
 * they actually reviewed; everything else still goes through the normal
 * derivation fallback. Returns null (with a warning) if the file is
 * missing — this override is optional, like the cinema master list.
 */
function loadYear2022RegionFixes(inputPath) {
  if (!fs.existsSync(inputPath)) {
    console.warn(`\nYear 2022 region-fix reference not found (${inputPath}) — skipping the manual region override for that sheet.`);
    return null;
  }
  const wb = XLSX.readFile(inputPath);
  const sheetName = wb.SheetNames.find((n) => /year 2022/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
  const fixes = new Map();
  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i] ? rows[i][9] : null; // column 9 = Region, same layout as parseYear2022Sheet
    if (raw == null || String(raw).trim() === '') continue;
    const excelRow = i + 1;
    const canon = canonicalizeDirectRegion(raw) || titleCase(String(raw).trim());
    fixes.set(excelRow, canon);
  }
  return fixes;
}

// Raw city values that mean "a state name leaked into the city column, not a
// real city" — the null-mapped CITY_CANON keys above, plus their correctly-
// spelled originals (which CITY_CANON never sees, because it only nulls the
// key it's given — a correctly-spelled state name self-canonicalizes as its
// own "city" instead unless caught here first).
const STATE_NAME_LEAK_VALUES = new Set([
  'maharashta', 'maharastra', 'maharashtra', 'chattisgarh', 'chhattisgarh',
  'karnatak', 'karnataka', 'uttar paradesh', 'uttar pradesh', 'gujrat',
  'gujarat', 'kerala', 'punjab', 'rajasthan', 'andhra pradesh',
]);

// Known Indian city names/phrases, used to pull a city out of a master-list
// "Cinema Name" string that has no "(City)" suffix — longest phrase first,
// so a 2-word city like "Yamuna Nagar" wins over a coincidental 1-word tail.
const MASTER_LIST_KNOWN_CITIES = [
  'Yamuna Nagar', 'Sri Ganganagar', 'New Delhi', 'Navi Mumbai',
  'Ahmedabad', 'Ajmer', 'Allahabad', 'Amritsar', 'Anand', 'Armoor', 'Aurangabad',
  'Bangalore', 'Bengaluru', 'Bareilly', 'Belgaum', 'Bhilai', 'Bhilwara', 'Bhiwadi', 'Bhiwandi',
  'Bhopal', 'Bhubaneswar', 'Bilaspur', 'Bokaro', 'Burdwan', 'Chandigarh', 'Chennai',
  'Coimbatore', 'Cuddalore', 'Cuttack', 'Dehradun', 'Delhi', 'Dhanbad', 'Dombivli', 'Dombivali',
  'Faridabad', 'Gandhinagar', 'Ghaziabad', 'Goa', 'Gorakhpur', 'Greater Noida',
  'Gulbarga', 'Kalaburagi', 'Guntur', 'Gurgaon', 'Gurugram', 'Guwahati', 'Gwalior',
  'Howrah', 'Hubli', 'Hubballi', 'Hyderabad', 'Indore', 'Jabalpur', 'Jaipur', 'Jalandhar',
  'Jalgaon', 'Jammu', 'Jamnagar', 'Jodhpur', 'Jharkhand', 'Kakinada', 'Kalyan', 'Kanpur',
  'Khanna', 'Kochi', 'Cochin', 'Kolhapur', 'Kolkata', 'Kota', 'Kurla', 'Latur', 'Lucknow',
  'Ludhiana', 'Machlipatnam', 'Madurai', 'Mangalore', 'Margao', 'Meerut', 'Mohali', 'Moradabad',
  'Mumbai', 'Mysore', 'Mysuru', 'Nadiad', 'Nagpur', 'Nanded', 'Narasipatnam', 'Nashik', 'Nasik',
  'Nizamabad', 'Noida', 'Panipat', 'Panjim', 'Pathankot', 'Patiala', 'Patna', 'Pimpri',
  'Pondicherry', 'Puducherry', 'Porvorim', 'Provorim', 'Prayagraj', 'Pune', 'Raipur', 'Rajkot',
  'Ranchi', 'Rourkela', 'Salem', 'Siliguri', 'Surat', 'Thane', 'Thrissur', 'Trivandrum',
  'Tumakuru', 'Udaipur', 'Ujjain', 'Vadodara', 'Vadodra', 'Vellore', 'Vijayawada',
  'Visakhapatnam', 'Vizag', 'Warangal', 'Zirakpur',
].sort((a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length);

// Master-list "Cinema Name" entries the parens/comma/suffix heuristics below
// can't reach — hand-checked once against the full ~342-entry list. Also
// used for one deliberate spelling fix: the source file's own parenthetical
// for the Porvorim, Goa property is itself typo'd ("Provorim").
const MASTER_LIST_CITY_OVERRIDES = {
  'Dharwad Smart City': 'Dharwad',
  'INOX BURDWAN ARCADE': 'Burdwan',
  'INOX GMC PANJIM': 'Panjim',
  'INOX KOLHAPUR RELIANCE MEGA MALL': 'Kolhapur',
  'INOX LUCKNOW EMERALD MALL': 'Lucknow',
  'INOX MALL OF MYSORE': 'Mysore',
  'INOX RAJKOT R-WORLD': 'Rajkot',
  'INOX RAJKOT RELIANCE MALL': 'Rajkot',
  'INOX RELIANCE MALL, JALANDHAR': 'Jalandhar',
  'PVT INORBIT HUBBALLI': 'Hubballi',
  'S2 HASEEN THANE (Bhiwandi)': 'Bhiwandi',
  'PVR INORBIT CYBERABAD': 'Hyderabad',
  'PVR NARASIPATNAM': 'Narasipatnam',
  'PVR VR CHENNAI ANNA NAGAR': 'Chennai',
  'S2 WARRANGAL': 'Warangal',
  'INOX MALL DE GOA PORVORIM (Provorim)': 'Porvorim',
  'Varam Mall (Machlipatnam)': 'Machilipatnam', // fixing the source file's own spelling to match the confirmed real place name
};

function masterListMatchKnownCitySuffix(text) {
  const words = text.replace(/[,-]/g, ' ').split(/\s+/).filter(Boolean);
  for (const cityPhrase of MASTER_LIST_KNOWN_CITIES) {
    const cityWords = cityPhrase.split(' ');
    const suffix = words.slice(-cityWords.length).join(' ');
    if (suffix.toLowerCase() === cityPhrase.toLowerCase()) return cityPhrase;
  }
  return null;
}

// Pulls the city out of a master-list "Cinema Name" string — trailing
// "(City)" first (the majority format), then a comma-separated tail, then a
// trailing-word match against MASTER_LIST_KNOWN_CITIES, then the curated
// overrides above for the handful nothing else reaches. Always returns
// Title Case regardless of the source row's own casing (the sheet mixes ALL
// CAPS and Title Case inconsistently across rows).
function extractMasterListCity(cinemaName) {
  if (MASTER_LIST_CITY_OVERRIDES[cinemaName]) return MASTER_LIST_CITY_OVERRIDES[cinemaName];

  const parenMatch = cinemaName.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) return titleCase(parenMatch[1].trim());

  const lastComma = cinemaName.lastIndexOf(',');
  if (lastComma !== -1) {
    const tail = cinemaName.slice(lastComma + 1).trim();
    const known = masterListMatchKnownCitySuffix(tail);
    if (known) return known;
    if (tail && /^[A-Za-z .]+$/.test(tail)) return titleCase(tail);
  }

  return masterListMatchKnownCitySuffix(cinemaName);
}

/**
 * Builds the {cinemaName, city} master list from PVR's internal cinema-
 * pricing workbook. Returns null (and logs a warning) if the reference file
 * isn't present — the whole cinema-master resolution pass is optional, not
 * a hard dependency of the core ETL.
 */
function buildCinemaMasterList(inputPath) {
  if (!fs.existsSync(inputPath)) {
    console.warn(`\nCinema master-list reference not found (${inputPath}) — skipping the cinema-based city/region resolution pass.`);
    return null;
  }
  const wb = XLSX.readFile(inputPath);
  const sheetName = wb.SheetNames.find((n) => /consolidated/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
  const distinctNames = [...new Set(
    rows.map((r) => String(r['Cinema Name'] || '').trim().replace(/\s+/g, ' ')).filter(Boolean),
  )].sort();
  return distinctNames.map((cinemaName) => ({ cinemaName, city: extractMasterListCity(cinemaName) }));
}

// User-confirmed literal resolutions, verified by hand against the master
// list — checked as an EXACT normalized match only (never substring), so
// e.g. "Maison" here never fires on "Maison & Ambience" (that's two
// different cinemas concatenated in one field — see
// resolveMultiFragmentCinemaLocation below, which catches it via the "&").
const CINEMA_LOCATION_OVERRIDES = {
  SCW: 'Delhi', // PVR Select City Walk — the master list's own entry for it ("PVR SELECT CITY WALK DELHI") has no city in parens, just a trailing "DELHI"; normalized to "Delhi" (not "New Delhi") to match this project's existing canonical spelling
  'SCW GOLD': 'Delhi', // same property, a premium-format screen
  'AMBI GGN': 'Gurgaon', // PVR/INOX Ambience Mall, Gurgaon
  'INOX PVS MALL': 'Meerut',
  'PVR ICON INFINITY': 'Mumbai',
  MAISON: 'Mumbai',
  'PVR VERVOSA': 'Mumbai', // confirmed: garbled spelling of "Versova" — see JUNE-2026 row 133's "PVR ICON INFINITY VERSOVA" (Mumbai) in the same client's own sheet
  'PVR LOWER PAREL': 'Mumbai', // confirmed by user — Lower Parel is a Mumbai neighborhood
  'PVR JUHU': 'Mumbai', // confirmed by user — Juhu is a Mumbai neighborhood
  'PVR CINEMA PHULONG': 'Nizamabad', // confirmed by user — cinema closed/renamed (PVR Venu Nizamabad); these bookings belong there
  'PVR THE CENIMA NAAZ CENTER': 'Machilipatnam', // confirmed by user — Varam Mall, Machilipatnam
  // Confirmed same-city cases: >1 cinema referenced, but every one of them
  // is in the same real city, so this is NOT a multi-location booking.
  // Hardcoded rather than left to the general fragment-intersection check
  // below, because that check requires >=2 fragments to independently
  // resolve to something before it will trust an intersection (a safety
  // rule added after a single-fragment "wins" produced a wrong answer for
  // "Surat & Prashantvihar" — see resolveMultiFragmentCinemaLocation) — and
  // "Palazzo / VR" only has ONE side ("Palazzo") that resolves confidently
  // on its own ("VR" is too short/generic to mean anything by itself).
  'PLAZA RIVOLI': 'Delhi', // PVR Plaza Delhi + PVR Rivoli Delhi
  'SELECT AMBI': 'Delhi', // PVR Select City Walk Delhi + PVR Ambience Delhi
  'PALAZZO VR': 'Chennai', // Palazzo is Chennai-only; VR Chennai Anna Nagar is a real match

  // Large confirmed batch — every entry below is a user-confirmed city/
  // property identification for a specific cinemaLocation string, applied
  // dataset-wide (every row using that exact text, not just the ones
  // originally reported).
  'PVR SATYAM': 'Chennai', // Sathyam
  'SPI SATYAM': 'Chennai', // Sathyam
  'PVR SPECTRUM': 'Chennai', // confirmed via S2 Perambur reference
  'PVR AMBIENCE': 'Gurgaon', // PVR Ambience Gurgaon (all occurrences — not Delhi)
  'PVR ACROPOLIS': 'Ahmedabad',
  'PVR CAPITAL MALL NALLASOPARA': 'Mumbai', // PVR Capital Mall, Vasai
  MGF: 'Gurgaon', // PVR MGF Gurgaon
  'PVR MCB': 'Gurgaon', // PVR MGF Gurgaon
  'PVR CHANAKYA': 'Delhi', // PVR ECX Chanakyapuri
  'INOX MULTIPLEX': 'Jodhpur', // Indiabulls Mega Mall
  'PVR RIDHI SIDHI MALL': 'Jodhpur', // Indiabulls Mega Mall
  'PVR DR RAJKUMAR ROAD MALLESHWARAM': 'Bangalore', // INOX Mantri Square Mall, Malleshwaram
  'INOX POST OFFICE ROAD': 'Belgaum', // INOX Chandan Cinema
  'INOX GAJANANMAHARAJ MANDIR ROAD': 'Aurangabad', // INOX Reliance Mega Mall
  'PVR PHOENIX MARKETCITY KURLA': 'Mumbai',
  'PVR BKC': 'Mumbai', // Maison, Jio World Centre BKC — a distinct property from the Kurla one above, same city
  'PVR MALAD': 'Mumbai', // Cinemax Infiniti Malad
  'PVR CITI ANDHERI': 'Mumbai', // PVR Citi Mall Andheri (W)
  'PVR CITY ANDHERI': 'Mumbai', // PVR Citi Mall Andheri (W)
  // Reversed from an earlier "Mumbai" (PVR Market City Kurla) mapping —
  // Viman Nagar is a Pune locality, and the client's own nearby rows
  // (including a separately-confirmed Pune row, "Mall of Millenium -
  // Wakad") supported Pune over Mumbai. Confirmed by user.
  'PVR MARKET CITY VIMAN NAGAR': 'Pune',
  // Confirmed by user — apply directly, not left as an ambiguous fallback.
  'AMBI MAISON FORUM VR CHENNAI': 'Gurgaon', // PVR Ambience Gurgaon
  BANGLORE: 'Bengaluru', // PVR Forum Koramangala (region already set via the hand-corrected Year 2022 file — city only)
  JUHU: 'Mumbai', // PVR Dynamic Juhu — bare "Juhu", distinct from "PVR Juhu" (already resolved)
  'PVR CITY CENTER': 'Chandigarh', // PVR City Centre Mall
  'PVR INORBIT MALAD': 'Mumbai', // INOX Inorbit Mall, Malad
  'PVR RK CINEPLEX': 'Vijayawada', // PVR Ripples
  'PVR VEGA CITY': 'Bengaluru', // PVR Vega Mall
  'PVR VEGACITY BLR': 'Bengaluru', // PVR Vega Mall
  'PVR SELECTCITY': 'Delhi', // PVR Select City Walk
  'PVR SELECT GOLD': 'Delhi', // PVR Select City Walk
  'PVR SELECTCITY CITY': 'Delhi', // PVR Select City Walk
  'PVR VR MALL': 'Surat', // INOX VR Mall
  SUBHASHNAGAR: 'Delhi', // PVR Pacific
  'PVR SUBASH NAGAR': 'Delhi', // PVR Pacific
  'PVR PACIFIC SUBASH NAGAR': 'Delhi', // PVR Pacific
  'VAISHNAVI BNGLR': 'Bengaluru', // PVR Vaishnavi Sapphire
  'PVR MANISQUARE': 'Kolkata', // PVR Mani Square
  'PVR CITY CENTRE GGN': 'Gurgaon', // PVR City Centre
  'PVR CITY CENTER GGN': 'Gurgaon', // PVR City Centre
  'PVR REGALIA': 'Cuttack', // INOX SGBL Square Mall
  'PVR FORUM KORMANGALA': 'Bengaluru', // PVR Forum Mall Koramangala
  'LEREVE OBEROI ORION': 'Bengaluru', // PVR Orion — 3 real properties named together; this row resolved to the last one per explicit confirmation
  DCGGN: 'Gurgaon', // PVR Director's Cut Ambience
  'MARKET CITY BNGLR': 'Bengaluru', // PVR Phoenix Market City Whitefield Road
  'STAR MALL GGN': 'Bengaluru', // PVR Phoenix Market City Whitefield Road — per explicit confirmation, despite "GGN" in the raw text
  'ANDHERI CITY MALL': 'Mumbai', // PVR Citi Mall Andheri (W)
  'PVR PONDI': 'Puducherry', // The Cinema Providence
  'PVR STAR MALL': 'Kolkata', // INOX Star Mall, Madhyamgram
  'PVR GALADA': 'Chennai', // PVR Grand Galada
  GALADA: 'Chennai', // PVR Grand Galada
  'PVR AMBI': 'Gurgaon', // PVR Cinemagic, Ambience Mall
  'PVR INFINITY MALAD': 'Mumbai', // PVR Icon Infinity Andheri (W)
  'PVR OBEROI GOREGAON': 'Mumbai', // PVR Icon Oberoi Goregaon (E)
  'PVR POMANADE': 'Delhi', // PVR Promenade Vasant Kunj
  PROMANADE: 'Delhi', // PVR Promenade Vasant Kunj
  JIO: 'Mumbai', // Maison, Jio World Centre BKC
  MCB: 'Bhubaneswar', // INOX BMC Bhawani Mall — distinct from "PVR MCB" above (Gurgaon)
  'NEXT GALLERIA PANJAGUTTA': 'Hyderabad',
  'SOUL SPRIT': 'Bengaluru', // PVR Soul Space Spirit
  'MKT CITY KURLA': 'Mumbai', // PVR Market City Kurla
  'PVR CITY CENTRE CHANDIGHAR': 'Chandigarh', // PVR City Centre Mall (typo preserved from source)
  'PVR MCPUNE': 'Pune', // PVR Market City
  'PVR PIMPERI': 'Pune', // PVR City One Mall Pimpri
  'PVR VERSOVA': 'Mumbai', // PVR Icon Infinity Andheri (W)
  'PVR RK HYD': 'Hyderabad', // INOX GVK One, Banjara Hills
  'PVR BANJAHILS HYD': 'Hyderabad', // INOX GVK One, Banjara Hills
  'PVR REX': 'Bengaluru', // PVR Director's Cut Forum Rex Walk Mall
  'AMBI DC': 'Delhi', // PVR Director's Cut Vasant Vihar Ambience
  'DC VK': 'Delhi', // PVR Director's Cut Vasant Vihar Ambience
  'PVR REGALIA ELEMENTS': 'Bhubaneswar', // INOX DN Regalia, Patrapara
  'PVR ICON VERSOVA': 'Mumbai', // PVR Icon Infinity Andheri (W)
  'INOX CITI CENTRE RK SALAI MYLAPORE': 'Chennai',
  'KHANDESH CENTRAL MALL': 'Bhilai', // PVR Treasure
  'MALL OF MILLENIUM WAKAD': 'Pune', // Phoenix Mall of Millenium, Wakad
  'PVR PHOENIX LOWER PAREL': 'Mumbai', // PVR Icon Phoenix Lower Parel
  'MULTIPAL CITIES': 'Gurgaon', // PVR Ambience Gurgaon
  'MULTIPAL PLACE': 'Mumbai', // PVR Lower Parel

  // Rule-2 exception (Year 2022 data only): "EDM" alone is too short to
  // clear the normal substring-match length floor, but it's not actually
  // ambiguous — there's exactly one EDM property in the master list (PVR
  // EDM Ghaziabad) — so this is a deliberate best-guess default, not a
  // coin-flip, per the explicit Year-2022-only exception.
  EDM: 'Ghaziabad',
};

function normalizeForCinemaMatch(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Loose length-scaled edit-distance budget for whole cinema-NAME strings —
// these run 15-40+ characters, far longer than the single category words
// closeMatchThreshold (used elsewhere in this file) is tuned for. Roughly a
// 20%-of-length tolerance, floor of 2.
function cinemaMatchThreshold(len) {
  return Math.max(2, Math.round(len * 0.2));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Drops any matched city name that's simply a linguistic substring of
// ANOTHER matched city name (e.g. "Noida" inside "Greater Noida") — without
// this, a single mention of "Greater Noida" gets counted as naming TWO
// cities (itself and "Noida"), which is what originally made "PVR GAUR CITY
// MALL GREATER NOIDA" wrongly look ambiguous.
function dedupeCityMatches(cities) {
  return cities.filter((c) => !cities.some((other) => other !== c && other.length > c.length && other.toLowerCase().includes(c.toLowerCase())));
}

// Strips a master entry's own trailing "(City)"/comma-city so Tier 2 below
// can match the *mall identity* against a raw cinemaLocation that names the
// mall but not the city (e.g. "INOX PVS MALL" against the master's "INOX
// PVS MALL (Meerut)").
function masterListBaseName(entry) {
  let base = entry.cinemaName.replace(/\s*\([^)]+\)\s*$/, '');
  const lastComma = base.lastIndexOf(',');
  if (lastComma !== -1 && base.slice(lastComma + 1).trim().toLowerCase() === entry.city.toLowerCase()) {
    base = base.slice(0, lastComma);
  }
  return base.trim();
}

const MULTI_KEYWORD_PATTERN = /\bmulti\b|\bmultiple\b/i;
const MULTI_SEPARATOR_PATTERN = /[/&]|\band\b/i;

function splitCinemaFragments(raw) {
  return raw.split(/\s*(?:[/&]|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
}

// The candidate city set for ONE fragment of a multi-part cinemaLocation
// (e.g. "Rivoli" out of "Plaza/Rivoli") — a smaller-scale exact/substring/
// city-token match, with no fuzzy tier (too risky for a fragment this
// short) and a lower substring-length floor than the full-string matcher
// (fragments are naturally shorter: single words or short phrases).
function fragmentCandidateCities(fragment, masterList, distinctCities) {
  const normFrag = normalizeForCinemaMatch(fragment);
  const cities = new Set();
  if (normFrag.length < 3) return cities; // too short to mean anything on its own

  for (const entry of masterList) {
    const base = masterListBaseName(entry);
    if (normFrag === normalizeForCinemaMatch(entry.cinemaName) || normFrag === normalizeForCinemaMatch(base)) {
      return new Set([entry.city]); // exact — no need to look further
    }
  }

  if (normFrag.length >= 4) {
    for (const entry of masterList) {
      const base = normalizeForCinemaMatch(masterListBaseName(entry));
      if (base.length < 4) continue;
      if (normFrag.includes(base) || base.includes(normFrag)) cities.add(entry.city);
    }
  }

  for (const c of dedupeCityMatches(distinctCities.filter((city) => new RegExp(`\\b${escapeRegExp(city)}\\b`, 'i').test(fragment)))) {
    cities.add(c);
  }

  return cities;
}

/**
 * Handles a cinemaLocation that names more than one cinema — split on "/",
 * "&", or " and ", or flagged outright by the word "multi". Returns null
 * when neither applies (not a multi-part value at all — the caller falls
 * through to the normal single-value tiers). Otherwise:
 *   { city, method: 'multi-fragment-same-city', matchedCinemaName: null }
 *     when every fragment that resolves to anything agrees on ONE city —
 *     this is NOT a multi-location booking, just >1 cinema reference in the
 *     same place (e.g. "Plaza/Rivoli" — both are Delhi properties).
 *   { multiCinema: true, kind: 'genuine-multi', candidateCities, reason }
 *     otherwise — a real multi-city/multi-location booking. `kind` is what
 *     lets the caller apply region="Multi" safely, vs. the single-name
 *     ambiguity case in the normal tiers below (kind: 'ambiguous-single-name'),
 *     which must NOT get that tag — one unknown booking at one (of several
 *     same-named) places is not a multi-city deal.
 */
function resolveMultiFragmentCinemaLocation(raw, masterList) {
  if (MULTI_KEYWORD_PATTERN.test(raw)) {
    return { multiCinema: true, kind: 'genuine-multi', candidateCities: [], reason: '"multi" placeholder — no specific cinema/city named at all' };
  }
  if (!MULTI_SEPARATOR_PATTERN.test(raw)) return null;

  const distinctCities = [...new Set(masterList.map((e) => e.city))];

  // Confirmed rule: a "/"-separated list of CINEMA NAMES (as opposed to a
  // list of CITY names, e.g. "Mumbai/Delhi" or "Bangalore, Mumbai, Gurgaon,
  // Noida" — those still fall through to the logic below and stay Multi)
  // resolves using only the FIRST name in the list, ignoring the rest.
  // Only fires when every "/"-fragment is NOT simply a bare city name —
  // that's what distinguishes "PVR Logix / MGF / Forum / Market City
  // Kurla" (cinema names) from "Mumbai/Delhi" (city names).
  if (raw.includes('/')) {
    const slashFragments = raw.split('/').map((s) => s.trim()).filter(Boolean);
    const allBareCityNames = slashFragments.length > 1 && slashFragments.every((f) => {
      const norm = normalizeForCinemaMatch(f);
      return distinctCities.some((c) => normalizeForCinemaMatch(c) === norm);
    });
    if (slashFragments.length > 1 && !allBareCityNames) {
      const firstMatch = matchCinemaLocationToMasterList(slashFragments[0], masterList);
      if (firstMatch && firstMatch.city && !firstMatch.multiCinema) {
        return { city: firstMatch.city, method: 'first-of-list', matchedCinemaName: firstMatch.matchedCinemaName };
      }
      // First fragment alone didn't resolve cleanly (unmatched, or itself
      // ambiguous) — fall through to the fragment-intersection/genuine-
      // multi logic below as a safety net, rather than silently doing
      // nothing.
    }
  }

  const fragments = splitCinemaFragments(raw);
  const informativeSets = fragments.map((f) => fragmentCandidateCities(f, masterList, distinctCities)).filter((s) => s.size > 0);

  // Require at least 2 fragments to independently resolve to something
  // before trusting their intersection — a single informative fragment
  // "winning" by default is exactly how "Surat & Prashantvihar" nearly
  // resolved to just Surat (Prashant Vihar, a real Delhi neighborhood,
  // wasn't recognized at all, so it contributed nothing to stop it). With
  // only 1 informative fragment there's no actual corroboration, just one
  // known place and one unknown one — that's still evidence of 2 different
  // places, not proof they're the same.
  if (informativeSets.length >= 2) {
    let intersection = informativeSets[0];
    for (const s of informativeSets.slice(1)) intersection = new Set([...intersection].filter((c) => s.has(c)));
    if (intersection.size === 1) {
      return { city: [...intersection][0], method: 'multi-fragment-same-city', matchedCinemaName: null };
    }
  }

  const allCandidates = dedupeCityMatches([...new Set(informativeSets.flatMap((s) => [...s]))]);
  return {
    multiCinema: true,
    kind: 'genuine-multi',
    candidateCities: allCandidates,
    reason: 'raw value references more than one cinema, and they do not all resolve to a single shared city',
  };
}

/**
 * Matches one raw cinemaLocation value against the PVR cinema master list.
 * Returns:
 *   { city, method, matchedCinemaName }                        on a confident, single-city match
 *   { multiCinema: true, kind, candidateCities, reason }        when the raw value can't be pinned to one city — see resolveMultiFragmentCinemaLocation for `kind`
 *   { closest: [...] } or null                                 when nothing confidently matches (closest = top 3 fuzzy candidates, for reference only)
 * method is one of: 'confirmed-override' | 'exact' | 'substring' | 'city-token' | 'fuzzy' | 'multi-fragment-same-city'.
 */
function matchCinemaLocationToMasterList(raw, masterList) {
  const normRaw = normalizeForCinemaMatch(raw);
  if (!normRaw) return null;

  if (CINEMA_LOCATION_OVERRIDES[normRaw]) {
    return { city: CINEMA_LOCATION_OVERRIDES[normRaw], method: 'confirmed-override', matchedCinemaName: null };
  }

  const multiResult = resolveMultiFragmentCinemaLocation(raw, masterList);
  if (multiResult) return multiResult;

  const distinctCities = [...new Set(masterList.map((e) => e.city))];

  // Tier 1: exact — against the full listed name or its city-stripped base.
  for (const entry of masterList) {
    const base = masterListBaseName(entry);
    if (normRaw === normalizeForCinemaMatch(entry.cinemaName) || normRaw === normalizeForCinemaMatch(base)) {
      return { city: entry.city, method: 'exact', matchedCinemaName: entry.cinemaName };
    }
  }

  // Tier 2: substring/contains, either direction, against the base name —
  // only when the shorter side is long enough to be distinctive (>= 5 normalized
  // chars). Collects every match; requires every match to agree on one city.
  if (normRaw.length >= 5) {
    const substringMatches = [];
    for (const entry of masterList) {
      const base = normalizeForCinemaMatch(masterListBaseName(entry));
      if (base.length < 5) continue;
      if (normRaw.includes(base) || base.includes(normRaw)) substringMatches.push(entry);
    }
    if (substringMatches.length) {
      const cities = [...new Set(substringMatches.map((e) => e.city))];
      if (cities.length === 1) {
        return { city: cities[0], method: 'substring', matchedCinemaName: substringMatches[0].cinemaName };
      }
      // Same cinemaLocation text genuinely matches real properties in more
      // than one DIFFERENT city (e.g. "PVR Forum" exists in 4 cities) — one
      // unknown booking at one of several same-named places, not a
      // multi-city deal, so this must never get region="Multi".
      return { multiCinema: true, kind: 'ambiguous-single-name', candidateCities: cities, reason: 'cinemaLocation text matches real properties in more than one city; no way to tell which one this booking meant' };
    }
  }

  // Tier 3: does the raw string directly name one (and only one) of the
  // master list's own city values, as a whole word/phrase?
  const cityTokenMatches = dedupeCityMatches(distinctCities.filter((c) => new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i').test(raw)));
  if (cityTokenMatches.length === 1) {
    const rep = masterList.find((e) => e.city === cityTokenMatches[0]);
    return { city: cityTokenMatches[0], method: 'city-token', matchedCinemaName: rep ? rep.cinemaName : null };
  }
  if (cityTokenMatches.length > 1) {
    // Unlike Tier 2 (the SAME cinema name existing in multiple cities), this
    // is the raw text directly naming multiple different cities by word —
    // e.g. "Bangalore, Mumbai, Gurgaon, Noida" (comma-separated, so it never
    // hit resolveMultiFragmentCinemaLocation's "/", "&", "and" split above).
    // That's unambiguous evidence of a genuine multi-city reference, not an
    // unknown single booking.
    return { multiCinema: true, kind: 'genuine-multi', candidateCities: cityTokenMatches, reason: 'raw value directly names more than one different city' };
  }

  // Tier 4: edit distance, last resort — whole-string, against every
  // entry's base name; accepted only when unambiguous (no other entry
  // within one edit of the best score points to a different city). Gated
  // to strings of 12+ normalized characters: below that, a threshold of 2
  // is loose enough to coincidentally match two short, otherwise-unrelated
  // proper nouns (e.g. "PVR Juhu" — a real Mumbai neighborhood — was
  // matching "PVR SAHU, LUCKNOW" at edit-distance 1, purely because "Juhu"
  // and "Sahu" happen to be one letter apart).
  const scored = masterList
    .map((entry) => ({ entry, dist: levenshtein(normRaw, normalizeForCinemaMatch(masterListBaseName(entry))) }))
    .sort((a, b) => a.dist - b.dist);

  const threshold = cinemaMatchThreshold(normRaw.length);
  const best = scored[0];
  if (normRaw.length >= 12 && best && best.dist <= threshold) {
    const rivalDifferentCity = scored.slice(1).find((s) => s.dist <= best.dist + 1 && s.entry.city !== best.entry.city);
    if (!rivalDifferentCity) {
      return { city: best.entry.city, method: 'fuzzy', matchedCinemaName: best.entry.cinemaName, editDistance: best.dist };
    }
  }

  return { closest: scored.slice(0, 3).map((s) => ({ cinemaName: s.entry.cinemaName, city: s.entry.city, editDistance: s.dist })) };
}

// Edit-distance threshold for flagging a value as "suspiciously close to an
// existing canonical value" — tighter for short strings, where one edit is a
// much bigger fraction of the word (and more likely a coincidence, e.g. "NA"
// vs some unrelated 2-letter value) than in a longer word.
function closeMatchThreshold(len) {
  return len <= 4 ? 1 : 2;
}

function normalizeCategoricalField(allRecords, field, curatedMap, flagKey) {
  const rawExactValues = new Set(); // exact raw strings, pre-trim/pre-lowercase — the true "before" count
  const groups = new Map(); // lowercase key -> { count, sampleRaw }
  for (const rec of allRecords) {
    const raw = rec[field];
    if (raw == null || raw === '') continue;
    rawExactValues.add(raw);
    const trimmed = String(raw).trim();
    const key = trimmed.toLowerCase();
    const entry = groups.get(key) || { count: 0, sampleRaw: trimmed };
    entry.count += 1;
    groups.set(key, entry);
  }
  const beforeCount = rawExactValues.size;

  const resolved = new Map(); // lowercase key -> final canonical value (may be null — see CITY_CANON's state-name entries)
  const flaggedKeys = new Set();
  const canonicalValues = new Set(Object.values(curatedMap).filter((v) => v != null));

  for (const key of Object.keys(curatedMap)) {
    if (groups.has(key)) resolved.set(key, curatedMap[key]);
  }
  // Resolve remaining (uncurated) values most-frequent-first, so a common,
  // presumably-correct spelling gets locked in as canonical before a rarer
  // variant is checked against it — otherwise a rare early-appearing typo
  // could get adopted as "canonical" and cause the real spelling to be
  // flagged against it instead. Matters most for fields with no curated map
  // at all (e.g. city), where this loop does all of the resolution work.
  const unresolvedKeysByFrequency = [...groups.keys()].filter((k) => !resolved.has(k)).sort((a, b) => groups.get(b).count - groups.get(a).count);
  for (const key of unresolvedKeysByFrequency) {
    const entry = groups.get(key);
    const titleCased = titleCase(entry.sampleRaw);
    let closestMatch = null;
    let closestDist = Infinity;
    for (const canon of canonicalValues) {
      const dist = levenshtein(key, canon.toLowerCase());
      if (dist < closestDist) {
        closestDist = dist;
        closestMatch = canon;
      }
    }
    if (closestMatch && closestDist <= closeMatchThreshold(key.length) && closestDist > 0) {
      flaggedKeys.add(key);
      resolved.set(key, titleCased); // kept distinct, not force-merged, pending review
    } else {
      resolved.set(key, titleCased);
      canonicalValues.add(titleCased);
    }
  }

  const nulledOutRows = [];
  for (const rec of allRecords) {
    const raw = rec[field];
    if (raw == null || raw === '') continue;
    const key = String(raw).trim().toLowerCase();
    if (flaggedKeys.has(key)) {
      flagValue(flagKey, groups.get(key).sampleRaw, rec.sourceSheet, rec._excelRow, rec.clientName);
    }
    const finalValue = resolved.get(key);
    if (finalValue == null && Object.prototype.hasOwnProperty.call(curatedMap, key)) {
      // `record` is a reference, not a copy — later passes (e.g. resolveRegions)
      // still mutate `rec` in place, so anything read off `record` afterward
      // (region, in particular) reflects the FINAL value, not this pass's.
      nulledOutRows.push({ sheet: rec.sourceSheet, row: rec._excelRow, originalValue: raw, record: rec });
    }
    rec[field] = finalValue;
  }

  const afterCount = new Set([...resolved.values()].filter((v) => v != null)).size;
  return { beforeCount, afterCount, nulledOutRows };
}

// ---------------------------------------------------------------------------
// Client-name candidate audit — a REPORT-ONLY pass, run after
// CLIENT_NAME_CANON's confirmed merges have already been applied. Finds
// pairs of distinct client identities that look like they might be the same
// real client (edit-distance-close, or one name a whole-word prefix/
// substring of the other — e.g. "DLF" vs "DLF Chandigarh") and clusters
// them into groups for data/reports/clientNameCandidates.json. Nothing
// here is applied to the data — merging a real client incorrectly would
// distort the Leaderboard, so this is strictly "here's what looked similar,
// you decide."
// ---------------------------------------------------------------------------

// Length-scaled edit-distance budget for whole client-name strings — these
// range from a few characters ("BCG") to 40+ (full private-limited company
// names), far more varied than the fixed-width closeMatchThreshold used for
// single category words. ~18% of length, floor of 1, cap of 4 (beyond that,
// two names sharing that many edits are more likely coincidence than typo).
function clientNameMatchThreshold(len) {
  return Math.min(4, Math.max(1, Math.round(len * 0.18)));
}

// True when `shortKey` reads as a whole-word prefix or substring of
// `longKey` — e.g. "dlf" inside "dlf chandigarh", but NOT "an" inside
// "anand" (word-boundary guarded, so a short name never spuriously matches
// as a fragment of an unrelated longer word).
function isWholeWordSubstring(shortKey, longKey) {
  if (shortKey.length < 3 || shortKey.length >= longKey.length) return false;
  return new RegExp(`(^|\\s)${escapeRegExp(shortKey)}(\\s|$)`).test(longKey);
}

/**
 * Builds the client-name candidate-group report. `allRecords` must already
 * have CLIENT_NAME_CANON's confirmed merges applied. Returns an array of
 * groups, each `{ suggestedCanonical, totalRecords, totalRevenue, members:
 * [{ displayName, recordCount, revenue, matchedVia }] }`, sorted by total
 * revenue descending — the groups most worth a human's attention first.
 */
function buildClientNameCandidateGroups(allRecords) {
  const byKey = new Map(); // lowercase trimmed identity -> { displayName, nameCounts, recordCount, revenue }
  for (const rec of allRecords) {
    const raw = (rec.corporateName || rec.clientName || '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase().replace(/\s+/g, ' ');
    let entry = byKey.get(key);
    if (!entry) {
      entry = { key, nameCounts: new Map(), recordCount: 0, revenue: 0 };
      byKey.set(key, entry);
    }
    entry.nameCounts.set(raw, (entry.nameCounts.get(raw) || 0) + 1);
    entry.recordCount += 1;
    entry.revenue += rec.totalAmount || 0;
  }

  const identities = [...byKey.values()].map((entry) => {
    let displayName = null;
    let bestCount = -1;
    for (const [name, count] of entry.nameCounts) {
      if (count > bestCount) { displayName = name; bestCount = count; }
    }
    return { key: entry.key, displayName, recordCount: entry.recordCount, revenue: entry.revenue };
  });

  // Union-find over candidate pairs, so a chain (A~B, B~C) groups A/B/C
  // together even if A and C alone wouldn't have matched directly.
  const parent = identities.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { const ri = find(i); const rj = find(j); if (ri !== rj) parent[ri] = rj; };
  const matchReasons = new Map(); // "i|j" -> reason string, for reporting

  for (let i = 0; i < identities.length; i++) {
    for (let j = i + 1; j < identities.length; j++) {
      const a = identities[i].key;
      const b = identities[j].key;
      if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.5 + 4) continue; // cheap skip before the expensive edit-distance call
      let reason = null;
      if (isWholeWordSubstring(a, b) || isWholeWordSubstring(b, a)) {
        reason = 'one name is a whole-word prefix/substring of the other';
      } else {
        const dist = levenshtein(a, b);
        if (dist > 0 && dist <= clientNameMatchThreshold(Math.max(a.length, b.length))) {
          reason = `edit distance ${dist}`;
        }
      }
      if (reason) {
        union(i, j);
        matchReasons.set(`${i}|${j}`, reason);
      }
    }
  }

  const clusters = new Map(); // root index -> array of identity indices
  for (let i = 0; i < identities.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }

  const groups = [];
  for (const indices of clusters.values()) {
    if (indices.length < 2) continue;
    const members = indices.map((idx) => identities[idx]);
    members.sort((x, y) => y.revenue - x.revenue);
    const reasonsForGroup = [...new Set(
      indices.flatMap((i) => indices.filter((j) => j > i).map((j) => matchReasons.get(`${i}|${j}`)).filter(Boolean)),
    )];
    groups.push({
      suggestedCanonical: members[0].displayName, // highest-revenue member — a suggestion only, never applied
      totalRecords: members.reduce((s, m) => s + m.recordCount, 0),
      totalRevenue: members.reduce((s, m) => s + m.revenue, 0),
      matchReasons: reasonsForGroup,
      members: members.map((m) => ({ displayName: m.displayName, recordCount: m.recordCount, revenue: m.revenue })),
    });
  }

  groups.sort((a, b) => b.totalRevenue - a.totalRevenue);
  return groups;
}

// ---------------------------------------------------------------------------
// Monthly sheet parsing (April-2023 .. Aug-2026): one flat table, header row 0.
// ---------------------------------------------------------------------------
function parseMonthlySheet(wb, sheetName) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => (h == null ? null : String(h).trim()));
  const colIndex = {}; // canonical field -> column index
  let monthColIdx = -1;
  let dosColIdx = -1;
  let totalAmountColIdx = -1;

  header.forEach((h, idx) => {
    if (h == null) return;
    const key = h.toLowerCase();
    if (key === MONTH_HEADER) { monthColIdx = idx; return; }
    if (key === DATE_OF_SCREENING_HEADER) { dosColIdx = idx; return; }
    if (TOTAL_AMOUNT_HEADERS.has(key)) { totalAmountColIdx = idx; return; }
    if (HEADER_ALIASES[key]) colIndex[HEADER_ALIASES[key]] = idx;
  });

  const sheetNameFallback = parseSheetName(sheetName);

  // The Month column is supposed to be one constant serial for the whole
  // sheet. It's occasionally been corrupted by an Excel autofill drag on a
  // handful of rows (turning a constant into a sequential date series), which
  // would otherwise silently produce wildly wrong years for those rows. Use
  // the sheet-wide mode as the trusted anchor and treat any row that strays
  // more than a month from it as suspect.
  const monthModeCounts = new Map();
  if (monthColIdx >= 0) {
    for (let i = 1; i < rows.length; i++) {
      const v = rows[i][monthColIdx];
      if (typeof v !== 'number') continue;
      const ctx = excelSerialToYearMonth(v);
      const key = `${ctx.year}-${ctx.month}`;
      monthModeCounts.set(key, (monthModeCounts.get(key) || 0) + 1);
    }
  }
  let dominantContext = sheetNameFallback;
  let dominantCount = 0;
  for (const [key, count] of monthModeCounts.entries()) {
    if (count > dominantCount) {
      const [year, month] = key.split('-').map(Number);
      dominantContext = { year, month };
      dominantCount = count;
    }
  }

  let lastKnownContext = dominantContext;
  const records = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const excelRow = i + 1;

    const clientName = colIndex.clientName != null ? r[colIndex.clientName] : null;
    const movieName = colIndex.movieName != null ? r[colIndex.movieName] : null;
    const cinemaLocation = colIndex.cinemaLocation != null ? r[colIndex.cinemaLocation] : null;
    const city = colIndex.city != null ? r[colIndex.city] : null;
    const isBlank = (v) => v == null || String(v).trim() === '';
    if (isBlank(clientName) && isBlank(movieName) && isBlank(cinemaLocation) && isBlank(city)) {
      continue; // subtotal / grand-total / fully-empty row
    }

    const rawClientType = colIndex.clientType != null ? r[colIndex.clientType] : null;
    if (rawClientType != null && CORRUPTED_IDENTITY_VALUES.has(String(rawClientType).trim().toLowerCase())) {
      logIssue(sheetName, excelRow, 'clientType', rawClientType, 'client identity duplicates the cinema location across every identity column — row dropped as corrupted');
      continue;
    }

    let context = null;
    if (monthColIdx >= 0 && typeof r[monthColIdx] === 'number') {
      const rowContext = excelSerialToYearMonth(r[monthColIdx]);
      if (dominantContext && monthsDiffCtx(rowContext, dominantContext) > 1) {
        logIssue(sheetName, excelRow, 'month', r[monthColIdx], `resolves to ${rowContext.year}-${String(rowContext.month).padStart(2, '0')}, inconsistent with the sheet's dominant month ${dominantContext.year}-${String(dominantContext.month).padStart(2, '0')} — used the sheet default instead`);
        context = dominantContext;
      } else {
        context = rowContext;
        lastKnownContext = rowContext;
      }
    } else {
      context = lastKnownContext;
    }

    const record = { sourceSheet: sheetName };
    for (const field of SCHEMA_FIELDS) {
      if (['sourceSheet', 'month', 'year', 'totalAmount', 'dateOfScreening', 'clientCategory'].includes(field)) continue;
      const idx = colIndex[field];
      let val = idx != null ? r[idx] : null;
      if (val != null && typeof val === 'string') val = val.trim();
      if (val === '') val = null;
      if (['srNo', 'tickets', 'atp', 'sph', 'gboc', 'gcc'].includes(field)) val = toNumberOrNull(val);
      record[field] = val;
    }

    record.week = normalizeWeek(record.week);
    // record.region is left as the raw trimmed value here; resolveRegions()
    // does the final normalization/derivation once every sheet is parsed.
    record.bookingType = normalizeBookingType(record.bookingType, sheetName, excelRow, clientName);
    const { clientType, clientCategory } = normalizeClientTypeAndCategory(record.clientType, sheetName, excelRow, clientName);
    record.clientType = clientType;
    record.clientCategory = clientCategory;

    record.month = context ? context.month : null;
    record.year = context ? context.year : null;

    record.totalAmount = totalAmountColIdx >= 0 ? coerceTotalAmount(r[totalAmountColIdx], sheetName, excelRow) : null;
    record.dateOfScreening = dosColIdx >= 0 ? parseDateOfScreening(r[dosColIdx], context, sheetName, excelRow) : null;
    record._excelRow = excelRow;

    records.push(record);
  }

  return records;
}

// ---------------------------------------------------------------------------
// "Year 2022 data" sheet: ~12 stacked monthly blocks, each with its own
// repeated header row and a trailing subtotal row. Fixed column layout:
// 0 S.No. | 1 Month | 2 Client Name | 3 Industry | 4 Total Amount |
// 5 Movie Name | 6 Movie Category | 7 Weekday/Weekend | 8 Cinema Location |
// 9 Region | 10 Tickets | 11 ATP | 12 SPH | 13 GBOC | 14 GCC | 15 Remarks
// ---------------------------------------------------------------------------
function parseYear2022Sheet(wb, sheetName) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
  const records = [];
  let context = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const excelRow = i + 1;
    const isBlank = (v) => v == null || String(v).trim() === '';

    if (String(r[1]).trim() === 'Month' && String(r[2]).trim() === 'Client Name') continue; // repeated header

    const clientName = r[2];
    const movieName = r[5];
    const cinemaLocation = r[8];
    if (isBlank(clientName) && isBlank(movieName) && isBlank(cinemaLocation)) continue; // subtotal / blank row

    const monthCtx = parseYear2022MonthText(r[1]);
    if (monthCtx) context = monthCtx;

    const record = {
      srNo: toNumberOrNull(r[0]),
      week: null,
      month: context ? context.month : null,
      year: context ? context.year : null,
      clientType: null,
      clientCategory: null,
      clientName: isBlank(clientName) ? null : String(clientName).trim(),
      corporateName: null,
      industry: isBlank(r[3]) ? null : String(r[3]).trim(),
      bookingType: null,
      region: isBlank(r[9]) ? null : String(r[9]).trim(),
      city: null,
      cinemaLocation: isBlank(cinemaLocation) ? null : String(cinemaLocation).trim(),
      movieName: isBlank(movieName) ? null : String(movieName).trim(),
      dateOfScreening: null,
      tickets: toNumberOrNull(r[10]),
      atp: toNumberOrNull(r[11]),
      sph: toNumberOrNull(r[12]),
      gboc: toNumberOrNull(r[13]),
      gcc: toNumberOrNull(r[14]),
      branding: null,
      totalAmount: coerceTotalAmount(r[4], sheetName, excelRow),
      movieIndustry: null,
      movieLanguage: null,
      audiFormat: null,
      movieCategory: isBlank(r[6]) ? null : String(r[6]).trim(),
      weekdayWeekend: isBlank(r[7]) ? null : String(r[7]).trim(),
      remarks: isBlank(r[15]) ? null : String(r[15]).trim(),
      sourceSheet: sheetName,
      _excelRow: excelRow,
    };

    records.push(record);
  }

  return records;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const inputPath = process.argv[2] || DEFAULT_INPUT;
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(inputPath);
  const allRecords = [];

  for (const sheetName of wb.SheetNames) {
    const records = sheetName === 'Year 2022 data'
      ? parseYear2022Sheet(wb, sheetName)
      : parseMonthlySheet(wb, sheetName);
    recordsPerSheet[sheetName] = records.length;
    allRecords.push(...records);
  }

  // ---------------------------------------------------------------------
  // Manual, user-confirmed city resolutions for specific rows where a state
  // name had leaked into the City column (see the earlier nullCityRows.json
  // report) — applied BEFORE city normalization runs, keyed by sheet+row
  // (the same identity nullCityRows.json itself used) since that's stable
  // and unique per record. Two rows from that report are deliberately left
  // out here ("PVR Icon Infinity" and "INOX PVS MALL") — genuinely
  // unconfirmed at the time, they're now resolved instead by the cinema
  // master-list pass a bit further down (CINEMA_LOCATION_OVERRIDES).
  // ---------------------------------------------------------------------
  const MANUAL_CITY_BY_ROW = {
    'July-2024|32': 'Kolhapur',
    'July-2024|33': 'Dombivali',
    'Aug - 2024|30': 'Kochi',
    'Aug - 2024|45': 'Kochi',
    'Aug - 2024|60': 'Kochi',
    'Aug - 2024|75': 'Kochi',
    'Sep - 2024|72': 'Surat',
    'Sep - 2024|84': 'Surat',
    'Sep - 2024|90': 'Surat',
    'April - 2025|2': 'Jamnagar',
    'June-2025|90': 'Raipur',
    'June-2025|94': 'Bangalore',
    'Oct-2025|5': 'Kurla',
    'Oct-2025|9': 'Mumbai',
    'Nov-2025|34': 'Ahmedabad', // PVR Acropolis is in Ahmedabad (Thaltej), not Rajkot
    'JUNE-2026|11': 'Ahmedabad',
    'JUNE-2026|23': 'Lucknow',
    'JUNE-2026|25': 'Raipur',
    'June-2024|14': 'Raipur', // "CINEMAX CITY CENTRE MALL" — confirmed by user; the only one of the 7 bare-name rows whose current city ("Chennai") wasn't already a real candidate
    // "Multy Cinemas" — same raw cinemaLocation text on both rows, but
    // confirmed as two DIFFERENT real properties, not one — can't be a
    // plain text override (CINEMA_LOCATION_OVERRIDES has no way to give
    // the same string two different answers), so this needs row identity.
    'Year 2022 data|90': 'Delhi', // PVR Shalimar Bagh
    'Year 2022 data|94': 'Noida', // PVR Logix
  };
  // Rows in MANUAL_CITY_BY_ROW whose raw Region cell is ALSO wrong — not
  // blank (which resolveRegions would fix on its own), but a real,
  // confidently-typed-looking region string that's simply incorrect for the
  // cinema's real city. Cleared here (rather than hardcoding the "right"
  // region) so resolveRegions re-derives it from the now-correct city via
  // the same trusted majority-vote mechanism every other row goes through.
  const MANUAL_REGION_CLEAR = new Set([
    'June-2024|14', // "CINEMAX CITY CENTRE MALL" — raw sheet says region "South" for a Raipur (Central) cinema; this whole client block in this sheet has scrambled regions (see nearby rows), so it's not treated as reliable
  ]);
  let manualCityOverrideCount = 0;
  for (const rec of allRecords) {
    const key = `${rec.sourceSheet}|${rec._excelRow}`;
    if (Object.prototype.hasOwnProperty.call(MANUAL_CITY_BY_ROW, key)) {
      rec.city = MANUAL_CITY_BY_ROW[key];
      manualCityOverrideCount += 1;
    }
    if (MANUAL_REGION_CLEAR.has(key)) rec.region = null;
  }

  // "Sapna Sngeeta Inox" rows had a garbled 2-character city value ("Ci")
  // that matched nothing — confirmed via public listing to be PVR INOX
  // Sapna Sangeeta, Indore (the same property already correctly named
  // elsewhere in the sheet as "PVR INOX Sapna Sangeeta, Indore").
  let sapnaOverrideCount = 0;
  for (const rec of allRecords) {
    if (rec.cinemaLocation === 'Sapna Sngeeta Inox' && rec.city !== 'Indore') {
      rec.city = 'Indore';
      sapnaOverrideCount += 1;
    }
  }

  // "PVR Market City, Viman nagar" — confirmed by user to be PVR Market
  // City PUNE, reversing an earlier Mumbai/Kurla mapping. Forced
  // unconditionally (unlike the normal city-override path, which only
  // fires when a row's existing city is missing/leaked) because 2 of the
  // 4 rows using this exact text already had a directly-typed "Mumbai" in
  // the source sheet — the same property, same client ("Zee"), same
  // sheet, contradicting the other 2 rows that already read "Pune". Since
  // the user's confirmation is about the PROPERTY, not just the two rows
  // originally flagged, all 4 get the same, now-consistent answer.
  let vimanNagarOverrideCount = 0;
  for (const rec of allRecords) {
    if (rec.cinemaLocation === 'PVR Market City, Viman nagar' && rec.city !== 'Pune') {
      rec.city = 'Pune';
      vimanNagarOverrideCount += 1;
    }
  }

  // movieCategory: "na"/"NA"/"Na" is a placeholder, not a real category —
  // coerce every case variant to a proper null so it stops appearing as a
  // distinct value in category breakdowns.
  let movieCategoryNulledCount = 0;
  for (const rec of allRecords) {
    if (rec.movieCategory != null && String(rec.movieCategory).trim().toLowerCase() === 'na') {
      rec.movieCategory = null;
      movieCategoryNulledCount += 1;
    }
  }

  // ---------------------------------------------------------------------
  // Cinema master-list resolution — an optional bonus pass, run against
  // whatever the manual/Sapna overrides above didn't already fix. Uses
  // PVR's internal cinema-pricing workbook (a second, separate reference
  // file) to resolve rows whose city is still missing/a leaked state name,
  // or whose region is still null, by matching the row's raw cinemaLocation
  // text against PVR's real property list — see
  // matchCinemaLocationToMasterList above for the exact -> substring ->
  // city-token -> edit-distance ladder, and looksLikeMultiCinemaList for
  // what gets deliberately left alone instead of guessed at (two different
  // cinemas concatenated into one field, e.g. "Maison & Ambience"). Runs
  // BEFORE city normalization so anything it resolves gets the same
  // CITY_CANON dedup/alias treatment as every other raw city value.
  // ---------------------------------------------------------------------
  const cinemaMasterList = buildCinemaMasterList(path.join(__dirname, CINEMA_MASTER_INPUT));
  const masterListResolutions = [];
  const multiCinemaRows = [];
  const unmatchedCinemaLocations = new Map(); // normalized raw -> { cinemaLocation, closest, exampleRows, count }
  let masterListResolvedCount = 0;
  let multiConfirmedCount = 0;
  let ambiguousSingleNameCount = 0;

  if (cinemaMasterList) {
    for (const rec of allRecords) {
      const cityIsMissingOrLeaked =
        rec.city == null || rec.city === '' ||
        (typeof rec.city === 'string' && STATE_NAME_LEAK_VALUES.has(rec.city.trim().toLowerCase()));
      // Deliberately NOT triggered by "region is null but city already
      // looks fine" — that case belongs to resolveRegions' own city-based
      // majority vote below, which runs right after this and needs no help
      // here. Re-matching cinemaLocation for an already-good city only adds
      // risk: several PVR mall names (Forum, Sangam, Vega, Plaza, VR, ...)
      // are reused across multiple cities, so a record whose OWN city
      // already disambiguates it could otherwise get wrongly flagged
      // "ambiguous" purely because its cinemaLocation also matches a
      // same-named property somewhere else.
      // "Multi Cty" is a deliberate "more than one city" marker already —
      // never try to resolve it down to a single city.
      if (!cityIsMissingOrLeaked || rec.city === 'Multi Cty' || !rec.cinemaLocation) continue;

      const match = matchCinemaLocationToMasterList(rec.cinemaLocation, cinemaMasterList);
      if (!match) continue;

      if (match.multiCinema) {
        multiCinemaRows.push({
          sheet: rec.sourceSheet,
          row: rec._excelRow,
          clientName: rec.clientName,
          cinemaLocation: rec.cinemaLocation,
          currentCity: rec.city,
          currentRegion: rec.region,
          candidateCities: match.candidateCities,
          kind: match.kind, // 'genuine-multi' (gets region="Multi" below) vs 'ambiguous-single-name' (left untouched — one unknown booking at one of several same-named places, not a multi-city deal)
          reason: match.reason,
        });
        if (match.kind === 'genuine-multi') {
          rec.city = null;
          rec.region = 'Multi';
          multiConfirmedCount += 1;
        } else {
          ambiguousSingleNameCount += 1;
        }
        continue;
      }

      if (match.city) {
        masterListResolutions.push({
          sheet: rec.sourceSheet,
          row: rec._excelRow,
          clientName: rec.clientName,
          originalCinemaLocation: rec.cinemaLocation,
          matchedCinemaName: match.matchedCinemaName,
          derivedCity: match.city,
          method: match.method,
          previousCity: rec.city,
        });
        rec.city = match.city;
        masterListResolvedCount += 1;
        continue;
      }

      // No confident match (match.closest only) — logged once per distinct
      // cinemaLocation value, purely for reference, per the "confirm these
      // have no match" ask (not auto-applied below the confidence
      // threshold). Every row is recorded (not just a few examples) so this
      // file can double as a sheet+row lookup, since a record can land here
      // with region already non-null (derived from a sibling record with
      // the same cinemaLocation) — meaning it's invisible to
      // unresolvedCityRows.json's "region is null" check even though its
      // city is still genuinely unresolved.
      const key = normalizeForCinemaMatch(rec.cinemaLocation);
      if (!unmatchedCinemaLocations.has(key)) {
        unmatchedCinemaLocations.set(key, {
          cinemaLocation: rec.cinemaLocation,
          closest: match.closest || [],
          rows: [],
          count: 0,
        });
      }
      const entry = unmatchedCinemaLocations.get(key);
      entry.count += 1;
      entry.rows.push({ sheet: rec.sourceSheet, row: rec._excelRow, clientName: rec.clientName });
    }
  }

  // Special case: rows whose cinemaLocation is the BARE, ambiguous "Cinemax
  // City Center" / "Cinemax City Centre Mall" name — the master list
  // confirms two distinct real properties share this exact shorthand
  // (Nashik and Raipur), so a bare mention with no city/area qualifier at
  // all can't be resolved from the name alone. Scans every record (not
  // just currently-unresolved ones), because a couple of these rows
  // already carry a city value nothing else in this ETL run ever
  // questioned. Only flagged when that current city ISN'T already one of
  // the two real candidates — a row a human directly typed "Raipur" or
  // "Nashik" into (or one already resolved via the earlier confirmed
  // Chattisgarh->Raipur city-name fix) has real grounding and is left
  // alone; only a current city that's neither (blank, or some unrelated
  // value like "Chennai") means the ambiguity was never actually settled.
  const bareCinemaxPattern = /^CINEMAX CITY (CENTRE|CENTER)( MALL)?$/;
  const cinemaxSettledCities = new Set(['nashik', 'raipur']);
  for (const rec of allRecords) {
    if (!rec.cinemaLocation || !bareCinemaxPattern.test(normalizeForCinemaMatch(rec.cinemaLocation))) continue;
    if (rec.city && cinemaxSettledCities.has(String(rec.city).trim().toLowerCase())) continue;
    multiCinemaRows.push({
      sheet: rec.sourceSheet,
      row: rec._excelRow,
      clientName: rec.clientName,
      cinemaLocation: rec.cinemaLocation,
      currentCity: rec.city,
      currentRegion: rec.region,
      candidateCities: ['Nashik', 'Raipur'],
      reason: 'bare "Cinemax City Center" — the master list has two distinct properties by this exact shorthand (Nashik and Raipur); this row names neither, and its current city is neither, so it was never actually confirmed',
    });
  }

  const movieIndustryStats = normalizeCategoricalField(allRecords, 'movieIndustry', MOVIE_INDUSTRY_CANON, 'movieIndustry');
  const movieLanguageStats = normalizeCategoricalField(allRecords, 'movieLanguage', MOVIE_LANGUAGE_CANON, 'movieLanguage');
  // CITY_CANON only covers the handful of confirmed genuine typos manually
  // reviewed from flaggedValues.json — hundreds of other distinct raw values
  // across dozens of cinema circuits is far too many to hand-verify like the
  // ~20 movie industries/languages, so everything else still just gets the
  // automatic casing merge + flag-if-uncertain treatment.
  const cityStats = normalizeCategoricalField(allRecords, 'city', CITY_CANON, 'city');

  // Client-name consolidation — same curated-map-first, flag-don't-guess
  // treatment as city/movieIndustry/movieLanguage above. Applied to BOTH
  // fields (see CLIENT_NAME_CANON's comment for why) since the dashboard's
  // own client-identity logic reads whichever one a given row actually
  // used. The confirmed merges directly affect Leaderboard revenue
  // attribution, so — same as CITY_CANON — everything NOT in the curated
  // map either auto-merges safely (pure casing/whitespace) or gets flagged
  // and left alone; see buildClientNameCandidateGroups below for the
  // broader, report-only near-duplicate audit.
  // Distinct-identity count before/after, using the SAME `corporateName ||
  // clientName` precedence the dashboard's own normalizeClientKey() uses —
  // not a per-field count, since that's what "how many clients" actually
  // means to the app.
  const countDistinctClientIdentities = (records) => {
    const keys = new Set();
    for (const rec of records) {
      const raw = (rec.corporateName || rec.clientName || '').trim();
      if (raw) keys.add(raw.toLowerCase().replace(/\s+/g, ' '));
    }
    return keys.size;
  };
  const clientIdentityCountBefore = countDistinctClientIdentities(allRecords);
  const clientNameStats = normalizeCategoricalField(allRecords, 'clientName', CLIENT_NAME_CANON, 'clientName');
  const corporateNameStats = normalizeCategoricalField(allRecords, 'corporateName', CLIENT_NAME_CANON, 'corporateName');
  const clientIdentityCountAfter = countDistinctClientIdentities(allRecords);
  const clientNameCandidateGroups = buildClientNameCandidateGroups(allRecords);

  const neToNorthCount = allRecords.filter(
    (rec) => rec.region != null && /^ne$|^north\s*east$|^northeast$/i.test(String(rec.region).trim()),
  ).length;

  const regionDerivations = resolveRegions(allRecords);

  // Manually-corrected Year 2022 Region values — applied last, after every
  // other region step (the derivation above, and the cinema master-list
  // pass's "Multi" tagging earlier), so these are the final word for that
  // sheet's rows and nothing downstream second-guesses them. Only rows the
  // corrected file actually has a value for are touched; everything else
  // in that sheet keeps whatever resolveRegions already computed.
  const year2022RegionFixes = loadYear2022RegionFixes(path.join(__dirname, YEAR_2022_REGION_FIX_INPUT));
  let year2022RegionFixCount = 0;
  if (year2022RegionFixes) {
    for (const rec of allRecords) {
      if (rec.sourceSheet !== 'Year 2022 data') continue;
      if (!year2022RegionFixes.has(rec._excelRow)) continue;
      rec.region = year2022RegionFixes.get(rec._excelRow);
      year2022RegionFixCount += 1;
    }
  }

  // "Ambi/ Maison/ Forum / VR Chennai" (row 126) — confirmed by user as
  // PVR Ambience Gurgaon (city set via CINEMA_LOCATION_OVERRIDES above).
  // Gurgaon's region is overwhelmingly North (253 of 263 records) — the
  // hand-corrected Year 2022 file's own answer for this specific row
  // ("West") predates that identification and is superseded here, per
  // explicit instruction to apply city AND region directly rather than
  // leave the file's earlier, more general answer standing.
  for (const rec of allRecords) {
    if (rec.sourceSheet === 'Year 2022 data' && rec.cinemaLocation === 'Ambi/ Maison/ Forum / VR Chennai') {
      rec.region = 'North';
    }
  }

  // ---------------------------------------------------------------------
  // Fresh, dataset-wide re-scan: for every row where REGION is STILL null
  // after every step above — including rows whose city already holds SOME
  // value (even a wrong one, like a leaked state name, or "Own Content")
  // that made them invisible to the cinema master-list pass's narrower
  // "city missing or leaked" candidate check earlier — make one more
  // attempt via cinemaLocation against the master list. Scans every
  // record fresh (not a cached/logged list), so nothing that slipped past
  // the earlier, narrower pass is missed. Never touches city here — only
  // fills region, either directly (a confident single-city match whose
  // region is knowable from the rest of the now-more-complete dataset) or
  // as "Multi" (a genuine multi-cinema cinemaLocation, e.g. a "Multi Cty"
  // city paired with a "Multi ..." cinemaLocation that was never actually
  // confirmed as Multi before). An ambiguous single-cinema-name match
  // (the same name reused across different real cities) still resolves
  // nothing here, same as it always has — one unknown booking at one of
  // several same-named places is not evidence of anything.
  // ---------------------------------------------------------------------
  let freshRegionResolvedCount = 0;
  if (cinemaMasterList) {
    const cityToRegionCounts2 = new Map();
    for (const rec of allRecords) {
      if (!rec.city || !rec.region || rec.region === 'Multi') continue;
      const key = normCityKey(rec.city);
      const m = cityToRegionCounts2.get(key) || new Map();
      m.set(rec.region, (m.get(rec.region) || 0) + 1);
      cityToRegionCounts2.set(key, m);
    }
    const cityToRegion2 = new Map();
    for (const [key, counts] of cityToRegionCounts2) {
      let best = null;
      let bestCount = -1;
      for (const [region, count] of counts) {
        if (count > bestCount) { best = region; bestCount = count; }
      }
      cityToRegion2.set(key, best);
    }
    // Confirmed by user, for cities with no (or only 1) corroborating
    // record to derive a region from via majority vote — takes priority
    // over whatever the vote above computed.
    const CONFIRMED_CITY_REGION = { Porvorim: 'West', Dombivali: 'West', Machilipatnam: 'South' };
    for (const [city, region] of Object.entries(CONFIRMED_CITY_REGION)) {
      cityToRegion2.set(normCityKey(city), region);
    }

    for (const rec of allRecords) {
      if (rec.region != null || !rec.cinemaLocation) continue;
      const match = matchCinemaLocationToMasterList(rec.cinemaLocation, cinemaMasterList);
      if (!match) continue;
      if (match.multiCinema && match.kind === 'genuine-multi') {
        rec.region = 'Multi';
        freshRegionResolvedCount += 1;
      } else if (match.city) {
        const derivedRegion = cityToRegion2.get(normCityKey(match.city));
        if (derivedRegion) {
          rec.region = derivedRegion;
          freshRegionResolvedCount += 1;
        }
      }
    }

    // Direct catch-up for CONFIRMED_CITY_REGION: the pass above only fills
    // region for rows whose cinemaLocation re-matches the master list
    // right now — but some rows (e.g. "PVR Dombivali") already got their
    // city from an earlier pass via a match this file's own matcher can't
    // reproduce today (no contiguous substring against the master list
    // entry). Those still deserve the confirmed region, so check by CITY
    // directly instead of re-deriving through cinemaLocation.
    for (const rec of allRecords) {
      if (rec.region != null || !rec.city) continue;
      const confirmed = CONFIRMED_CITY_REGION[rec.city];
      if (confirmed) {
        rec.region = confirmed;
        freshRegionResolvedCount += 1;
      }
    }
  }

  // `record` on each nulledOutRows entry is a live reference — read now,
  // after resolveRegions has run, so `region` reflects the final resolved
  // value rather than whatever it was mid-normalization.
  const nullCityRows = cityStats.nulledOutRows.map((row) => ({
    sheet: row.sheet,
    row: row.row,
    clientName: row.record.clientName,
    cinemaLocation: row.record.cinemaLocation,
    region: row.record.region,
    rawCityValue: row.originalValue,
  }));

  // Everything still wrong/unknown about city or region after every
  // confirmed fix above — three distinct gap types in one report so nothing
  // requires cross-referencing multiple files to triage:
  //   1. state-name-in-city rows this run still couldn't resolve (city null)
  //   2. correctly-SPELLED state names sitting in the city field (never
  //      flagged, because nothing about them looks like a typo)
  //   3. records whose region is still null — an unrecognized cinemaLocation
  const STATE_NAME_CITIES = new Set(['Rajasthan', 'Punjab', 'Maharashtra', 'Karnataka']);
  const unresolvedCityRows = [
    ...nullCityRows.map((row) => ({ ...row, gapType: 'state-name-in-city-unresolved' })),
    ...allRecords
      .filter((rec) => STATE_NAME_CITIES.has(rec.city))
      .map((rec) => ({
        sheet: rec.sourceSheet,
        row: rec._excelRow,
        clientName: rec.clientName,
        cinemaLocation: rec.cinemaLocation,
        region: rec.region,
        rawCityValue: rec.city,
        gapType: 'correctly-spelled-state-name-in-city-field',
      })),
    ...allRecords
      .filter((rec) => rec.region == null)
      .map((rec) => ({
        sheet: rec.sourceSheet,
        row: rec._excelRow,
        clientName: rec.clientName,
        cinemaLocation: rec.cinemaLocation,
        region: rec.region,
        rawCityValue: rec.city,
        gapType: 'unresolved-cinema-location',
      })),
  ];

  // `_excelRow` is an internal-only field — strip it now, after every step
  // that still needed it (the cinema master-list pass above, and the
  // nullCityRows/unresolvedCityRows reports just built), so it never leaks
  // into bookings.json.
  for (const rec of allRecords) delete rec._excelRow;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  fs.writeFileSync(path.join(OUT_DIR, 'bookings.json'), JSON.stringify(allRecords, null, 2));

  // The dashboard fetches its data from /data/bookings.json at runtime, which
  // Vite serves straight off disk from public/data/ — a plain static file,
  // not something bundled or watched. `npm run dev`/`build` also copy
  // data/bookings.json there (see scripts/syncData.js), but only when one of
  // those commands actually starts — re-running this ETL against an
  // already-running dev server would otherwise leave public/data/bookings.json
  // silently stale. Writing it directly here means a bare `node etl.cjs` run
  // can never drift from what the app serves, regardless of what else is running.
  const publicDataDir = path.join(__dirname, 'public', 'data');
  fs.mkdirSync(publicDataDir, { recursive: true });
  fs.copyFileSync(path.join(OUT_DIR, 'bookings.json'), path.join(publicDataDir, 'bookings.json'));
  fs.writeFileSync(path.join(OUT_DIR, 'regionDerivations.json'), JSON.stringify(regionDerivations, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'nullCityRows.json'), JSON.stringify(nullCityRows, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'unresolvedCityRows.json'), JSON.stringify(unresolvedCityRows, null, 2));

  if (cinemaMasterList) {
    fs.writeFileSync(path.join(OUT_DIR, 'pvrCinemaMasterList.json'), JSON.stringify(cinemaMasterList, null, 2));
    fs.writeFileSync(
      path.join(OUT_DIR, 'masterListResolutions.json'),
      JSON.stringify(
        {
          resolutions: masterListResolutions,
          unmatched: [...unmatchedCinemaLocations.values()].sort((a, b) => b.count - a.count),
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(OUT_DIR, 'multiCinemaRows.json'), JSON.stringify(multiCinemaRows, null, 2));
  }

  const reportsDir = path.join(OUT_DIR, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'clientNameCandidates.json'), JSON.stringify(clientNameCandidateGroups, null, 2));

  const flaggedOut = {};
  let flaggedRowCount = 0;
  for (const [field, map] of Object.entries(flaggedValues)) {
    flaggedOut[field] = [...map.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([value, info]) => ({ value, count: info.count, examples: info.examples }));
    flaggedRowCount += [...map.values()].reduce((sum, v) => sum + v.count, 0);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'flaggedValues.json'), JSON.stringify(flaggedOut, null, 2));

  fs.writeFileSync(path.join(OUT_DIR, 'dataIssues.json'), JSON.stringify(dataIssues, null, 2));

  console.log(`Synced: ${path.join(OUT_DIR, 'bookings.json')} -> ${path.join(publicDataDir, 'bookings.json')} (the path the running app actually fetches)`);
  console.log(`Total records: ${allRecords.length}`);
  console.log(`Manual city fixes applied: ${manualCityOverrideCount} rows (confirmed cinemaLocation lookups) + ${sapnaOverrideCount} Sapna Sangeeta rows -> Indore + ${vimanNagarOverrideCount} Viman Nagar rows -> Pune`);
  console.log(`movieCategory "na"/"NA"/"Na" coerced to null: ${movieCategoryNulledCount} rows`);
  if (cinemaMasterList) {
    console.log(`Cinema master-list resolution: ${cinemaMasterList.length} distinct properties loaded; ${masterListResolvedCount} row(s) resolved to a single city, ${multiConfirmedCount} confirmed genuine multi-city (region="Multi"), ${ambiguousSingleNameCount} left permanently unresolved (single cinema name reused across unrelated cities), ${unmatchedCinemaLocations.size} distinct cinemaLocation value(s) had no confident match`);
  }
  if (year2022RegionFixes) {
    console.log(`Year 2022 manual region corrections applied: ${year2022RegionFixCount} of ${year2022RegionFixes.size} corrected rows (region trusted directly, not re-derived)`);
  }
  console.log(`"North East"/"NE"/"Northeast" region values merged into "North": ${neToNorthCount} rows dataset-wide`);
  if (cinemaMasterList) {
    console.log(`Fresh region-only re-scan (city already had some value, or was left null earlier): ${freshRegionResolvedCount} additional rows resolved`);
  }
  console.log('Records per sheet:');
  for (const sheetName of wb.SheetNames) {
    console.log(`  ${sheetName}: ${recordsPerSheet[sheetName]}`);
  }
  console.log(`Flagged categorical values: ${flaggedRowCount} rows across ${Object.values(flaggedOut).reduce((s, a) => s + a.length, 0)} distinct values`);
  console.log(`  movieIndustry: ${movieIndustryStats.beforeCount} distinct raw values -> ${movieIndustryStats.afterCount} canonical`);
  console.log(`  movieLanguage: ${movieLanguageStats.beforeCount} distinct raw values -> ${movieLanguageStats.afterCount} canonical`);
  console.log(`  city: ${cityStats.beforeCount} distinct raw values -> ${cityStats.afterCount} canonical`);
  console.log(`  clientName: ${clientNameStats.beforeCount} distinct raw values -> ${clientNameStats.afterCount} canonical`);
  console.log(`  corporateName: ${corporateNameStats.beforeCount} distinct raw values -> ${corporateNameStats.afterCount} canonical`);
  console.log(`Client identities (corporateName || clientName): ${clientIdentityCountBefore} -> ${clientIdentityCountAfter} after the ${Object.keys(CLIENT_NAME_CANON).length}-entry confirmed-merge map`);
  console.log(`Client-name candidate audit: ${clientNameCandidateGroups.length} additional near-duplicate group(s) found (not applied) -> data/reports/clientNameCandidates.json`);
  if (nullCityRows.length > 0) {
    console.log(`  city: ${nullCityRows.length} row(s) had a state name (not a city) in the City column — set to null, not guessed; see data/nullCityRows.json`);
  }
  console.log(`Data issues (totalAmount/dateOfScreening): ${dataIssues.length} rows`);
  const regionResolved = regionDerivations.filter((d) => d.derivedRegion != null).length;
  console.log(`Region auto-derived from city/cinemaLocation: ${regionDerivations.length} rows (${regionResolved} resolved, ${regionDerivations.length - regionResolved} left null)`);
  console.log(`Still-unresolved city/region gaps: ${unresolvedCityRows.length} rows -> data/unresolvedCityRows.json`);
  const writtenFiles = [
    path.join(OUT_DIR, 'bookings.json'),
    path.join(OUT_DIR, 'flaggedValues.json'),
    path.join(OUT_DIR, 'dataIssues.json'),
    path.join(OUT_DIR, 'regionDerivations.json'),
    path.join(OUT_DIR, 'nullCityRows.json'),
    path.join(OUT_DIR, 'unresolvedCityRows.json'),
    path.join(reportsDir, 'clientNameCandidates.json'),
  ];
  if (cinemaMasterList) {
    writtenFiles.push(
      path.join(OUT_DIR, 'pvrCinemaMasterList.json'),
      path.join(OUT_DIR, 'masterListResolutions.json'),
      path.join(OUT_DIR, 'multiCinemaRows.json'),
    );
  }
  console.log(`\nWrote:\n  ${writtenFiles.join('\n  ')}`);
}

main();
