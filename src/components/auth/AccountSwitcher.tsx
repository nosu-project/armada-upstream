// NOTE: This file is stable and usually should not be modified.
// It is important that all functionality in this file is preserved, and should only be modified if explicitly requested.

import { useContext, useRef, useState } from 'react';
import { ChevronDown, IdCard, LogOut, QrCode, Smile, UserIcon, UserPen, UserPlus, Wallet } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar.tsx';
import { EmojifiedText } from '@/components/chat/CustomEmoji';
import { getAvatarShape } from '@/lib/avatarShape';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useLoggedInAccounts, type Account } from '@/hooks/useLoggedInAccounts';
import { useSwitchAccount } from '@/hooks/useSwitchAccount';
import { useServerScope } from '@/contexts/ServerScopeContext';
import { ProfileShareDialog } from '@/components/dialogs/ProfileShareDialog';
import { ServerProfileDialog } from '@/components/dialogs/ServerProfileDialog';
import { StatusDialog } from '@/components/dialogs/StatusDialog';
import { WalletDialog } from '@/components/dialogs/WalletDialog';
import { beginAccountExit } from '@/components/accountExitState';
import { finalLogout } from '@/lib/finalLogout';
import { SettingsOverlayContext } from '@/lib/settingsOverlay';
import { useAppContext } from '@/hooks/useAppContext';
import { cn } from '@/lib/utils';

interface AccountSwitcherProps {
  onAddAccountClick: () => void;
}

const getDisplayName = (account: Account): string => {
  return account.metadata.name || account.metadata.display_name || 'Anonymous';
};

/** Whether the account's kind-0 carries any name at all (vs. the 'Anonymous'
 * fallback). A skipped onboarding profile step leaves this false, and the
 * trigger then renders a self-describing "Set your name" empty state instead
 * of pretending "Anonymous" is a name. */
const hasName = (account: Account): boolean => {
  return Boolean(account.metadata.name || account.metadata.display_name);
};

/**
 * An account's name with NIP-30 custom emoji shortcodes rendered as inline
 * images. Emoji tags come from the account's own kind-0 event (which
 * `useLoggedInAccounts` already resolved to produce the metadata above), so the
 * name and its emoji always describe the same profile event. Sites that need a
 * plain string (`alt`, the avatar initial) keep using {@link getDisplayName}.
 */
function AccountName({ account }: { account: Account }) {
  return (
    <EmojifiedText tags={account.event?.tags ?? []}>
      {getDisplayName(account)}
    </EmojifiedText>
  );
}

