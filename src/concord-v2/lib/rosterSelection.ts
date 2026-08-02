/**
 * Multi-select for the Members tab — pure reducer, Gmail model.
 *
 * The anchor is a PUBKEY, not an index, so a re-sort re-ranges from the same
 * member rather than from whichever row now sits at the old index. A plain
 * click toggles the row and re-anchors there; a Shift-click applies the
 * anchor's CURRENT state (i.e. the state its own click produced) across the
 * whole visual range, and keeps the anchor so repeated Shift-clicks re-range
 * from the same origin.
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

/**
 * Drop selected rows that are no longer visible — a member who left or was
 * removed mid-view must not ride invisibly into the next mass action.
 */
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
