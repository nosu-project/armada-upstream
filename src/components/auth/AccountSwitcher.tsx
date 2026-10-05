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
import { MountWhenOpened } from '@/components/MountWhenOpened';

interface AccountSwitcherProps {
  onAddAccountClick: () => void;
}

const getDisplayName = (account: Account): string => {
  return account.metadata.name || account.metadata.display_name || 'Anonymous';
};

/** Whether the kind-0 has any name (vs. the 'Anonymous' fallback). */
const hasName = (account: Account): boolean => {
  return Boolean(account.metadata.name || account.metadata.display_name);
};

/** Name with NIP-30 custom emoji rendered; plain-string sites use {@link getDisplayName}. */
function AccountName({ account }: { account: Account }) {
  return (
    <EmojifiedText tags={account.event?.tags ?? []}>
      {getDisplayName(account)}
    </EmojifiedText>
  );
}

export function AccountSwitcher({ onAddAccountClick }: AccountSwitcherProps) {
  const { currentUser, otherUsers, isLoading } = useLoggedInAccounts();
  // Both reload the app (see `switchAccount`), or the incoming account inherits
  // the outgoing one's caches.
  const { switchTo, signOut } = useSwitchAccount();
  const { config } = useAppContext();
  const [isOpen, setIsOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const serverScope = useServerScope();
  const [serverIdentityOpen, setServerIdentityOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [shareProfileOpen, setShareProfileOpen] = useState(false);
  const settings = useContext(SettingsOverlayContext);
  // Finger press on the trigger; null for mouse/pen (Radix press-to-open).
  const touchPress = useRef<{ x: number; y: number; wasOpen: boolean } | null>(null);

  if (!currentUser) return null;

  // Empty-profile nudge; resolves itself once a name is saved.
  const profileIncomplete = !isLoading && !hasName(currentUser);

  const handleLogout = () => {
    // Close the dropdown first to avoid React error #300
    setIsOpen(false);
    // Last account: full storage purge and hard redirect.
    const isLastAccount = otherUsers.length === 0;
    // Raise the exit overlay synchronously, before any teardown.
    beginAccountExit(isLastAccount ? 'logout' : 'switch', currentUser.pubkey);
    setTimeout(() => {
      if (isLastAccount) {
        // Bounded deadline — see finalLogout.
        void finalLogout(currentUser.pubkey);
      } else {
        // Removing this account is a SWITCH, so it takes the reload path.
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
            // Radix opens on POINTERDOWN, so a swipe beginning here (SwipeReveal's
            // underlay on mobile) opened the menu. Touch opens on the tap instead:
            // preventDefault makes Radix skip its handler, and a claimed drag fires no click.
            if (e.pointerType !== 'touch') return;
            touchPress.current = { x: e.clientX, y: e.clientY, wasOpen: isOpen };
            e.preventDefault();
          }}
          onClick={(e) => {
            const press = touchPress.current;
            if (!press) return;
            touchPress.current = null;
            // A release far from the press was not a tap.
            if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 16) return;
            // Toggle against the state at PRESS time: Radix already dismissed an open menu.
            setIsOpen(!press.wasOpen);
          }}
          className='flex items-center gap-3 p-2 clip-corner-lg bg-accent/50 hover:bg-accent transition-all w-full text-foreground'
        >
          {isLoading ? (
            <Skeleton className='w-8 h-8 rounded-full shrink-0' />
          ) : (
            <span className='relative shrink-0'>
              <Avatar shape={getAvatarShape(currentUser.metadata)} className='w-8 h-8'>
                <AvatarImage src={currentUser.metadata.picture} imeta={currentUser.imeta?.picture} alt={getDisplayName(currentUser)} />
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
      <DropdownMenuContent className='w-60 p-2 animate-scale-in'>
        <DropdownMenuItem
          onClick={() => settings.show('profile')}
          className={cn(
            'flex items-center gap-2 cursor-pointer p-2 clip-corner-lg',
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
              <AvatarImage src={user.metadata.picture} imeta={user.imeta?.picture} alt={getDisplayName(user)} />
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
    {/* Built on first open: it derives a Taproot address, npub and emoji palette. */}
    {serverScope && (
      <MountWhenOpened open={serverIdentityOpen}>
        <ServerProfileDialog
          relayUrl={serverScope}
          open={serverIdentityOpen}
          onOpenChange={setServerIdentityOpen}
        />
      </MountWhenOpened>
    )}
    <MountWhenOpened open={statusOpen}>
      <StatusDialog open={statusOpen} onOpenChange={setStatusOpen} />
    </MountWhenOpened>
    <MountWhenOpened open={shareProfileOpen}>
      <ProfileShareDialog open={shareProfileOpen} onOpenChange={setShareProfileOpen} />
    </MountWhenOpened>
    <MountWhenOpened open={walletOpen}>
      <WalletDialog open={walletOpen} onOpenChange={setWalletOpen} />
    </MountWhenOpened>
    </>
  );
}
