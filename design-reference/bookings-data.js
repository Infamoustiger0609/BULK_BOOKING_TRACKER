// Synthetic bulk-booking dataset + pure calc/format helpers for the dashboard DC.
// ~320 records, Apr 2022 – Aug 2026, matching the brief's schema.

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const rnd = seededRandom(42);
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
function weightedPick(pairs) {
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { if (r < w) return v; r -= w; }
  return pairs[0][0];
}
function randInt(min, max) { return Math.floor(rnd() * (max - min + 1)) + min; }

const REGIONS = {
  North: ['Delhi NCR', 'Chandigarh', 'Lucknow', 'Jaipur'],
  West: ['Mumbai', 'Pune', 'Ahmedabad', 'Surat'],
  South: ['Bengaluru', 'Chennai', 'Hyderabad', 'Kochi'],
  East: ['Kolkata', 'Patna', 'Bhubaneswar', 'Guwahati'],
};
const REGION_LIST = Object.keys(REGIONS);

const CATEGORIES = ['Corporate', 'Agency', 'Distributor', 'Bank', 'School', 'Individual'];
const BOOKING_TYPES = ['Bulk', 'Private Screening', 'Corporate Event', 'School Show'];
const INDUSTRIES = ['Hollywood', 'Bollywood', 'Regional', 'South Indian'];
const LANGUAGES = { Hollywood: ['English'], Bollywood: ['Hindi'], 'South Indian': ['Tamil', 'Telugu', 'Malayalam', 'Kannada'], Regional: ['Punjabi', 'Bengali', 'Marathi'] };
const CATEGORY_GENRE = ['Action', 'Drama', 'Animation', 'Comedy', 'Thriller', 'Family'];
const MOVIES = {
  Hollywood: ['Stellar Horizon', 'Ironclad Reign', 'Deep Current', 'Nova Strike', 'Silent Vault'],
  Bollywood: ['Rangrezz', 'Dilkash', 'Shaan-e-Hind', 'Aatma Nirbhar', 'Josh Ke Rang'],
  Regional: ['Maati Ke Rang', 'Kolkata Chronicles', 'Punjab Diaries', 'Ghar Wapasi'],
  'South Indian': ['Veera Simham', 'Kadal Kadhai', 'Nadaga Naal', 'Malabar Storm'],
};

const CLIENT_PROFILES = [];
const NAME_PREFIX = ['Apex', 'Zenith', 'Orbit', 'Nimbus', 'Vertex', 'Solstice', 'Meridian', 'Granite', 'Harbor', 'Cascade', 'Lumen', 'Anchor', 'Beacon', 'Crestline', 'Everline', 'Falcon', 'Glide', 'Highland', 'Ironwood', 'Juniper', 'Keystone', 'Lattice', 'Magpie', 'Northgate', 'Outrider', 'Pinecrest', 'Quartz', 'Riverton', 'Summit', 'Trailmark', 'Union', 'Vantage', 'Westfield', 'Yardley', 'Zephyr', 'Bluepeak', 'Coral', 'Delta', 'Echo', 'Fernwood'];
const NAME_PREFIX2 = ['Ridge', 'Star', 'Bay', 'Field', 'Grove', 'Point', 'Spring', 'Hill', 'Stone', 'Brook', 'Vale', 'Wood', 'Shore', 'Peak', 'Well', 'Gate', 'Reach', 'Cross', 'Fort', 'Mill', 'Park', 'Bridge', 'Path', 'Rock', 'Sand', 'Moor', 'Glen', 'Dale', 'Crest', 'Bend'];
const NAME_SUFFIX = { Corporate: ['Industries', 'Solutions', 'Enterprises', 'Group', 'Holdings'], Agency: ['Events & Co', 'Experiences', 'Live', 'Creative Agency'], Distributor: ['Distribution', 'Media Partners', 'Films'], Bank: ['Bank Ltd', 'Financial Services', 'Capital'], School: ['International School', 'Public School', 'Academy'], Individual: ['(Individual Client)', ''] };

for (let i = 0; i < 70; i++) {
  const category = weightedPick([['Corporate', 30], ['Agency', 18], ['Distributor', 10], ['Bank', 12], ['School', 16], ['Individual', 14]]);
  const region = pick(REGION_LIST);
  const city = pick(REGIONS[region]);
  const industryAffinity = weightedPick([['Hollywood', 25], ['Bollywood', 35], ['Regional', 15], ['South Indian', 25]]);
  const loyalty = rnd(); // how concentrated their bookings are on industryAffinity
  const prefix = i < NAME_PREFIX.length ? NAME_PREFIX[i] : `${NAME_PREFIX[i % NAME_PREFIX.length]}${NAME_PREFIX2[i % NAME_PREFIX2.length]}`;
  const suffixes = NAME_SUFFIX[category];
  const name = `${prefix} ${pick(suffixes)}`.trim();
  const startMonthIndex = randInt(0, 40); // months since Apr 2022
  const active = rnd() > 0.22; // ~22% become dormant (no bookings in last 6mo)
  CLIENT_PROFILES.push({ key: `c${i}`, name, category, region, city, industryAffinity, loyalty, startMonthIndex, active, tier: weightedPick([['whale', 8], ['mid', 32], ['small', 60]]) });
}

