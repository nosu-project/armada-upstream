import { describe, expect, it } from 'vitest';

import { parseProxyTag } from './nip48';

describe('parseProxyTag', () => {
  it('names known web bridges and keeps the permalink', () => {
    const url =
      'https://discord.com/channels/1531372982646210760/1531372983388737759/1531414269244211270';
    expect(parseProxyTag([['proxy', url, 'web']])).toEqual({
      marker: 'web',
      label: 'Discord',
      url,
      host: 'discord.com',
    });
  });

  it('falls back to the hostname for other web bridges', () => {
    const proxy = parseProxyTag([['proxy', 'https://www.example.com/posts/1', 'web']]);
    expect(proxy?.label).toBe('example.com');
    expect(proxy?.host).toBe('example.com');
  });

  it('labels the protocols NIP-48 names', () => {
    expect(parseProxyTag([['proxy', 'at://did:plc:abc/app.bsky.feed.post/1', 'atproto']])).toEqual({
      marker: 'atproto',
      label: 'ATProto',
      url: undefined,
      host: undefined,
    });
    expect(
      parseProxyTag([['proxy', 'https://mastodon.social/@alice/1', 'activitypub']]),
    ).toMatchObject({ label: 'ActivityPub', url: 'https://mastodon.social/@alice/1' });
    expect(parseProxyTag([['proxy', 'https://example.com/feed.xml', 'rss']])).toMatchObject({
      label: 'RSS',
    });
  });

  it('uses an unrecognized marker as the label', () => {
    expect(parseProxyTag([['proxy', 'xmpp:room@chat.example.com', 'xmpp']])).toMatchObject({
      marker: 'xmpp',
      label: 'xmpp',
      url: undefined,
    });
  });

  it('skips tags missing an id or a marker', () => {
    expect(parseProxyTag([['proxy']])).toBeNull();
    expect(parseProxyTag([['proxy', 'https://example.com/1']])).toBeNull();
    expect(parseProxyTag([['proxy', '  ', 'web']])).toBeNull();
    expect(parseProxyTag([['proxy', 'https://example.com/1', ' ']])).toBeNull();
  });

  it('skips web proxies whose id is not an http(s) URL', () => {
    // The URL is the only thing naming the service — without it there's nothing
    // to put on the badge.
    expect(parseProxyTag([['proxy', 'not-a-url', 'web']])).toBeNull();
    expect(parseProxyTag([['proxy', 'ftp://example.com/x', 'web']])).toBeNull();
  });

  it('ignores non-proxy tags and returns the first usable proxy', () => {
    expect(
      parseProxyTag([
        ['e', 'abc'],
        ['proxy', 'bogus', 'web'],
        ['proxy', 'https://example.com/1', 'web'],
        ['proxy', 'https://other.example/2', 'web'],
      ])?.host,
    ).toBe('example.com');
    expect(parseProxyTag([['e', 'abc']])).toBeNull();
  });
});
