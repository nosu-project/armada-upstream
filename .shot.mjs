import { chromium } from "playwright";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
const sk = generateSecretKey(); const pk = getPublicKey(sk);
const b = await chromium.launch({ args: ["--single-process"] });
const p = await b.newPage({ viewport: { width: 390, height: 800 } });
p.on("pageerror", (e) => console.log("ERR", e.message));
await p.addInitScript(([j, pk]) => { localStorage.setItem("armada:login", j); localStorage.setItem("armada:active-pubkey", pk); localStorage.setItem(`armada:relay-prompt-shown:${pk}`, "1"); },
  [JSON.stringify([{ id: `nsec:${pk}`, type: "nsec", pubkey: pk, createdAt: new Date().toISOString(), data: { nsec: nip19.nsecEncode(sk) } }]), pk]);
await p.goto("http://localhost:8083/settings");
await p.waitForTimeout(8000); await p.screenshot({ path: "/tmp/armada-shot/pre.png" }); console.log(p.url());
await p.screenshot({ path: "/tmp/armada-shot/0.png" });
for (const [i, q] of [["1", "noise"], ["3", "qqqzz"]]) {
  await p.fill('input[aria-label="Search settings"]', q);
  await p.waitForTimeout(800);
  await p.screenshot({ path: `/tmp/armada-shot/m${i}.png` });
}
await p.press('input[aria-label="Search settings"]', "Escape");
await p.waitForTimeout(500);
await p.screenshot({ path: "/tmp/armada-shot/4.png" });
await b.close();
