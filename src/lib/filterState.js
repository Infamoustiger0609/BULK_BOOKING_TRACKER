// Pure state-transition helpers for FilterBar's multi-select checkboxes,
// kept separate from the component (which owns only open/closed UI state)
// so this logic can be unit-tested head-on, without a browser — see
// verify-filters.js.
//
// Standard checkbox semantics: `selected` is always the literal set of
// ticked values. Toggling one box adds/removes just that value — no
// collapsing, no implicit "everything" state. `[]` genuinely means nothing
// is ticked (matches nothing); the "everything" state is the explicit array
// of every option (see dataUtils.allFilterValues), which callers must set as
// the initial state themselves — this module has no default to fall back on.

/** Toggles one checkbox: adds `value` if it isn't selected, removes it if it is. */
export function toggleFilterValue(selected, value) {
  return selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
}

/** Ticks every option. */
export function selectAllFilterValues(options) {
  return options.map((o) => o.value);
}

/** Unticks every option. */
export function clearFilterSelection() {
  return [];
}
