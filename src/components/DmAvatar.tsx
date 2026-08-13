/**
 * The avatar for a DM conversation — one face for a 1:1, a tiled grid inside a
 * single circle for a group.
 *
 * Sized identically either way. A group row is an ordinary conversation row, so
 * its avatar occupies exactly the space one profile picture would; the grid is
 * clipped to the same circle rather than being a cluster of overlapping discs,
 * which is what keeps the list's left edge straight and its rows the same
 * height.
 *
 * Tiling follows the convention every group messenger converged on, because it
 * is the one that reads at 48px: two participants split the circle vertically,
 * three give the first half the circle and stack the other two, four fill a
 * 2×2. Past four nothing is legible at this size, so the last cell becomes a
 * `+N` count covering everyone it displaced — never a face plus a count that
 * disagree about how many people are missing.
 *
 * Each cell resolves its own profile (`DmAvatarCell` calls `useAuthor`), so the
 * number of participants can change between renders without moving a hook.
 */

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { NoteToSelfAvatar } from "@/components/NoteToSelfAvatar";
import { useAuthor } from "@/hooks/useAuthor";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

/** Cells in the grid. The last is a `+N` whenever it can't hold everyone left. */
const GRID_CELLS = 4;

function DmAvatarCell({
  pubkey,
  tile,
  fallbackClassName,
  /** Requests never fetch the picture — see ConversationRow. */
  anonymous,
}: {
  pubkey: string;
  /**
   * A cell of the group grid rather than the whole avatar. Tiles are square
   * and clipped by the grid's own rounding, so they take no avatar shape of
   * their own — a squircle inside a quarter-circle reads as a rendering fault.
   */
  tile?: boolean;
  fallbackClassName?: string;
  anonymous?: boolean;
}) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);
  return (
    <Avatar
      shape={tile ? "circle" : getAvatarShape(metadata)}
      className={cn("size-full", tile && "rounded-none")}
    >
      {!anonymous && <AvatarImage src={metadata?.picture} alt={name} />}
      <AvatarFallback className={cn("bg-primary/20 text-primary", tile && "rounded-none", fallbackClassName)}>
        {name[0]?.toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

export function DmAvatar({
  peers,
  selfPubkey,
  sizePx,
  className,
  anonymous,
}: {
  /** The conversation's participants — see `dmPeersOf`. */
  peers: readonly string[];
  selfPubkey?: string;
  /** The rendered size in px; must match what `className` sets. */
  sizePx: number;
  className?: string;
  /** Suppress remote picture fetches (an unaccepted request). */
  anonymous?: boolean;
}) {
  // The conversation with yourself is Note to Self, not a picture of you.
  if (peers.length === 1 && peers[0] === selfPubkey) {
    return <NoteToSelfAvatar sizePx={sizePx} className={className} />;
  }

  if (peers.length <= 1) {
    const peer = peers[0];
    if (!peer) {
      return <span className={cn("shrink-0 rounded-full bg-muted", className)} aria-hidden />;
    }
    return (
      <div className={cn("shrink-0", className)}>
        <DmAvatarCell
          pubkey={peer}
          anonymous={anonymous}
          fallbackClassName={sizePx >= 40 ? "text-base" : "text-[10px]"}
        />
      </div>
    );
  }

  // Everyone fits, or the last cell counts everyone it stands in for.
  const faces = peers.length > GRID_CELLS ? peers.slice(0, GRID_CELLS - 1) : peers.slice(0, GRID_CELLS);
  const overflow = peers.length - faces.length;
  // Three participants read best as one large face beside two stacked ones;
  // two and four are even splits.
  const three = faces.length + (overflow > 0 ? 1 : 0) === 3;
  // A quarter tile is a quarter of the circle, so its monogram has to shrink
  // with it or it collides with its neighbours.
  const countPx = Math.max(7, Math.round(sizePx * 0.2));

  return (
    <div
      className={cn(
        "grid shrink-0 gap-px overflow-hidden rounded-full bg-background",
        peers.length === 2 ? "grid-cols-2 grid-rows-1" : "grid-cols-2 grid-rows-2",
        className,
      )}
    >
      {faces.map((peer, i) => (
        <div key={peer} className={cn("overflow-hidden", three && i === 0 && "row-span-2")}>
          <DmAvatarCell
            pubkey={peer}
            tile
            anonymous={anonymous}
            fallbackClassName={sizePx >= 40 ? "text-[10px]" : "text-[7px]"}
          />
        </div>
      ))}
      {overflow > 0 && (
        <div className="overflow-hidden">
          <span
            className="flex size-full items-center justify-center bg-primary/20 font-medium leading-none text-primary"
            style={{ fontSize: `${countPx}px` }}
          >
            +{overflow}
          </span>
        </div>
      )}
    </div>
  );
}
