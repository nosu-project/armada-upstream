/**
 * Members-tab multi-select (pure reducer, Gmail model). The anchor is a PUBKEY
 * so re-sorts keep it. Click toggles and re-anchors; Shift-click applies the
 * anchor's current state across the range and keeps the anchor.
 */

export interface SelectionState {
  selected: ReadonlySet<string>;
  anchor?: string;
}

export function emptySelection(): SelectionState {
  return { selected: new Set() };
}

export function clickRow(
  state: SelectionState,
  ordered: readonly string[],
  pubkey: string,
  shiftKey: boolean,
): SelectionState {
  const anchorIndex = state.anchor === undefined ? -1 : ordered.indexOf(state.anchor);
  const clickedIndex = ordered.indexOf(pubkey);
  if (clickedIndex === -1) return state;

  // Shift with no usable anchor degrades to a plain click.
  if (!shiftKey || anchorIndex === -1) {
    const selected = new Set(state.selected);
    if (selected.has(pubkey)) selected.delete(pubkey);
    else selected.add(pubkey);
    return { selected, anchor: pubkey };
  }

  const apply = state.selected.has(state.anchor as string);
  const [lo, hi] = anchorIndex <= clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
  const selected = new Set(state.selected);
  for (let i = lo; i <= hi; i++) {
    if (apply) selected.add(ordered[i]);
    else selected.delete(ordered[i]);
  }
  return { selected, anchor: state.anchor };
}

/** Drop selected rows no longer visible, so they don't ride into the next mass action. */
export function pruneSelection(state: SelectionState, visible: ReadonlySet<string>): SelectionState {
  let changed = false;
  const selected = new Set<string>();
  for (const pk of state.selected) {
    if (visible.has(pk)) selected.add(pk);
    else changed = true;
  }
  const anchor = state.anchor !== undefined && visible.has(state.anchor) ? state.anchor : undefined;
  if (!changed && anchor === state.anchor) return state;
  return { selected, anchor };
}
