import type { NostrEvent, NostrSigner } from '@nostrify/types';
import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import { NostrSignerPlugin } from 'capacitor-plugin-nostr-signer';

import type { BtcSigner } from '@/lib/bitcoin-signers';

// Native Android signer (NIP-55, Amber etc.) via `capacitor-plugin-nostr-signer`.
// Each crypto call takes a fresh request id to match concurrent responses.
// Wrapped in `AppSigner` by `useCurrentUser` for the decrypt cache.
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
      encrypt: this.nip04Encrypt.bind(this),
      decrypt: this.nip04Decrypt.bind(this),
    };
    this.nip44 = {
      encrypt: this.nip44Encrypt.bind(this),
      decrypt: this.nip44Decrypt.bind(this),
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

    // The plugin requires a precomputed id and a placeholder sig.
    const withPubkey = { ...template, pubkey } as Omit<NostrEvent, 'id' | 'sig'>;
    const id = getEventHash(withPubkey);
    const eventJson = JSON.stringify({ ...withPubkey, id, sig: '' });

    const result = await NostrSignerPlugin.signEvent(
      this.packageName,
      eventJson,
      id,
      pubkey,
    );

    const signed = JSON.parse(result.event) as NostrEvent;
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

  private async nip04Encrypt(pubkey: string, plaintext: string): Promise<string> {
    const myPubkey = await this.getPublicKey();
    const { result } = await NostrSignerPlugin.nip04Encrypt(
      this.packageName,
      plaintext,
      crypto.randomUUID(),
      pubkey,
      myPubkey,
    );
    return result;
  }

  private async nip04Decrypt(pubkey: string, ciphertext: string): Promise<string> {
    const myPubkey = await this.getPublicKey();
    const { result } = await NostrSignerPlugin.nip04Decrypt(
      this.packageName,
      ciphertext,
      crypto.randomUUID(),
      pubkey,
      myPubkey,
    );
    return result;
  }

  private async nip44Encrypt(pubkey: string, plaintext: string): Promise<string> {
    const myPubkey = await this.getPublicKey();
    const { result } = await NostrSignerPlugin.nip44Encrypt(
      this.packageName,
      plaintext,
      crypto.randomUUID(),
      pubkey,
      myPubkey,
    );
    return result;
  }

  private async nip44Decrypt(pubkey: string, ciphertext: string): Promise<string> {
    const myPubkey = await this.getPublicKey();
    const { result } = await NostrSignerPlugin.nip44Decrypt(
      this.packageName,
      ciphertext,
      crypto.randomUUID(),
      pubkey,
      myPubkey,
    );
    return result;
  }
}
