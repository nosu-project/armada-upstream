import type { NostrEvent, NostrSigner } from '@nostrify/types';
import { registerPlugin } from '@capacitor/core';
import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import { NostrSignerPlugin } from 'capacitor-plugin-nostr-signer';

import type { BtcSigner } from '@/lib/bitcoin-signers';

type SignerRequestType = 'sign_event' | 'nip04_encrypt' | 'nip04_decrypt' | 'nip44_encrypt' | 'nip44_decrypt';

/**
 * `ArmadaSignerPlugin.java`: NIP-55 requests matched to their answers by `id`,
 * so concurrent ones can't lose or swap results. `event` is absent when a sign
 * request was answered inside a batch, which carries only the signature.
 */
interface ArmadaSignerPlugin {
  request(options: {
    packageName: string;
    type: SignerRequestType;
    payload: string;
    id: string;
    currentUser: string;
    pubkey?: string;
  }): Promise<{ result: string; event?: string }>;
}

// Registered on first use, so merely importing this module needs no native bridge.
let armadaSigner: ArmadaSignerPlugin | undefined;
const signerPlugin = () => (armadaSigner ??= registerPlugin<ArmadaSignerPlugin>('ArmadaSigner'));

// Native Android signer (NIP-55, Amber etc.). Login, the installed-signer list
// and PSBTs go through `capacitor-plugin-nostr-signer`; everything a session
// issues in bulk goes through ArmadaSigner. Wrapped in `AppSigner` by
// `useCurrentUser` for the decrypt cache.
export class AndroidNativeSigner implements BtcSigner {
  readonly packageName: string;

  // Cached (or seeded from the persisted login) so boot doesn't re-prompt.
  private pubkey: string | null;
  private connected = false;

  readonly nip04: NonNullable<NostrSigner['nip04']>;
  readonly nip44: NonNullable<NostrSigner['nip44']>;

  constructor(packageName: string, pubkey?: string) {
    this.packageName = packageName;
    this.pubkey = pubkey ?? null;

    this.nip04 = {
      encrypt: (peer, plaintext) => this.crypt('nip04_encrypt', peer, plaintext),
      decrypt: (peer, ciphertext) => this.crypt('nip04_decrypt', peer, ciphertext),
    };
    this.nip44 = {
      encrypt: (peer, plaintext) => this.crypt('nip44_encrypt', peer, plaintext),
      decrypt: (peer, ciphertext) => this.crypt('nip44_decrypt', peer, ciphertext),
    };
  }

  static async getSignerApps() {
    const { apps } = await NostrSignerPlugin.getInstalledSignerApps();
    return apps;
  }

  private async setup(): Promise<string> {
    if (this.connected && this.pubkey) return this.pubkey;

    await NostrSignerPlugin.setPackageName(this.packageName);

    if (!this.pubkey) {
      const result = await NostrSignerPlugin.getPublicKey();
      this.pubkey = result.pubkey;
    }

    this.connected = true;
    return this.pubkey;
  }

  async getPublicKey(): Promise<string> {
    return await this.setup();
  }

  async signEvent(template: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>): Promise<NostrEvent> {
    const pubkey = await this.getPublicKey();

    // The signer wants a precomputed id and a placeholder sig.
    const withPubkey = { ...template, pubkey } as Omit<NostrEvent, 'id' | 'sig'>;
    const id = getEventHash(withPubkey);
    const eventJson = JSON.stringify({ ...withPubkey, id, sig: '' });

    const { result, event } = await signerPlugin().request({
      packageName: this.packageName,
      type: 'sign_event',
      payload: eventJson,
      // Request ids must be unique while pending; one event can be asked for twice.
      id: `${id}:${crypto.randomUUID()}`,
      currentUser: pubkey,
    });

    const signed = event ? JSON.parse(event) as NostrEvent : { ...withPubkey, id, sig: result };
    if (!verifyEvent(signed)) {
      throw new Error('Android signer returned an invalid signature');
    }
    return signed;
  }

  // Bitcoin PSBT signing of the user's Taproot inputs; returns the signed hex PSBT.
  async signPsbt(psbtHex: string): Promise<string> {
    const pubkey = await this.getPublicKey();
    const { result } = await NostrSignerPlugin.signPsbt(
      this.packageName,
      psbtHex,
      crypto.randomUUID(),
      pubkey,
    );
    return result;
  }

  private async crypt(type: SignerRequestType, peer: string, text: string): Promise<string> {
    const currentUser = await this.getPublicKey();
    const { result } = await signerPlugin().request({
      packageName: this.packageName,
      type,
      payload: text,
      id: crypto.randomUUID(),
      currentUser,
      pubkey: peer,
    });
    return result;
  }
}
