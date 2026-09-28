/**
 * The dozen preset pictures offered to a new account. Exactly twelve (pinned
 * in `ProfileStep.test.tsx`): a new picture DISPLACES a placeholder.
 *
 * Each is a content-addressed Blossom URL written verbatim into kind 0 — no
 * bytes in the bundle or repo. If the host drops one, Armada recovers it by
 * hash from the user's Blossom servers ({@link Avatar}), so keep them
 * content-addressed.
 *
 * Artist submissions lead; the `PLACEHOLDER` rows are Signal's
 * (Signal-Android `ic_avatar_*` on its `AvatarColor` pastels) and get replaced
 * one at a time.
 *
 * LICENSING: Signal-Android is GPL-3.0. Store builds rely on the README's
 * section 7 permission, which Soapbox can only grant for copyright it holds
 * (see AGENTS.md), so the placeholders must be replaced with art Soapbox has
 * permission for.
 */
export interface DefaultAvatar {
  /** Names the choice, not the file; nothing resolves by it. */
  id: string;
  /** Hard-coded here only — never from a relay (it lands in `src`/`url()` and kind 0). */
  url: string;
  /** Subject and artist credit: screen-reader label and hover text (the only credit shown). */
  label: string;
}

const BLOSSOM = "https://blossom.ditto.pub";

export const DEFAULT_AVATARS: readonly DefaultAvatar[] = [
  {
    id: "banana-king",
    url: `${BLOSSOM}/a4a82e86634d19798a4802213cb11a3b1952cd8231f4617c46eddc3ff9003b68.jpeg`,
    label: "Banana King by Aiden J arts",
  },
  {
    id: "tucan",
    url: `${BLOSSOM}/e1fbf54bcf436a8a386998365f203709b903a30449aaf59e5f80a7ac203d2166.png`,
    label: "Toucan by eempo",
  },
  {
    id: "skull",
    url: `${BLOSSOM}/e3fe43939426e06bdd609cdafe791f126129285daaacafe659af4c67ba99da1a.jpeg`,
    label: "Skull by Julian Cela",
  },
  {
    id: "dragon",
    url: `${BLOSSOM}/249ab58208fc33c559b240db3bfa601b6fd7e9f15cabd9aac15ac0b22df5a6f1.png`,
    label: "Dragon by gravestoneghost",
  },
  {
    id: "skull-bw",
    url: `${BLOSSOM}/efce6e73cfc8ee57eb2492c0dfefa091a643c4a0aaeb732bcdfe3d742e465d4d.png`,
    label: "B&W Skull by collegeartist1",
  },
  {
    id: "gamer-kitty",
    url: `${BLOSSOM}/fe80167b2ff4f1344bad29b2d429ceee3e448d087be053dabe0eae81e68ccd33.png`,
    label: "Gamer Kitty by dudsflausino",
  },
  {
    id: "agent-flower",
    url: `${BLOSSOM}/836dd87cc9d92ba2411ee1574f60825e23733aca2406ed20c735e19486e49222.png`,
    label: "Agent Flower by Milo",
  },
  {
    id: "hatcat",
    url: `${BLOSSOM}/d44ab1328a81e0d958fd7ccab38bf39de87e2b3b945483c25d2a2295be8c1f30.jpeg`,
    label: "Hatcat by xaibott",
  },
  // PLACEHOLDER rows, replace with artist submissions.
  {
    id: "sloth",
    url: `${BLOSSOM}/dcaec4220f3af5b7dd18df1801b7daaabb41f3835f50bb2041db61d1d162975a.png`,
    label: "Sloth",
  },
  {
    id: "dinosaur",
    url: `${BLOSSOM}/059741915d1c4bd314c2fac070e88b30e39191b968aef21b95afbad77d62fc13.png`,
    label: "Dinosaur",
  },
  {
    id: "pig",
    url: `${BLOSSOM}/acb67a9a7cdaf3899920fb38e9c4a464e30b81226216f9c7e8981fbeb5718554.png`,
    label: "Pig",
  },
  {
    id: "incognito",
    url: `${BLOSSOM}/8824ab40bd276a02e32cc3d76f44f908c1038d6fb7da5b5f6a8a59b5a5974df8.png`,
    label: "Incognito",
  },
];
