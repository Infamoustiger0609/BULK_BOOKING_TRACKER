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
const flaggedValues = { bookingType: new Map(), clientCategory: new Map(), movieIndustry: new Map(), movieLanguage: new Map(), city: new Map() };
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
    const lower = raw == null ? null : raw.toLowerCase();
    let finalRegion;

    if (lower && CANONICAL_REGION_MAP[lower]) {
      finalRegion = CANONICAL_REGION_MAP[lower];
    } else if (lower === 'ne') {
      finalRegion = 'North East';
    } else if (lower === 'multi') {
      finalRegion = 'Multi';
    } else if (lower === 'sount') {
      finalRegion = 'South';
    } else {
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

  for (const rec of allRecords) delete rec._excelRow;

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
};

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

  const movieIndustryStats = normalizeCategoricalField(allRecords, 'movieIndustry', MOVIE_INDUSTRY_CANON, 'movieIndustry');
  const movieLanguageStats = normalizeCategoricalField(allRecords, 'movieLanguage', MOVIE_LANGUAGE_CANON, 'movieLanguage');
  // CITY_CANON only covers the handful of confirmed genuine typos manually
  // reviewed from flaggedValues.json — hundreds of other distinct raw values
  // across dozens of cinema circuits is far too many to hand-verify like the
  // ~20 movie industries/languages, so everything else still just gets the
  // automatic casing merge + flag-if-uncertain treatment.
  const cityStats = normalizeCategoricalField(allRecords, 'city', CITY_CANON, 'city');

  const regionDerivations = resolveRegions(allRecords);

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
  console.log('Records per sheet:');
  for (const sheetName of wb.SheetNames) {
    console.log(`  ${sheetName}: ${recordsPerSheet[sheetName]}`);
  }
  console.log(`Flagged categorical values: ${flaggedRowCount} rows across ${Object.values(flaggedOut).reduce((s, a) => s + a.length, 0)} distinct values`);
  console.log(`  movieIndustry: ${movieIndustryStats.beforeCount} distinct raw values -> ${movieIndustryStats.afterCount} canonical`);
  console.log(`  movieLanguage: ${movieLanguageStats.beforeCount} distinct raw values -> ${movieLanguageStats.afterCount} canonical`);
  console.log(`  city: ${cityStats.beforeCount} distinct raw values -> ${cityStats.afterCount} canonical`);
  if (nullCityRows.length > 0) {
    console.log(`  city: ${nullCityRows.length} row(s) had a state name (not a city) in the City column — set to null, not guessed; see data/nullCityRows.json`);
  }
  console.log(`Data issues (totalAmount/dateOfScreening): ${dataIssues.length} rows`);
  const regionResolved = regionDerivations.filter((d) => d.derivedRegion != null).length;
  console.log(`Region auto-derived from city/cinemaLocation: ${regionDerivations.length} rows (${regionResolved} resolved, ${regionDerivations.length - regionResolved} left null)`);
  console.log(`\nWrote:\n  ${path.join(OUT_DIR, 'bookings.json')}\n  ${path.join(OUT_DIR, 'flaggedValues.json')}\n  ${path.join(OUT_DIR, 'dataIssues.json')}\n  ${path.join(OUT_DIR, 'regionDerivations.json')}\n  ${path.join(OUT_DIR, 'nullCityRows.json')}`);
}

main();