export function AccountSwitcher({ onAddAccountClick }: AccountSwitcherProps) {
  const { currentUser, otherUsers, isLoading } = useLoggedInAccounts();
  // Both of these reload the app — see `switchAccount`. Anything that changes
  // which account is `logins[0]` has to, or the incoming account inherits the
  // outgoing one's caches.
  const { switchTo, signOut } = useSwitchAccount();
  const { config } = useAppContext();
  const [isOpen, setIsOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  // The server (relay) currently being viewed, if any. Drives the optional
  // "Server identity" item (per-server nickname/label/color).
  const serverScope = useServerScope();
  const [serverIdentityOpen, setServerIdentityOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [shareProfileOpen, setShareProfileOpen] = useState(false);
  // Settings draws over the current page (`lib/settingsOverlay.ts`).
  const settings = useContext(SettingsOverlayContext);
  // The finger press currently on the trigger: where it landed and whether the
  // menu was already open. Null for mouse/pen, which keep Radix's own
  // press-to-open. See the trigger's handlers below.
  const touchPress = useRef<{ x: number; y: number; wasOpen: boolean } | null>(null);

  if (!currentUser) return null;

  // The empty-profile "nudge": when the account has no name at all (the
  // onboarding profile step is skippable), the trigger itself says so — a
  // self-describing label plus a dot on the avatar — and it self-resolves the
  // moment a name is saved, with no dismissal state to persist.
  const profileIncomplete = !isLoading && !hasName(currentUser);

  const handleLogout = () => {
    // Close the dropdown first to avoid React error #300
    setIsOpen(false);
    // Is this the last logged-in identity? If so we do a full storage purge
    // and hard-redirect to the landing page so a fresh logout holds onto
    // nothing; otherwise we just drop this account and keep the others' caches.
    const isLastAccount = otherUsers.length === 0;
    // Raise the full-screen exit overlay NOW, before the dropdown-close tick and
    // any of the bounded teardown below — otherwise the press reads as no press
    // until the eventual reload. Synchronous on click; the reload clears it.
    beginAccountExit(isLastAccount ? 'logout' : 'switch', currentUser.pubkey);
    // Use setTimeout to ensure the dropdown closes before the teardown starts.
    setTimeout(() => {
      if (isLastAccount) {
        // Wipe everything and land on the login screen, on a guaranteed,
        // bounded deadline — see finalLogout.
        void finalLogout(currentUser.pubkey);
      } else {
        // Another account is about to become active, which is an account
        // SWITCH — so it takes the switch path, reload included, rather than
        // inheriting this account's caches in place. `signOut` persists the
        // remaining logins itself and raises the same overlay.
        signOut(currentUser.id);
      }
    }, 0);
  };

  return (
    <>
    <DropdownMenu modal={false} open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button
          onPointerDown={(e) => {
            // Radix opens this menu on POINTERDOWN. The pill sits at the foot
            // of the channel list, which on mobile is SwipeReveal's underlay —
            // the surface carrying the leftward swipe that brings the chat back
            // over it. So a swipe that merely BEGAN here opened the account
            // menu, and being portalled above the chat pane it then floated
            // over wherever the swipe navigated to. A finger opens it on the
            // TAP instead: preventDefault makes Radix skip its own handler
            // (composeEventHandlers bails on a default-prevented event) while
            // the click still fires, and a press that becomes a claimed drag
            // produces no click at all. Mouse and pen keep press-to-open.
            if (e.pointerType !== 'touch') return;
            touchPress.current = { x: e.clientX, y: e.clientY, wasOpen: isOpen };
            e.preventDefault();
          }}
          onClick={(e) => {
            const press = touchPress.current;
            if (!press) return;
            touchPress.current = null;
            // Belt and braces, if the platform synthesizes a click for a
            // gesture anyway: a release far from the press was not a tap.
            if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 16) return;
            // Toggle against the state at PRESS time. A tap on an open menu is
            // an outside press that Radix has already dismissed by now, so
            // toggling the current value would reopen it.
            setIsOpen(!press.wasOpen);
          }}
          className='flex items-center gap-3 p-2 clip-corner-lg bg-accent/50 hover:bg-accent transition-all w-full text-foreground'
        >
          {isLoading ? (
            <Skeleton className='w-8 h-8 rounded-full shrink-0' />
          ) : (
            <span className='relative shrink-0'>
              <Avatar shape={getAvatarShape(currentUser.metadata)} className='w-8 h-8'>
                <AvatarImage src={currentUser.metadata.picture} alt={getDisplayName(currentUser)} />
                <AvatarFallback>
                  {profileIncomplete ? <UserIcon className='size-4' /> : getDisplayName(currentUser).charAt(0)}
                </AvatarFallback>
              </Avatar>
              {profileIncomplete && (
                <span className='absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-background' aria-hidden />
              )}
            </span>
          )}
          <div className='flex-1 text-left block truncate min-w-0'>
            {isLoading ? (
              <Skeleton className='h-4 w-24' />
            ) : profileIncomplete ? (
              <p className='text-sm italic text-muted-foreground truncate'>Set your name</p>
            ) : (
              <p className='font-medium text-sm truncate'><AccountName account={currentUser} /></p>
            )}
          </div>
          <ChevronDown className='w-4 h-4 text-muted-foreground' />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className='w-60 p-2 clip-corner-lg border-none shadow-xl animate-scale-in'>
        {/* You: identity actions first — this menu hangs off your own card. */}
        <DropdownMenuItem
          onClick={() => settings.show('profile')}
          className={cn(
            'flex items-center gap-2 cursor-pointer p-2 clip-corner-lg',
            // Part of the empty-profile nudge: the same dot as the trigger's
            // avatar, pointing at the way to resolve it.
            profileIncomplete && 'text-primary focus:text-primary bg-primary/10',
          )}
        >
          <UserPen className='w-4 h-4' />
          <span>{profileIncomplete ? 'Set up your profile' : 'Edit profile'}</span>
          {profileIncomplete && <span className='ml-auto size-2 rounded-full bg-primary' aria-hidden />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setStatusOpen(true)}
          className='flex items-center gap-2 cursor-pointer p-2 clip-corner-lg'
        >
          <Smile className='w-4 h-4' />
          <span>Set status</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => { setIsOpen(false); setShareProfileOpen(true); }}
          className='flex items-center gap-2 cursor-pointer p-2 clip-corner-lg'
        >
          <QrCode className='w-4 h-4' />
          <span>Share your profile</span>
        </DropdownMenuItem>
        {serverScope && (
          <DropdownMenuItem
            onClick={() => setServerIdentityOpen(true)}
            className='flex items-center gap-2 cursor-pointer p-2 clip-corner-lg'
          >
            <IdCard className='w-4 h-4' />
            <span>Server identity</span>
          </DropdownMenuItem>
        )}
        {config.zapsEnabled && (
          <DropdownMenuItem
            onClick={() => { setIsOpen(false); setWalletOpen(true); }}
            className='flex items-center gap-2 cursor-pointer p-2 clip-corner-lg'
          >
            <Wallet className='w-4 h-4' />
            <span>Wallet</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {/* Accounts: only label the section when there is something to switch to. */}
        {otherUsers.length > 0 && (
          <div className='px-2 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground'>
            Switch account
          </div>
        )}
        {otherUsers.map((user) => (
          <DropdownMenuItem
            key={user.id}
            onClick={() => switchTo(user.id)}
            className='flex items-center gap-2 cursor-pointer p-2 clip-corner-lg'
          >
            <Avatar shape={getAvatarShape(user.metadata)} className='w-8 h-8'>
              <AvatarImage src={user.metadata.picture} alt={getDisplayName(user)} />
              <AvatarFallback>{getDisplayName(user)?.charAt(0) || <UserIcon />}</AvatarFallback>
            </Avatar>
            <div className='flex-1 truncate'>
              <p className='text-sm font-medium'><AccountName account={user} /></p>
            </div>
            {user.id === currentUser.id && <div className='w-2 h-2 rounded-full bg-primary'></div>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          onClick={onAddAccountClick}
          className='flex items-center gap-2 cursor-pointer p-2 clip-corner-lg'
        >
          <UserPlus className='w-4 h-4' />
          <span>Add another account</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleLogout}
          className='flex items-center gap-2 cursor-pointer p-2 clip-corner-lg text-red-500'
        >
          <LogOut className='w-4 h-4' />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {serverScope && (
      <ServerProfileDialog
        relayUrl={serverScope}
        open={serverIdentityOpen}
        onOpenChange={setServerIdentityOpen}
      />
    )}
    <StatusDialog open={statusOpen} onOpenChange={setStatusOpen} />
    <ProfileShareDialog open={shareProfileOpen} onOpenChange={setShareProfileOpen} />
    <WalletDialog open={walletOpen} onOpenChange={setWalletOpen} />
    </>
  );
}
