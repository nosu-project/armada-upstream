import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCommunityList } from "@/concord/hooks/useCommunityList";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * Why the rail is empty when the NIP-44 membership list can't be decrypted by
 * the signer: otherwise it reads as an account that never joined anything.
 */
export function CommunityListLocked() {
  const { user } = useCurrentUser();
  const list = useCommunityList();
  const canDecrypt = Boolean(user?.signer?.nip44);
  // Without NIP-44 the list query never runs; a local plaintext copy still shows.
  const locked = user !== undefined && (canDecrypt
    ? list.data?.decryptFailed === true
    : list.data === undefined);
  if (!locked) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          aria-label="Your communities couldn't be decrypted"
          className="size-12 shrink-0 clip-corner-lg text-destructive"
        >
          <KeyRound className="size-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="space-y-3 text-sm">
        <p className="font-medium">Your communities couldn't be decrypted</p>
        <p className="text-muted-foreground">
          {canDecrypt
            ? "Your list of encrypted communities was found, but your signer didn't decrypt it. Check that it's connected and allows decryption, then try again."
            : "Your signer can't decrypt (NIP-44), so encrypted communities can't be shown or joined. Sign in with a signer that supports it to use them."}
        </p>
        {canDecrypt && (
          <Button
            variant="secondary"
            size="sm"
            disabled={list.isFetching}
            onClick={() => void list.refetch()}
          >
            {list.isFetching ? "Trying…" : "Try again"}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
