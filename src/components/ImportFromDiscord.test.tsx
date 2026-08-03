import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { pubkey: 'test-pubkey' } }),
}));
// The wizard is lazy and never opened here; stub it so the chunk (and the whole
// bridge API client) stays out of this suite.
vi.mock('@/components/discord-import/DiscordImportWizard', () => ({
  DiscordImportWizard: () => null,
}));

/**
 * `platform.ts` reads `VITE_BRIDGE_PORTAL_URL` once, at module load, so each
 * case has to stub the env and then re-import the whole graph.
 */
async function load(portalUrl: string) {
  vi.resetModules();
  vi.stubEnv('VITE_BRIDGE_PORTAL_URL', portalUrl);
  return {
    ...(await import('./ImportFromDiscord')),
    ...(await import('@/lib/platform')),
  };
}

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('bridgePortalUrl', () => {
  it('is null when the build names no portal', async () => {
    const { bridgePortalUrl } = await load('');
    expect(bridgePortalUrl('/')).toBeNull();
    expect(bridgePortalUrl('/import')).toBeNull();
  });

  it('builds paths against the configured origin', async () => {
    const { bridgePortalUrl } = await load('https://bridge.example.com');
    expect(bridgePortalUrl('/')).toBe('https://bridge.example.com');
    expect(bridgePortalUrl('/import')).toBe('https://bridge.example.com/import');
  });

  it('trims trailing slashes so paths never double up', async () => {
    const { bridgePortalUrl } = await load('https://bridge.example.com///');
    expect(bridgePortalUrl('/import')).toBe('https://bridge.example.com/import');
  });

  it('keeps a subpath mount', async () => {
    const { bridgePortalUrl } = await load('https://example.com/bridge/');
    expect(bridgePortalUrl('/import')).toBe('https://example.com/bridge/import');
  });

  // The value lands in an href, so a non-web scheme from a bad build arg would
  // be script injection. Treat it as "not configured" rather than rendering it.
  it.each(['javascript:alert(1)', 'data:text/html,x', 'not a url'])(
    'refuses %s',
    async (bad) => {
      const { bridgePortalUrl } = await load(bad);
      expect(bridgePortalUrl('/import')).toBeNull();
    },
  );
});

describe('ImportFromDiscordButton', () => {
  it('renders nothing when no portal is configured', async () => {
    const { ImportFromDiscordButton } = await load('');
    const { container } = wrap(<ImportFromDiscordButton />);
    expect(container).toBeEmptyDOMElement();
  });

  // It opens the in-app wizard now, so it must NOT be a link off-site.
  it('is an in-app button, not an external link', async () => {
    const { ImportFromDiscordButton } = await load('https://bridge.example.com');
    wrap(<ImportFromDiscordButton />);

    expect(screen.getByRole('button', { name: /import a discord server/i })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('DiscordBridgeSection', () => {
  it('renders nothing without manage rights', async () => {
    const { DiscordBridgeSection } = await load('https://bridge.example.com');
    const { container } = wrap(<DiscordBridgeSection canManage={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no portal is configured, even for a manager', async () => {
    const { DiscordBridgeSection } = await load('');
    const { container } = wrap(<DiscordBridgeSection canManage />);
    expect(container).toBeEmptyDOMElement();
  });

  // Managing existing bridges still lives on the portal, so this one stays a
  // real outbound link.
  it('states the encryption cost alongside the portal link', async () => {
    const { DiscordBridgeSection } = await load('https://bridge.example.com');
    wrap(<DiscordBridgeSection canManage />);

    expect(screen.getByText(/leaves end-to-end encryption/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /open bridge portal/i });
    expect(link).toHaveAttribute('href', 'https://bridge.example.com');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
