import { Crown, Shield } from 'lucide-react';

import { useStaffTier } from '@/hooks/useMemberRoles';
import { defineMessages, FormattedMessage, useIntl } from '@/i18n';
import { cn } from '@/lib/utils';

const LABEL = defineMessages({
  owner: { id: 'staffPill.owner', defaultMessage: 'Owner' },
  admin: { id: 'staffPill.admin', defaultMessage: 'Admin' },
  moderator: { id: 'staffPill.moderator', defaultMessage: 'Mod' },
});
const TITLE = defineMessages({
  owner: { id: 'staffPill.ownerTitle', defaultMessage: 'Community owner' },
  admin: { id: 'staffPill.adminTitle', defaultMessage: 'Community admin' },
  moderator: { id: 'staffPill.moderatorTitle', defaultMessage: 'Community moderator' },
});
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
  const intl = useIntl();
  const tier = useStaffTier(pubkey);
  if (!tier) return null;
  const Icon = tier === 'owner' ? Crown : Shield;

  return (
    <span
      title={intl.formatMessage(TITLE[tier])}
      className={cn(
        'shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium',
        TINT[tier],
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      <FormattedMessage {...LABEL[tier]} />
    </span>
  );
}
