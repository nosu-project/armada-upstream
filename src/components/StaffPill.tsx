import { Crown, Shield } from 'lucide-react';

import { useStaffTier } from '@/hooks/useMemberRoles';
import { cn } from '@/lib/utils';

const LABEL = { owner: 'Owner', admin: 'Admin', moderator: 'Mod' } as const;
const TITLE = { owner: 'Community owner', admin: 'Community admin', moderator: 'Community moderator' } as const;
const TINT = {
  owner: 'bg-amber-500/15 text-amber-500',
  admin: 'bg-primary/15 text-primary',
  moderator: 'bg-muted text-muted-foreground',
} as const;

/**
 * Owner/Admin/Mod pill beside a byline, matching the member list's tiers.
 * Renders nothing outside a community scope or for a regular member.
 */
export function StaffPill({ pubkey, className }: { pubkey: string; className?: string }) {
  const tier = useStaffTier(pubkey);
  if (!tier) return null;
  const Icon = tier === 'owner' ? Crown : Shield;

  return (
    <span
      title={TITLE[tier]}
      className={cn(
        'shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium',
        TINT[tier],
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {LABEL[tier]}
    </span>
  );
}
