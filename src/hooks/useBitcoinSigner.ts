import { useEffect, useMemo, useState } from 'react';
import { useNostrLogin } from '@nostrify/react/login';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { type BtcSigner, hasBtcSigning } from '@/lib/bitcoin-signers';

/**
 * Bitcoin PSBT signing capability:
 * - `supported`: nsec login, or an extension exposing `signPsbt`.
 * - `unsupported`: extension without `signPsbt`, or a bunker that rejected `sign_psbt`.
 * - `unknown`: NIP-46 bunkers (no capability RPC) — attempt, and flip to
 *   unsupported on a capability error (see `reportSignerUnsupported`).
 */
export type BitcoinSignerCapability = 'supported' | 'unsupported' | 'unknown';

/** Bunker pubkeys observed rejecting `sign_psbt` this page lifetime. */
const knownUnsupportedBunkers = new Set<string>();

/** Mark a bunker (by user pubkey) as unsupported for PSBT signing. */
export function reportSignerUnsupported(pubkey: string): void {
  knownUnsupportedBunkers.add(pubkey);
  // Notify hook consumers via a DOM event (listened to by `useBitcoinSigner`).
  window.dispatchEvent(new CustomEvent('bitcoin-signer-unsupported', { detail: pubkey }));
}

/**
 * Bitcoin PSBT signing capability for the current login, probed eagerly so the
 * UI can show "unsupported" before an attempt. nsec → supported; extension →
 * probes `window.nostr.signPsbt` (unknown until injected); bunker → unknown
 * until a capability rejection (see `reportSignerUnsupported`).
 */
export function useBitcoinSigner() {
  const { user } = useCurrentUser();
  const { logins } = useNostrLogin();
  const loginType = logins[0]?.type;

  const [extensionProbe, setExtensionProbe] = useState<BitcoinSignerCapability>(() => {
    if (loginType !== 'extension') return 'unknown';
    const n = (globalThis as { nostr?: Record<string, unknown> }).nostr;
    if (n && typeof n.signPsbt === 'function') return 'supported';
    if (n) return 'unsupported';
    return 'unknown';
  });

  useEffect(() => {
    if (loginType !== 'extension') return;
    let cancelled = false;
    const probe = () => {
      const n = (globalThis as { nostr?: Record<string, unknown> }).nostr;
      if (!n) return false;
      setExtensionProbe(typeof n.signPsbt === 'function' ? 'supported' : 'unsupported');
      return true;
    };
    if (probe()) return;
    const interval = setInterval(() => {
      if (cancelled) return;
      if (probe()) clearInterval(interval);
    }, 250);
    // Stop polling after 3 s.
    const stop = setTimeout(() => clearInterval(interval), 3000);
    return () => { cancelled = true; clearInterval(interval); clearTimeout(stop); };
  }, [loginType]);

  const [bunkerUnsupported, setBunkerUnsupported] = useState(() =>
    user ? knownUnsupportedBunkers.has(user.pubkey) : false,
  );

  // Reset on user change so a new session isn't tainted; full logout also clears
  // the module registry.
  useEffect(() => {
    if (!user) {
      setBunkerUnsupported(false);
      knownUnsupportedBunkers.clear();
      return;
    }
    setBunkerUnsupported(knownUnsupportedBunkers.has(user.pubkey));
  }, [user?.pubkey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (loginType !== 'bunker' || !user) return;
    const onUnsupported = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail === user.pubkey) setBunkerUnsupported(true);
    };
    const onCleared = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail === '*' || detail === user.pubkey) setBunkerUnsupported(false);
    };
    window.addEventListener('bitcoin-signer-unsupported', onUnsupported);
    window.addEventListener('bitcoin-signer-cleared', onCleared);
    return () => {
      window.removeEventListener('bitcoin-signer-unsupported', onUnsupported);
      window.removeEventListener('bitcoin-signer-cleared', onCleared);
    };
  }, [loginType, user]);

  const capability: BitcoinSignerCapability = useMemo(() => {
    if (!user) return 'unsupported';
    switch (loginType) {
      case 'nsec':
        return 'supported';
      case 'extension':
        return extensionProbe;
      case 'bunker':
        return bunkerUnsupported ? 'unsupported' : 'unknown';
      default:
        // Unknown login type: fall back to the structural check.
        return hasBtcSigning(user.signer) ? 'unknown' : 'unsupported';
    }
  }, [user, loginType, extensionProbe, bunkerUnsupported]);

  const btcSigner = useMemo((): BtcSigner | null => {
    if (!user || capability === 'unsupported') return null;
    if (hasBtcSigning(user.signer)) return user.signer;
    return null;
  }, [user, capability]);

  return {
    /** Detailed capability state. See {@link BitcoinSignerCapability}. */
    capability,
    /** True when capability is `'supported'` or `'unknown'` (attempt allowed). */
    canSignPsbt: capability !== 'unsupported' && btcSigner !== null,
    /** Sign a hex PSBT (signed, not finalized); throws if unsupported. */
    signPsbt: btcSigner
      ? (psbtHex: string) => btcSigner.signPsbt(psbtHex)
      : null,
  };
}

/**
 * Whether a signer error means it fundamentally can't sign PSBTs (vs. a transient
 * error). Used by `useOnchainZap` to decide whether to flip to `'unsupported'`.
 */
export function isSignerCapabilityError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('does not support') ||
    msg.includes("doesn't support") ||
    msg.includes('signpsbt') ||
    msg.includes('sign_psbt')
  );
}