const DATASET_START = new Date(Date.UTC(2022, 3, 1)); // Apr 2022
const DATASET_END = new Date(Date.UTC(2026, 7, 31)); // Aug 2026
const TOTAL_MONTHS = 53; // Apr2022..Aug2026 inclusive

function fyForDate(d) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const endYear = m >= 4 ? y + 1 : y;
  return `FY${String(endYear).slice(-2)}`;
}

const records = [];
let recId = 0;
for (const client of CLIENT_PROFILES) {
  const bookingCountTarget = client.tier === 'whale' ? randInt(18, 34) : client.tier === 'mid' ? randInt(8, 17) : randInt(1, 7);
  const lastActiveMonth = client.active ? TOTAL_MONTHS - randInt(0, 2) : TOTAL_MONTHS - randInt(7, 22);
  const span = Math.max(1, Math.min(lastActiveMonth, TOTAL_MONTHS - 1) - client.startMonthIndex);
  for (let b = 0; b < bookingCountTarget; b++) {
    const monthOffset = client.startMonthIndex + Math.floor(rnd() * Math.max(span, 1));
    const clamped = Math.min(monthOffset, lastActiveMonth, TOTAL_MONTHS - 1);
    const date = new Date(DATASET_START);
    date.setUTCMonth(date.getUTCMonth() + clamped);
    date.setUTCDate(randInt(1, 27));

    const industry = rnd() < client.loyalty ? client.industryAffinity : pick(INDUSTRIES);
    const language = pick(LANGUAGES[industry]);
    const category = pick(CATEGORY_GENRE);
    const movie = pick(MOVIES[industry]);
    const bookingType = client.category === 'School' ? 'School Show' : weightedPick([['Bulk', 50], ['Private Screening', 30], ['Corporate Event', 20]]);
    const tickets = client.tier === 'whale' ? randInt(80, 400) : client.tier === 'mid' ? randInt(30, 120) : randInt(10, 60);
    const ticketPrice = randInt(180, 420);
    const totalAmount = tickets * ticketPrice;

    records.push({
      id: recId++,
      clientKey: client.key,
      clientName: client.name,
      clientType: b === 0 ? 'New' : 'Existing',
      clientCategory: client.category,
      region: client.region,
      city: client.city,
      movieIndustry: industry,
      movieLanguage: language,
      movieCategory: category,
      movieName: movie,
      cinemaLocation: `PVR INOX ${client.city}`,
      bookingType,
      tickets,
      totalAmount,
      dateOfScreening: date.toISOString().slice(0, 10),
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      fy: fyForDate(date),
    });
  }
}
records.sort((a, b) => new Date(a.dateOfScreening) - new Date(b.dateOfScreening));
const REFERENCE_DATE = new Date(records[records.length - 1].dateOfScreening);

