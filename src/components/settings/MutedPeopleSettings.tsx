import { Loader2, UserCheck } from "lucide-react";
import { useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useMutedPubkeys, useUnmuteUser } from "@/hooks/useMuteList";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { tryNpubEncode } from "@/lib/safeNip19";

function MutedRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, pubkey);
  const npub = tryNpubEncode(pubkey);
  const shortNpub = npub ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : pubkey.slice(0, 16);
  const unmute = useUnmuteUser();
  const [busy, setBusy] = useState(false);

  const onUnmute = async () => {
    setBusy(true);
    try {
      await unmute.mutateAsync(pubkey);
      toast({ title: "Unblocked", description: `You'll see ${displayName} again.` });
    } catch (e) {
      toast({
        title: "Couldn't unblock",
        description: e instanceof Error ? e.message : "Failed to update your block list.",
        variant: "destructive",
      });
      setBusy(false);
    }
    // On success the row unmounts, so `busy` is never cleared.
  };

  return (
    <SettingsRow className="flex items-center gap-3">
      <Avatar shape={getAvatarShape(metadata)} className="size-8 shrink-0">
        <AvatarImage src={metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-xs">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight">{displayName}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">{shortNpub}</div>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="clip-corner-lg h-8 shrink-0"
        disabled={busy}
        onClick={onUnmute}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <UserCheck className="size-3.5" />}
        Unblock
      </Button>
    </SettingsRow>
  );
}

/**
 * The only place to review mutes: muting is quiet everywhere else, so a
 * misclick would otherwise be invisible and permanent. Shows both NIP-44
 * private and public kind-10000 entries.
 */
export function MutedPeopleSettings() {
  const { mutedPubkeys, ready } = useMutedPubkeys();
  const pubkeys = [...mutedPubkeys].sort();

  if (!ready) {
    return (
      <SettingsRow>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading your block list…
        </div>
      </SettingsRow>
    );
  }

  if (pubkeys.length === 0) {
    return (
      <SettingsRow>
        <p className="text-sm text-muted-foreground">
          You haven't blocked anyone. Blocking someone hides their messages,
          reactions, notifications and profile everywhere in Armada. It is
          private to you, and they are never told.
        </p>
      </SettingsRow>
    );
  }

  return (
    <>
      {pubkeys.map((pubkey) => (
        <MutedRow key={pubkey} pubkey={pubkey} />
      ))}
    </>
  );
}
