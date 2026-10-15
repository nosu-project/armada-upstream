import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StaffPill } from '@/components/StaffPill';
import { MemberRolesContext, type MemberRolesValue, type StaffTier } from '@/contexts/MemberRolesContext';

function scope(tiers: Record<string, StaffTier>): MemberRolesValue {
  return { rolesOf: () => [], staffTierOf: (pk) => tiers[pk] };
}

describe('StaffPill', () => {
  it('labels each staff tier', () => {
    const value = scope({ a: 'owner', b: 'admin', c: 'moderator' });
    render(
      <MemberRolesContext.Provider value={value}>
        <StaffPill pubkey="a" />
        <StaffPill pubkey="b" />
        <StaffPill pubkey="c" />
        <StaffPill pubkey="d" />
      </MemberRolesContext.Provider>,
    );
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Mod')).toBeInTheDocument();
    expect(screen.getAllByTitle(/^Community /)).toHaveLength(3);
  });

  it('renders nothing outside a community scope', () => {
    const { container } = render(<StaffPill pubkey="a" />);
    expect(container).toBeEmptyDOMElement();
  });
});
