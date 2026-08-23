// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PORTAL = 'https://bridge.example.com';

/** platform.ts reads the env once at load, so every case re-imports the graph. */
async function load(portalUrl = PORTAL) {
  vi.resetModules();
  vi.stubEnv('VITE_BRIDGE_PORTAL_URL', portalUrl);
  return await import('./bridgeApi');
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bridgeApi', () => {
  it('refuses to call anything when no portal is configured', async () => {
    const { bridgeApi } = await load('');
    await expect(bridgeApi('/api/me')).rejects.toThrow(/no Discord bridge portal/i);
  });

  it('sends the stored token as a bearer header', async () => {
    const { bridgeApi, setBridgeToken } = await load();
    setBridgeToken('a'.repeat(48));
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await bridgeApi('/api/me');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${PORTAL}/api/me`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${'a'.repeat(48)}`);
  });

  it('omits the header entirely when there is no token', async () => {
    const { bridgeApi } = await load();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await bridgeApi('/api/me');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("surfaces the portal's error string, which is written for humans", async () => {
    const { bridgeApi } = await load();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"you do not hold Manage Server in that guild"}', { status: 403 })),
    );

    await expect(bridgeApi('/api/imports')).rejects.toThrow(/Manage Server/);
  });

  // A dead token must not strand the wizard on a session it can't recover from.
  it('clears the token on 401', async () => {
    const { bridgeApi, setBridgeToken, bridgeToken } = await load();
    setBridgeToken('b'.repeat(48));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })));

    await expect(bridgeApi('/api/me')).rejects.toThrow();
    expect(bridgeToken()).toBeNull();
  });

  it('reports a network failure as a reachability problem, not a crash', async () => {
    const { bridgeApi } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed to fetch'); }));

    await expect(bridgeApi('/api/me')).rejects.toThrow(/Couldn't reach the bridge portal/i);
  });
});

describe('connectDiscord', () => {
  function fakePopup() {
    const popup = { closed: false, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => popup));
    return popup;
  }

  it('rejects when the popup is blocked', async () => {
    const { connectDiscord } = await load();
    vi.stubGlobal('open', vi.fn(() => null));
    await expect(connectDiscord()).rejects.toThrow(/blocked/i);
  });

  it('stores the token from a message sent by the portal origin', async () => {
    const { connectDiscord, bridgeToken } = await load();
    fakePopup();

    const promise = connectDiscord();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: PORTAL,
        data: { type: 'armada-bridge-session', token: 'c'.repeat(48) },
      }),
    );

    await expect(promise).resolves.toBeUndefined();
    expect(bridgeToken()).toBe('c'.repeat(48));
  });

  // The whole security of the handoff rests on this check: any page can
  // postMessage at us claiming to be the portal.
  it('ignores a token from any other origin', async () => {
    const { connectDiscord, bridgeToken } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"pending":true}', { status: 200 })));
    const popup = fakePopup();

    const promise = connectDiscord({ closeGraceMs: 20, pollMs: 5 });
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example.com',
        data: { type: 'armada-bridge-session', token: 'd'.repeat(48) },
      }),
    );

    // Nothing was accepted; the attempt is still pending until the user gives up.
    expect(bridgeToken()).toBeNull();

    popup.closed = true;
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('rejects when the popup closes and the claim keeps coming up empty', async () => {
    const { connectDiscord } = await load();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"pending":true}', { status: 200 })));
    const popup = fakePopup();

    const promise = connectDiscord({ closeGraceMs: 20, pollMs: 5 });
    popup.closed = true;

    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  // The COOP path: Discord's login severs window.opener, so no message ever
  // arrives — the token comes home through the nonce claim instead, even
  // after the callback page has already closed the popup.
  it('claims the token by nonce when the popup closes without a message', async () => {
    const { connectDiscord, bridgeToken } = await load();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: 'e'.repeat(48) }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const popup = fakePopup();

    const promise = connectDiscord({ closeGraceMs: 5_000, pollMs: 5 });
    popup.closed = true;

    await expect(promise).resolves.toBeUndefined();
    expect(bridgeToken()).toBe('e'.repeat(48));

    // The claim carried the same nonce the popup URL was minted with.
    const openMock = window.open as unknown as ReturnType<typeof vi.fn>;
    const openedUrl = String(openMock.mock.calls[0][0]);
    const nonce = /[?&]nonce=([0-9a-f]{32})/.exec(openedUrl)?.[1];
    expect(nonce).toBeTruthy();
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const claimCall = calls.find(([u]) => String(u).endsWith('/api/auth/claim'));
    expect(claimCall).toBeTruthy();
    expect(JSON.parse(claimCall![1].body as string)).toEqual({ nonce });
  });
});
