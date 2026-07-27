import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProxyPill } from './ProxyPill';

import { parseProxyTag } from '@/lib/nip48';

// Radix positions the popover with floating-ui, which calls
// `new ResizeObserver`; the global test stub is an arrow fn and can't be
// constructed.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const discord = parseProxyTag([
  [
    'proxy',
    'https://discord.com/channels/1531372982646210760/1531372983388737759/1531414269244211270',
    'web',
  ],
]);

describe('ProxyPill', () => {
  it('renders nothing without a proxy', () => {
    const { container } = render(<ProxyPill proxy={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links the origin in the popover when the proxy id is a URL', async () => {
    render(<ProxyPill proxy={discord} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discord' }));

    const link = await screen.findByRole('link', { name: 'Discord' });
    expect(screen.getByText(/Bridged from/)).toBeInTheDocument();
    expect(link).toHaveAttribute('href', discord?.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows the protocol as plain text when there is nothing to open', async () => {
    render(<ProxyPill proxy={parseProxyTag([['proxy', 'at://did:plc:abc/post/1', 'atproto']])} />);
    fireEvent.click(screen.getByRole('button', { name: 'ATProto' }));

    expect(await screen.findByText(/Bridged from/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
