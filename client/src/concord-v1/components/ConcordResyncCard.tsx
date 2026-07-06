import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, PackageOpen, RefreshCw, RotateCcw, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  useApplyConcordResync,
  useScanConcordList,
  type ConcordScanItem,
  type ConcordScanResult,
} from "@/concord-v1/hooks/useConcordList";
import { toast } from "@/hooks/useToast";

/** Human label + icon for where a recovered community was found. */
function SourceTag(_props: { item: ConcordScanItem }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <PackageOpen className="size-3" /> from an older list
    </span>
  );
}

/** One row in the review list: checkbox (when actionable) + name + status. */
function ScanRow({
  item,
  checked,
  onToggle,
}: {
  item: ConcordScanItem;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  const selectable = item.status !== "current";
  return (
    <label
      className={`flex items-start gap-3 rounded-md bg-background/40 px-3 py-2.5 ${
        selectable ? "cursor-pointer hover:bg-background/70" : "opacity-70"
      }`}
    >
      {selectable ? (
        <Checkbox checked={checked} onCheckedChange={(v) => onToggle(v === true)} className="mt-0.5" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-[18px] shrink-0 text-success" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{item.name}</span>
          {item.status === "current" && (
            <Badge variant="secondary" className="shrink-0">
              In your list
            </Badge>
          )}
          {item.status === "recovered" && (
            <Badge variant="default" className="shrink-0">
              Lost
            </Badge>
          )}
          {item.status === "left" && (
            <Badge variant="outline" className="shrink-0">
              You left this
            </Badge>
          )}
        </div>
        {item.status !== "current" && <SourceTag item={item} />}
        {item.status === "left" && (
          <p className="text-xs text-muted-foreground">
            You previously left or declined this. Restoring overrides that.
          </p>
        )}
      </div>
    </label>
  );
}

/**
 * Advanced recovery flow for Concord communities lost to a bad kind-30078
 * overwrite. Instead of a blind "republish my list" button, this:
 *
 *   1. SCANS read-only across every key-bearing source (local cache and all
 *      relay copies of the list) — publishing nothing;
 *   2. SHOWS the user exactly what was found, classified as already-in-your-list,
 *      lost (recoverable), or deliberately-left, with provenance;
 *   3. lets the user CHOOSE what to restore and only then republishes the list.
 */
export function ConcordResyncCard() {
  const { mutateAsync: scan, isPending: scanning } = useScanConcordList();
  const { mutateAsync: apply, isPending: applying } = useApplyConcordResync();

  const [result, setResult] = useState<ConcordScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const recoverable = useMemo(
    () => result?.items.filter((i) => i.status === "recovered") ?? [],
    [result],
  );
  const left = useMemo(() => result?.items.filter((i) => i.status === "left") ?? [], [result]);
  const current = useMemo(() => result?.items.filter((i) => i.status === "current") ?? [], [result]);

  const toggle = (id: string, next: boolean) => {
    setSelected((prev) => {
      const set = new Set(prev);
      if (next) set.add(id);
      else set.delete(id);
      return set;
    });
  };

  const onScan = async () => {
    try {
      const res = await scan();
      setResult(res);
      // Pre-check the clearly-lost rooms (safe to restore); leave "left" ones
      // unchecked so resurrecting a deliberate leave is a conscious choice.
      setSelected(new Set(res.items.filter((i) => i.status === "recovered").map((i) => i.communityId)));
    } catch (err) {
      toast({
        title: "Scan failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const onRestore = async () => {
    if (!result) return;
    const chosen = result.items.filter((i) => selected.has(i.communityId)).map((i) => i.entry);
    if (chosen.length === 0) return;
    try {
      const { restored } = await apply({ baseList: result.baseList, chosen });
      toast({
        title: restored > 0 ? `Restored ${restored} ${restored === 1 ? "community" : "communities"}` : "Up to date",
        description:
          restored > 0
            ? "They're back in your list and synced to your relays."
            : "Nothing needed restoring.",
      });
      setResult(null);
      setSelected(new Set());
    } catch (err) {
      toast({
        title: "Restore failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  // ── Initial state: explain + scan ──────────────────────────────────────────
  if (!result) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground leading-snug">
          Scans your cache and relays for rooms dropped from
          your list. Nothing changes until you choose what to restore.
        </p>
        <Button variant="outline" size="sm" className="clip-corner-lg" onClick={onScan} disabled={scanning}>
          {scanning ? (
            <>
              <Loader2 className="size-4 mr-2 animate-spin" /> Scanning…
            </>
          ) : (
            <>
              <Search className="size-4 mr-2" /> Scan for lost rooms
            </>
          )}
        </Button>
      </div>
    );
  }

  // ── Review state: visualize findings + choose ────────────────────────────────
  const selectedCount = selected.size;
  const nothingLost = recoverable.length === 0 && left.length === 0;

  return (
    <div className="space-y-4">
      {/* Summary counts */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="default" className="gap-1">
          {recoverable.length} lost
        </Badge>
        {left.length > 0 && (
          <Badge variant="outline" className="gap-1">
            {left.length} left
          </Badge>
        )}
        <Badge variant="secondary" className="gap-1">
          {current.length} already in your list
        </Badge>
      </div>

      {nothingLost ? (
        <p className="text-sm text-muted-foreground">
          Good news — nothing's missing. All {current.length}{" "}
          {current.length === 1 ? "community is" : "communities are"} already in your list.
        </p>
      ) : (
        <div className="max-h-72 overflow-y-auto overscroll-contain rounded-md bg-background/40 p-1">
          <div className="space-y-1.5 p-1">
            {recoverable.length > 0 && (
              <>
                <p className="px-1 pt-1 text-xs font-semibold text-muted-foreground">
                  Lost — recommended to restore
                </p>
                {recoverable.map((item) => (
                  <ScanRow
                    key={item.communityId}
                    item={item}
                    checked={selected.has(item.communityId)}
                    onToggle={(v) => toggle(item.communityId, v)}
                  />
                ))}
              </>
            )}
            {left.length > 0 && (
              <>
                <Separator className="my-2" />
                <p className="px-1 text-xs font-semibold text-muted-foreground">
                  Previously left — restore only if you want them back
                </p>
                {left.map((item) => (
                  <ScanRow
                    key={item.communityId}
                    item={item}
                    checked={selected.has(item.communityId)}
                    onToggle={(v) => toggle(item.communityId, v)}
                  />
                ))}
              </>
            )}
            {current.length > 0 && (
              <>
                <Separator className="my-2" />
                <p className="px-1 text-xs font-semibold text-muted-foreground">
                  Already in your list
                </p>
                {current.map((item) => (
                  <ScanRow key={item.communityId} item={item} checked onToggle={() => {}} />
                ))}
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!nothingLost && (
          <Button size="sm" className="clip-corner-lg" onClick={onRestore} disabled={applying || selectedCount === 0}>
            {applying ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" /> Restoring…
              </>
            ) : (
              <>
                <RotateCcw className="size-4 mr-2" />
                Restore {selectedCount > 0 ? selectedCount : ""}{" "}
                {selectedCount === 1 ? "community" : "communities"}
              </>
            )}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onScan} disabled={scanning || applying}>
          {scanning ? <Loader2 className="size-4 mr-2 animate-spin" /> : <RefreshCw className="size-4 mr-2" />}
          Rescan
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setResult(null);
            setSelected(new Set());
          }}
          disabled={applying}
        >
          Done
        </Button>
      </div>
    </div>
  );
}
