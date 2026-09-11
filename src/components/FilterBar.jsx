import { useEffect, useRef, useState } from 'react';
import { clearFilterSelection, selectAllFilterValues, toggleFilterValue } from '../lib/filterState.js';
import { useDropdownPanel } from '../lib/useDropdownPanel.js';

/**
 * A row of multi-select dropdown filters. Each filter is:
 *   { key, label, options: [{value,label}], selected: string[], onChange(next),
 *     disabledReason?: string }
 *
 * Standard checkbox semantics: `selected` is the literal set of ticked
 * values, full stop. A box is checked iff `selected.includes(option.value)`
 * — nothing else feeds that computation, so the checkbox UI and the filter
 * state driving the numbers can never drift apart. `[]` means nothing is
 * ticked, which means nothing matches (callers must default `selected` to
 * every option's value up front if they want the initial view unfiltered —
 * this component never invents that state on its own).
 */
export default function FilterBar({ filters, className = '' }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {filters.map((filter) => (
        <FilterDropdown key={filter.key} filter={filter} />
      ))}
    </div>
  );
}

function FilterDropdown({ filter }) {
  const { label, options, selected, onChange, disabledReason } = filter;
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selectAllRef = useRef(null);
  const disabled = Boolean(disabledReason);
  const { rendered, dataState } = useDropdownPanel(open && !disabled);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const allChecked = options.length > 0 && selected.length === options.length;
  const noneChecked = selected.length === 0;

  // Master checkbox's indeterminate visual (neither fully on nor fully off)
  // has no HTML attribute — it can only be set imperatively on the DOM node.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = !allChecked && !noneChecked;
  }, [allChecked, noneChecked]);

  const summary = allChecked
    ? 'All'
    : noneChecked
      ? 'None'
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  return (
    <div className="relative" ref={ref} title={disabled ? disabledReason : undefined}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`interactive flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium ${
          disabled
            ? 'cursor-not-allowed border-ink/10 bg-ink/5 text-ink-soft/50'
            : open
              ? 'border-highlight bg-highlight-soft text-ink shadow-sm'
              : 'border-ink/15 bg-white/70 text-ink hover:border-ink/30 hover:shadow-sm'
        }`}
      >
        <span className="font-semibold uppercase tracking-widest text-ink-soft">{label}</span>
        <span className="font-semibold">{summary}</span>
        <span className="text-ink-soft">▾</span>
      </button>

      {rendered && (
        <div className="card dropdown-panel absolute left-0 top-full z-20 mt-1 max-h-64 w-56 overflow-y-auto py-1" data-state={dataState}>
          <label className="interactive mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-[11px] font-semibold text-teal hover:bg-teal-soft">
            <input
              ref={selectAllRef}
              type="checkbox"
              className="accent-teal focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight"
              checked={allChecked}
              onChange={() => onChange(allChecked ? clearFilterSelection() : selectAllFilterValues(options))}
            />
            <span>Select all</span>
          </label>
          <div className="my-1 border-t border-ink/10" />
          <ul className="flex flex-col gap-0.5 pb-1">
            {options.map((option) => {
              const checked = selected.includes(option.value);
              return (
                <li key={option.value}>
                  <label className="interactive mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-[11px] text-ink hover:bg-cream-2">
                    <input
                      type="checkbox"
                      className="accent-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight"
                      checked={checked}
                      onChange={() => onChange(toggleFilterValue(selected, option.value))}
                    />
                    <span>{option.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
