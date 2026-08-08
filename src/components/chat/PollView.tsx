import { BarChart3, Check, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { formatEndsAt, isPollEnded, parsePoll, type PollTally } from "@/lib/polls";
import { cn } from "@/lib/utils";

interface PollViewProps {
  /** The kind-1068 poll event/rumor (only its tags are read). */
  event: { tags: string[][] };
  /** The tallied votes, resolved by the transport (relay query or sealed fold). */
  tally: PollTally;
  /** Whether the current user may vote (membership / write access). */
  canVote: boolean;
  /** Whether a vote publish is in flight (drives the button spinner). */
  isVoting?: boolean;
  /** Cast the current selection. */
  onVote: (optionIds: string[]) => void;
}

/**
 * Presentational NIP-88 poll card: question options as result bars or votable
 * buttons, the user's own choice, and totals. 100% transport-agnostic — the
 * tally and the vote callback are supplied, so the same card renders NIP-29
 * relay polls and Concord sealed polls.
 */
export function PollView({ event, tally, canVote, isVoting, onVote }: PollViewProps) {
  const { user } = useCurrentUser();
  const { options, pollType, endsAt } = useMemo(() => parsePoll(event), [event]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { counts, totalVoters, myVote } = tally;
  const isEnded = isPollEnded(endsAt);
  const hasVoted = !!myVote && myVote.size > 0;
  const showResults = hasVoted || isEnded || !canVote;

  const toggleSelect = (optionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (pollType === "singlechoice") {
        next.clear();
        next.add(optionId);
      } else if (next.has(optionId)) {
        next.delete(optionId);
      } else {
        next.add(optionId);
      }
      return next;
    });
  };

  const submit = () => {
    onVote([...selected]);
    setSelected(new Set());
  };

  return (
    <div className="max-w-md rounded-xl border border-border bg-secondary/20 px-3 py-2.5 my-1.5 space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <BarChart3 className="size-3.5" />
        <span>Poll{pollType === "multiplechoice" ? " · multiple choice" : ""}</span>
        {endsAt !== undefined && (
          <span className="ml-auto">{isEnded ? "Ended" : `Ends ${formatEndsAt(endsAt)}`}</span>
        )}
      </div>

      <div className="space-y-1.5">
        {options.map((option) => {
          const count = counts.get(option.id) ?? 0;
          const pct = totalVoters > 0 ? Math.round((count / totalVoters) * 100) : 0;
          const isMine = myVote?.has(option.id);
          const isSelected = selected.has(option.id);

          if (showResults) {
            return (
              <div key={option.id} className="relative rounded-lg overflow-hidden border border-border/60">
                <div
                  className={cn("absolute inset-y-0 left-0", isMine ? "bg-primary/25" : "bg-secondary/80")}
                  style={{ width: `${pct}%` }}
                />
                <div className="relative flex items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="truncate flex-1">{option.label}</span>
                  {isMine && <Check className="size-3.5 text-primary shrink-0" />}
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">{pct}%</span>
                </div>
              </div>
            );
          }

          return (
            <button
              key={option.id}
              type="button"
              onClick={() => toggleSelect(option.id)}
              className={cn(
                "w-full flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm text-left transition-colors",
                isSelected
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/60 hover:border-foreground/30 hover:bg-secondary/40",
              )}
            >
              <span
                className={cn(
                  "size-3.5 shrink-0 border flex items-center justify-center",
                  pollType === "singlechoice" ? "rounded-full" : "rounded-sm",
                  isSelected ? "border-primary bg-primary" : "border-muted-foreground/50",
                )}
              >
                {isSelected && <Check className="size-2.5 text-primary-foreground" strokeWidth={3} />}
              </span>
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {totalVoters} {totalVoters === 1 ? "vote" : "votes"}
        </span>
        {!showResults && (
          <Button
            size="sm"
            className="h-7 rounded-full px-4 text-xs"
            disabled={selected.size === 0 || isVoting || !user}
            onClick={submit}
          >
            {isVoting ? <Loader2 className="size-3.5 animate-spin" /> : "Vote"}
          </Button>
        )}
      </div>
    </div>
  );
}
