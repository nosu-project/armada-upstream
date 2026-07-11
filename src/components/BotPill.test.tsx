import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BotPill } from './BotPill';

import type { AuthorResult } from '@/hooks/useAuthor';

// Controllable stand-in for what useAuthor resolves for a given pubkey.
const authorData = vi.hoisted(() => ({ current: undefined as AuthorResult | undefined }));
vi.mock('@/hooks/useAuthor', () => ({
  useAuthor: (pubkey?: string) => ({ data: pubkey ? authorData.current : undefined }),
}));

describe('BotPill', () => {
  it('renders the pill when the resolved metadata declares bot: true', () => {
    authorData.current = { metadata: { bot: true } };
    render(<BotPill pubkey="abc" />);
    expect(screen.getByText('Bot')).toBeInTheDocument();
    expect(screen.getByTitle('Bot account')).toBeInTheDocument();
  });

  it('renders nothing when the profile omits the bot flag', () => {
    authorData.current = { metadata: { name: 'Alice' } };
    const { container } = render(<BotPill pubkey="abc" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when bot is explicitly false', () => {
    authorData.current = { metadata: { bot: false } };
    const { container } = render(<BotPill pubkey="abc" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the profile is unknown', () => {
    authorData.current = undefined;
    const { container } = render(<BotPill pubkey="abc" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('uses the metadata prop directly, ignoring the looked-up profile', () => {
    // Would resolve to false if it consulted useAuthor — proves the prop wins.
    authorData.current = { metadata: { bot: false } };
    render(<BotPill pubkey="abc" metadata={{ bot: true }} />);
    expect(screen.getByText('Bot')).toBeInTheDocument();
  });
});
