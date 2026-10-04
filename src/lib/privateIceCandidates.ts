/**
 * Ignore private-address ICE candidates and TURN/STUN servers offered by a
 * PUBLIC voice server. An SFU advertises every interface it binds, and probing
 * them makes callers scan their own LAN (flagged by firewalls and OS privacy
 * prompts) for addresses a public server is never reachable on. A server whose
 * own URL is private keeps them all.
 */

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  return out.every((n) => n >= 0 && n <= 255) ? out : null;
}

function privateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, also Tailscale
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Whether `host` (an IP literal or hostname) names a local or private address. */
export function isPrivateHost(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  if (!host) return false;

  const v4 = parseIpv4(host);
  if (v4) return privateIpv4(v4);

  if (host.includes(":")) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) {
      const m = parseIpv4(mapped[1]);
      return m ? privateIpv4(m) : false;
    }
    if (host === "::" || host === "::1") return true;
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // ULA, link-local
  }

  // mDNS and reserved private-use names resolve only on the local network.
  return (
    host === "localhost" ||
    /\.(localhost|local|lan|home\.arpa|internal)$/.test(host) ||
    !host.includes(".")
  );
}

/** Whether a voice server URL points at the public internet. */
export function isPublicServer(url: string): boolean {
  try {
    return !isPrivateHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The connection address of an ICE candidate line (`candidate:… <address> <port> typ …`). */
export function candidateAddress(candidate: string): string | undefined {
  const fields = candidate.replace(/^a=/, "").trim().split(/\s+/);
  return fields[0]?.startsWith("candidate:") ? fields[4] : undefined;
}

function isPrivateCandidate(candidate: string): boolean {
  const address = candidateAddress(candidate);
  return address !== undefined && isPrivateHost(address);
}

/** `sdp` without its private-address candidate lines. */
export function stripPrivateCandidates(sdp: string): string {
  return sdp
    .split(/(?<=\r?\n)/)
    .filter((line) => !(line.startsWith("a=candidate:") && isPrivateCandidate(line)))
    .join("");
}

/** The host of a `stun:`/`turn:`/`turns:` URL (RFC 7064/7065), brackets kept off IPv6. */
export function iceServerHost(url: string): string | undefined {
  const m = /^(?:stuns?|turns?):(\[[^\]]+\]|[^:?/]+)/i.exec(url.trim());
  return m ? m[1].replace(/^\[|\]$/g, "") : undefined;
}

/** `servers` without the URLs on private hosts; an entry left with none is dropped. */
export function stripPrivateIceServers(servers: RTCIceServer[]): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  for (const server of servers) {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((u) => {
      const host = iceServerHost(u);
      return host === undefined || !isPrivateHost(host);
    });
    if (urls.length) out.push({ ...server, urls });
  }
  return out;
}

function guardConfig(config: RTCConfiguration | undefined): RTCConfiguration | undefined {
  if (activeGuards === 0 || !config?.iceServers) return config;
  return { ...config, iceServers: stripPrivateIceServers(config.iceServers) };
}

let activeGuards = 0;
let installed = false;

function install(): void {
  if (installed || typeof RTCPeerConnection === "undefined") return;
  installed = true;

  // The constructor takes the server's TURN/STUN list, so the global is
  // replaced; LiveKit resolves `RTCPeerConnection` at construction time.
  const Native = RTCPeerConnection;
  const Guarded = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(guardConfig(config));
    }
  };
  globalThis.RTCPeerConnection = Guarded as typeof RTCPeerConnection;

  const proto = Native.prototype;

  const setConfiguration = proto.setConfiguration;
  proto.setConfiguration = function (this: RTCPeerConnection, config?: RTCConfiguration) {
    return setConfiguration.call(this, guardConfig(config));
  };

  const addIceCandidate = proto.addIceCandidate;
  proto.addIceCandidate = function (this: RTCPeerConnection, ...args: unknown[]) {
    const c = args[0] as RTCIceCandidateInit | null | undefined;
    if (activeGuards > 0 && typeof c?.candidate === "string" && isPrivateCandidate(c.candidate)) {
      return Promise.resolve();
    }
    return (addIceCandidate as (...a: unknown[]) => Promise<void>).apply(this, args);
  } as typeof proto.addIceCandidate;

  const setRemoteDescription = proto.setRemoteDescription;
  proto.setRemoteDescription = function (this: RTCPeerConnection, ...args: unknown[]) {
    const desc = args[0] as RTCSessionDescriptionInit | undefined;
    if (activeGuards > 0 && desc?.sdp) {
      args[0] = { type: desc.type, sdp: stripPrivateCandidates(desc.sdp) };
    }
    return (setRemoteDescription as (...a: unknown[]) => Promise<void>).apply(this, args);
  } as typeof proto.setRemoteDescription;
}

/**
 * While the returned release is unheld, drop private candidates from every peer
 * connection if `serverUrl` is public; a no-op for a private server. Global on
 * purpose: LiveKit builds its peer connections internally, and voice is the
 * only WebRTC in the page.
 */
export function ignorePrivateCandidatesFrom(serverUrl: string): () => void {
  if (!isPublicServer(serverUrl)) return () => {};
  install();
  activeGuards++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeGuards--;
  };
}
