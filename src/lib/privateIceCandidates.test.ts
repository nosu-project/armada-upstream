import { describe, expect, it, vi } from "vitest";

const added: unknown[] = [];
const remote: unknown[] = [];
const configs: Array<RTCConfiguration | undefined> = [];
class FakePeerConnection {
  constructor(config?: RTCConfiguration) {
    configs.push(config);
  }
  setConfiguration(config?: RTCConfiguration) {
    configs.push(config);
  }
  addIceCandidate(c?: unknown) {
    added.push(c);
    return Promise.resolve();
  }
  setRemoteDescription(d: unknown) {
    remote.push(d);
    return Promise.resolve();
  }
}
vi.stubGlobal("RTCPeerConnection", FakePeerConnection);

const {
  candidateAddress,
  iceServerHost,
  ignorePrivateCandidatesFrom,
  isPrivateHost,
  isPublicServer,
  stripPrivateCandidates,
  stripPrivateIceServers,
} = await import("@/lib/privateIceCandidates");

const servers: RTCIceServer[] = [
  { urls: ["turn:68.183.162.136:3478?transport=udp", "turn:10.0.0.1:3478"], username: "u", credential: "c" },
  { urls: "turns:[fd00::1]:5349" },
  { urls: "stun:stun.example.com:19302" },
];

const cand = (addr: string, port = 7882) => `candidate:1 1 udp 2130706431 ${addr} ${port} typ host generation 0`;

describe("isPrivateHost", () => {
  it.each([
    "10.0.0.1", "172.16.0.5", "172.31.255.1", "192.168.1.8", "127.0.0.1", "169.254.1.1",
    "100.64.0.1", "100.127.1.1", "0.0.0.0", "::1", "fd6f:3788::1", "fc00::1", "fe80::1%eth0",
    "[fe80::1]", "::ffff:10.0.0.1", "localhost", "sfu.local", "box.lan", "x.home.arpa", "sfu",
  ])("%s is private", (h) => expect(isPrivateHost(h)).toBe(true));

  it.each([
    "68.183.162.136", "172.32.0.1", "100.128.0.1", "8.8.8.8", "2a02:8388::1",
    "::ffff:8.8.8.8", "av.armada.buzz",
  ])("%s is public", (h) => expect(isPrivateHost(h)).toBe(false));
});

describe("isPublicServer", () => {
  it("judges the server by its own URL", () => {
    expect(isPublicServer("wss://av.armada.buzz")).toBe(true);
    expect(isPublicServer("wss://68.183.162.136:7880")).toBe(true);
    expect(isPublicServer("ws://localhost:7880")).toBe(false);
    expect(isPublicServer("ws://192.168.1.20:7880")).toBe(false);
    expect(isPublicServer("wss://[fd00::2]")).toBe(false);
    expect(isPublicServer("not a url")).toBe(false);
  });
});

describe("candidate parsing", () => {
  it("reads the address of a candidate line, with or without the SDP prefix", () => {
    expect(candidateAddress(cand("10.0.0.1"))).toBe("10.0.0.1");
    expect(candidateAddress(`a=${cand("68.183.162.136")}`)).toBe("68.183.162.136");
    expect(candidateAddress("")).toBeUndefined();
  });

  it("strips only private candidate lines from an SDP", () => {
    const sdp = ["v=0", `a=${cand("68.183.162.136")}`, `a=${cand("10.0.0.1")}`, "a=mid:0", ""].join("\r\n");
    expect(stripPrivateCandidates(sdp)).toBe(["v=0", `a=${cand("68.183.162.136")}`, "a=mid:0", ""].join("\r\n"));
  });
});

describe("ICE server URLs", () => {
  it("reads the host of stun/turn URLs", () => {
    expect(iceServerHost("turn:10.0.0.1:3478?transport=udp")).toBe("10.0.0.1");
    expect(iceServerHost("turns:[fd00::1]:5349")).toBe("fd00::1");
    expect(iceServerHost("stun:stun.example.com")).toBe("stun.example.com");
    expect(iceServerHost("https://x")).toBeUndefined();
  });

  it("drops private URLs, and entries left with none", () => {
    expect(stripPrivateIceServers(servers)).toEqual([
      { urls: ["turn:68.183.162.136:3478?transport=udp"], username: "u", credential: "c" },
      { urls: ["stun:stun.example.com:19302"] },
    ]);
  });
});

describe("ignorePrivateCandidatesFrom", () => {
  it("drops a public server's private TURN/STUN servers at construction and reconfiguration", () => {
    const release = ignorePrivateCandidatesFrom("wss://av.armada.buzz");
    configs.length = 0;
    const pc = new RTCPeerConnection({ iceServers: servers });
    pc.setConfiguration({ iceServers: servers });
    for (const config of configs) {
      expect(config?.iceServers?.flatMap((s) => s.urls)).toEqual([
        "turn:68.183.162.136:3478?transport=udp",
        "stun:stun.example.com:19302",
      ]);
    }
    expect(configs).toHaveLength(2);
    release();

    configs.length = 0;
    new RTCPeerConnection({ iceServers: servers });
    expect(configs[0]?.iceServers).toBe(servers);
  });

  it("drops a public server's private candidates only while held", async () => {
    const pc = new RTCPeerConnection();
    const release = ignorePrivateCandidatesFrom("wss://av.armada.buzz");

    added.length = 0;
    await pc.addIceCandidate({ candidate: cand("10.0.0.1"), sdpMid: "0" });
    await pc.addIceCandidate({ candidate: cand("68.183.162.136"), sdpMid: "0" });
    await pc.addIceCandidate({ candidate: "", sdpMid: "0" }); // end of candidates
    expect(added.map((c) => (c as RTCIceCandidateInit).candidate)).toEqual([cand("68.183.162.136"), ""]);

    remote.length = 0;
    await pc.setRemoteDescription({ type: "answer", sdp: `a=${cand("192.168.0.2")}\r\na=mid:0\r\n` });
    expect(remote).toEqual([{ type: "answer", sdp: "a=mid:0\r\n" }]);

    release();
    release(); // idempotent
    added.length = 0;
    await pc.addIceCandidate({ candidate: cand("10.0.0.1"), sdpMid: "0" });
    expect(added).toHaveLength(1);
  });

  it("leaves a private server's candidates alone", async () => {
    const pc = new RTCPeerConnection();
    const release = ignorePrivateCandidatesFrom("ws://192.168.1.20:7880");
    added.length = 0;
    await pc.addIceCandidate({ candidate: cand("192.168.1.20"), sdpMid: "0" });
    expect(added).toHaveLength(1);
    release();
  });
});
