// Formatting helpers shared by every KPI card, table, and chart label so
// numbers read consistently across the whole dashboard.

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const inrCompactFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1,
});

const numberFormatter = new Intl.NumberFormat('en-IN');

export function formatCurrency(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return inrFormatter.format(value);
}

export function formatCurrencyCompact(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return inrCompactFormatter.format(value);
}

export function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return numberFormatter.format(Math.round(value));
}

export function formatPercent(fraction, decimals = 0) {
  if (fraction == null || Number.isNaN(fraction)) return '—';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

export function formatDate(dateOrString) {
  if (!dateOrString) return '—';
  const d = dateOrString instanceof Date ? dateOrString : new Date(dateOrString);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatMonthYear(dateOrString) {
  if (!dateOrString) return '—';
  const d = dateOrString instanceof Date ? dateOrString : new Date(dateOrString);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', timeZone: 'UTC' });
}
