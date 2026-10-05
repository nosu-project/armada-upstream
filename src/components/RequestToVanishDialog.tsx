import { useState, useCallback, useEffect } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useRequestToVanish } from '@/hooks/useRequestToVanish';
import { useLoginActions } from '@/hooks/useLoginActions';
import { toast } from '@/hooks/useToast';

interface RequestToVanishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DELETION_ITEMS = [
  { id: 'profile', label: 'Your profile and metadata' },
  { id: 'posts', label: 'All posts, replies, and reactions' },
  { id: 'messages', label: 'Direct messages' },
  { id: 'settings', label: 'Follow lists and settings' },
  { id: 'other', label: 'All other events submitted to the network' },
] as const;

type ItemId = (typeof DELETION_ITEMS)[number]['id'];

export function RequestToVanishDialog({ open, onOpenChange }: RequestToVanishDialogProps) {
  const { mutateAsync: requestVanish, isPending } = useRequestToVanish();
  const { logout } = useLoginActions();

  const [checked, setChecked] = useState<Set<ItemId>>(new Set());

  const allChecked = DELETION_ITEMS.every((item) => checked.has(item.id));

  const toggle = (id: ItemId) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const resetState = useCallback(() => {
    setChecked(new Set());
  }, []);

  useEffect(() => {
    if (!open) resetState();
  }, [open, resetState]);

  const handleSubmit = async () => {
    if (!allChecked) return;

    try {
      await requestVanish({ relayUrls: ['ALL_RELAYS'], content: '' });

      toast({
        title: 'Account deleted',
        description: 'Your deletion request has been broadcast. You have been logged out.',
      });

      onOpenChange(false);
      await logout();
    } catch {
      toast({
        title: 'Failed to delete account',
        description: 'Something went wrong. You can try again.',
        variant: 'destructive',
      });
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="gap-0">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-destructive/15 text-destructive">
            <AlertTriangle className="size-6" />
          </div>
          <AlertDialogTitle>delete account</AlertDialogTitle>
          <AlertDialogDescription>
            This will <span className="font-semibold text-destructive">permanently delete your data</span>. Check each box to confirm you understand what will be removed:
          </AlertDialogDescription>
        </div>

        <div className="space-y-3 mb-5">
          {DELETION_ITEMS.map((item) => (
            <label
              key={item.id}
              className="flex items-center gap-3 cursor-pointer select-none"
            >
              <Checkbox
                checked={checked.has(item.id)}
                onCheckedChange={() => toggle(item.id)}
                className="border-destructive/60 data-[state=checked]:bg-destructive data-[state=checked]:border-destructive"
              />
              <span className="text-sm text-muted-foreground">{item.label}</span>
            </label>
          ))}
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed mb-5">
          This action is <span className="font-semibold text-destructive">irreversible</span>.
          Your account cannot be recovered after deletion. You will be logged out immediately.
        </p>

        <div className="flex gap-3">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            className="flex-1 gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40"
            onClick={handleSubmit}
            disabled={!allChecked || isPending}
          >
            {isPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Deleting…
              </>
            ) : (
              'Delete Account'
            )}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
