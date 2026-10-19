import { BarChart3, Check, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { formatEndsAt, isPollEnded, parsePoll, type PollTally } from "@/lib/polls";
import { cn } from "@/lib/utils";
import { FormattedMessage, useIntl } from "@/i18n";

interface PollViewProps {
  /** Only its tags are read. */
  event: { tags: string[][] };
  tally: PollTally;
  canVote: boolean;
  isVoting?: boolean;
  onVote: (optionIds: string[]) => void;
}

/** Transport-agnostic NIP-88 poll card (NIP-29 relay polls and Concord sealed polls). */
export function PollView({ event, tally, canVote, isVoting, onVote }: PollViewProps) {
  const intl = useIntl();
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
    <div className="max-w-md clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.2] [--fill-hover:var(--secondary)/0.2] px-3 py-2.5 my-1.5 space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <BarChart3 className="size-3.5" />
        <span>
          {pollType === "multiplechoice"
            ? <FormattedMessage id="pollView.pollMultiple" defaultMessage="Poll · multiple choice" />
            : <FormattedMessage id="pollView.poll" defaultMessage="Poll" />}
        </span>
        {endsAt !== undefined && (
          <span className="ml-auto">{isEnded
              ? intl.formatMessage({ id: "pollView.ended", defaultMessage: "Ended" })
              : intl.formatMessage({ id: "pollView.ends", defaultMessage: "Ends {when}" }, { when: formatEndsAt(endsAt) })}</span>
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
              <div key={option.id} className="relative clip-corner overflow-hidden bg-secondary/30">
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
                "w-full flex items-center gap-2 clip-corner px-3 py-1.5 touch:py-3 text-sm text-left transition-colors",
                isSelected
                  ? "bg-primary/10 text-primary"
                  : "bg-secondary hover:bg-secondary/70",
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
          <FormattedMessage
            id="pollView.votes"
            defaultMessage="{count, plural, one {# vote} other {# votes}}"
            values={{ count: totalVoters }}
          />
        </span>
        {!showResults && (
          <Button
            size="sm"
            className="h-7 touch:h-11 clip-corner-lg px-4 text-xs"
            disabled={selected.size === 0 || isVoting || !user}
            onClick={submit}
          >
            {isVoting ? <Loader2 className="size-3.5 animate-spin" /> : intl.formatMessage({ id: "pollView.vote", defaultMessage: "Vote" })}
          </Button>
        )}
      </div>
    </div>
  );
}