// ---------- format helpers ----------
export function formatCurrency(v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}
export function formatCurrencyCompact(v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (Math.abs(v) >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${Math.round(v)}`;
}
export function formatNumber(v) { return v == null || Number.isNaN(v) ? '—' : Math.round(v).toLocaleString('en-IN'); }
export function formatPercent(v, digits = 0) { return v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(digits)}%`; }
export function formatDate(d) {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function formatMonthYear(d) {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

// ---------- data access ----------
export function getRecords() { return records; }
export function getReferenceDate() { return REFERENCE_DATE; }
export function getFilterOptions(recs, field) {
  const set = new Set(recs.map((r) => r[field]).filter(Boolean));
  return [...set].sort().map((v) => ({ value: v, label: v }));
}
export function getFyOptions() {
  const set = new Set(records.map((r) => r.fy));
  return [...set].sort();
}
export function getMonthOptions(recs) {
  const set = new Map();
  for (const r of recs) {
    const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
    if (!set.has(key)) set.set(key, { value: key, label: formatMonthYear(new Date(Date.UTC(r.year, r.month - 1, 1))) });
  }
  return [...set.values()].sort((a, b) => a.value.localeCompare(b.value));
}

export function applyFilters(recs, { fy = [], month = [], region = [], clientType = [], clientCategory = [] }) {
  return recs.filter((r) => {
    if (fy.length && !fy.includes(r.fy)) return false;
    if (month.length) {
      const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
      if (!month.includes(key)) return false;
    }
    if (region.length && !region.includes(r.region)) return false;
    if (clientType.length && !clientType.includes(r.clientType)) return false;
    if (clientCategory.length && !clientCategory.includes(r.clientCategory)) return false;
    return true;
  });
}

export function aggregateMetrics(recs) {
  const totalRevenue = recs.reduce((s, r) => s + r.totalAmount, 0);
  const totalTickets = recs.reduce((s, r) => s + r.tickets, 0);
  const clientCount = new Set(recs.map((r) => r.clientKey)).size;
  const sph = totalTickets > 0 ? totalRevenue / totalTickets : null;
  const atv = recs.length > 0 ? totalRevenue / recs.length : null;
  return { totalRevenue, totalTickets, clientCount, sph, atv, bookingCount: recs.length };
}

export function computeDelta(current, prior) {
  if (prior == null || prior === 0 || current == null) return null;
  return (current - prior) / prior;
}

export function computeTimeSeries(recs, granularity) {
  const buckets = new Map();
  for (const r of recs) {
    const key = granularity === 'fy' ? r.fy : `${r.year}-${String(r.month).padStart(2, '0')}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, items]) => {
    const m = aggregateMetrics(items);
    const label = granularity === 'fy' ? key : formatMonthYear(new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, 1)));
    return { key, label, ...m };
  });
}

export function computeRevenueByField(recs, field, topN) {
  const map = new Map();
  for (const r of recs) map.set(r[field], (map.get(r[field]) || 0) + r.totalAmount);
  const arr = [...map.entries()].map(([value, revenue]) => ({ value, revenue })).sort((a, b) => b.revenue - a.revenue);
  return topN ? arr.slice(0, topN) : arr;
}

export function buildClientIndex(recs) {
  const map = new Map();
  for (const r of recs) {
    if (!map.has(r.clientKey)) map.set(r.clientKey, { key: r.clientKey, displayName: r.clientName, clientCategory: r.clientCategory, region: r.region, records: [] });
    map.get(r.clientKey).records.push(r);
  }
  const list = [...map.values()].map((c) => {
    const m = aggregateMetrics(c.records);
    const hasNew = c.records.some((r) => r.clientType === 'New');
    const lastBookingDate = c.records.reduce((max, r) => (r.dateOfScreening > max ? r.dateOfScreening : max), c.records[0].dateOfScreening);
    return { ...c, totalRevenue: m.totalRevenue, totalTickets: m.totalTickets, bookingCount: m.bookingCount, avgTicketPrice: m.atv, clientType: hasNew ? 'New' : 'Existing', lastBookingDate };
  });
  const totalRevenue = list.reduce((s, c) => s + c.totalRevenue, 0);
  const totalTickets = list.reduce((s, c) => s + c.totalTickets, 0);
  const byKey = new Map(list.map((c) => [c.key, c]));
  return { list, byKey, totalRevenue, totalTickets };
}

export function computeClientAffinities(clientList, { minBookings = 3, threshold = 0.65, dimensions = ['movieIndustry', 'movieLanguage', 'movieCategory'] } = {}) {
  const out = [];
  for (const c of clientList) {
    if (c.bookingCount < minBookings) continue;
    for (const dim of dimensions) {
      const counts = new Map();
      for (const r of c.records) counts.set(r[dim], (counts.get(r[dim]) || 0) + 1);
      let top = null, topCount = 0;
      for (const [v, cnt] of counts) if (cnt > topCount) { top = v; topCount = cnt; }
      const pct = topCount / c.records.length;
      if (top && pct >= threshold) {
        out.push({ clientKey: c.key, displayName: c.displayName, clientCategory: c.clientCategory, dimension: dim, value: top, matchCount: topCount, pct, totalRevenue: c.totalRevenue, bookingCount: c.bookingCount });
      }
    }
  }
  return out;
}

export function computeDormantClients(clientList, referenceDate, { monthsThreshold = 6, minBookings = 2 } = {}) {
  const out = [];
  for (const c of clientList) {
    if (c.bookingCount < minBookings) continue;
    const last = new Date(c.lastBookingDate);
    const monthsSince = (referenceDate.getFullYear() - last.getFullYear()) * 12 + (referenceDate.getMonth() - last.getMonth());
    if (monthsSince >= monthsThreshold) out.push({ ...c, monthsSince });
  }
  return out.sort((a, b) => b.totalRevenue - a.totalRevenue);
}

export function computeDistribution(recs, field) {
  const map = new Map();
  for (const r of recs) map.set(r[field], (map.get(r[field]) || 0) + 1);
  const total = recs.length;
  const items = [...map.entries()].map(([value, count]) => ({ value, count, pct: total ? count / total : 0 })).sort((a, b) => b.count - a.count);
  return { items, total };
}

export function computeMonthlyTrend(recs) {
  const buckets = new Map();
  for (const r of recs) {
    const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
    if (!buckets.has(key)) buckets.set(key, { revenue: 0, bookingCount: 0 });
    buckets.get(key).revenue += r.totalAmount;
    buckets.get(key).bookingCount += 1;
  }
  return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, v]) => ({ key, label: formatMonthYear(new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, 1))), ...v }));
}

export function toCsv(rows, columns) {
  const header = columns.map((c) => c.label).join(',');
  const lines = rows.map((r) => columns.map((c) => {
    const v = typeof c.value === 'function' ? c.value(r) : r[c.value];
    const s = v == null ? '' : String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(','));
  return [header, ...lines].join('\n');
}
export function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
