/**
 * The pictures offered to somebody who has just made an account.
 *
 * They exist because the alternative first thing a new account does is
 * nothing: a profile with no picture is the one everybody has, and a wall of
 * grey circles is how a network looks empty. One tap is a low enough price for
 * a face, and the pictures are ordinary enough that nobody is stuck with a
 * personality they did not choose.
 *
 * Every one of them is a URL on a Blossom server and nothing else. No picture
 * here is in the bundle, in this repository, or in its history, and choosing
 * one moves no bytes: the URL is what goes into the kind 0 verbatim. The
 * alternative — a file under `public/avatars`, uploaded to the new account's
 * own Blossom server at signup — is what this used to be, and it made a copy
 * of every preset in the app, in git forever, and on whatever server each new
 * account happened to be pointed at.
 *
 * What that costs, and it is worth naming: a published `picture` now points at
 * a blob nobody but its host is keeping. If one is dropped there, every
 * profile that chose it loses its picture, where a copy on the user's own
 * server would have survived. Inside Armada a miss is retried against the
 * user's Blossom servers by hash ({@link Avatar}'s source walk, which is why
 * these must stay content-addressed URLs — the hash IS the recovery); in
 * another client it is an ordinary URL on a host Soapbox runs.
 *
 * The ones with an artist in the `label` were submitted, and they lead the
 * list. The `PLACEHOLDER` rows behind them are Signal's, rendered out of the
 * vector drawables in Signal-Android (`res/drawable/ic_avatar_*.xml`) onto the
 * pastel backgrounds its own `AvatarColor` table pairs them with, in the order
 * `Avatars.kt` lists them, and they are being replaced one at a time as
 * artwork comes in.
 *
 * LICENSING, because those are not Soapbox's: Signal-Android is GPL-3.0, which
 * AGPL-3.0-or-later may be combined with — so the web and F-Droid builds were
 * always fine, and no build contains the artwork at all now that these are
 * links. That is not the whole of the question the STORE builds raise, which
 * rests on the section 7 additional permission in the README's License section
 * and which Soapbox can only grant for copyright it holds (see AGENTS.md: no
 * copyleft artwork you don't own may enter a store build unless its holder has
 * granted the same permission): the app still offers Signal's pictures as its
 * own presets and Soapbox still hosts them. Replacing the placeholders with
 * art Soapbox has permission for is the fix, as it always was.
 */
export interface DefaultAvatar {
  /**
   * Which one was picked.
   *
   * A name for the choice, not for a file — swapping the picture behind a row
   * keeps the id, and nothing resolves anything by it.
   */
  id: string;
  /**
   * The picture, and the profile picture it becomes.
   *
   * It ends up in `src`, could end up in a CSS `url()`, and is published as
   * somebody's `picture` — so every one of them is written down here, and none
   * may ever come off a relay.
   */
  url: string;
  /**
   * What it is a picture of, and who drew it where that is known — the label
   * read out to a screen reader, and the one shown on hover. Nothing renders
   * it as ordinary text, so it is the only place the credit appears.
   */
  label: string;
}

const BLOSSOM = "https://blossom.ditto.pub";

export const DEFAULT_AVATARS: readonly DefaultAvatar[] = [
  {
    id: "tucan",
    url: `${BLOSSOM}/e1fbf54bcf436a8a386998365f203709b903a30449aaf59e5f80a7ac203d2166.png`,
    label: "Toucan by eempo",
  },
  {
    id: "dragon",
    url: `${BLOSSOM}/249ab58208fc33c559b240db3bfa601b6fd7e9f15cabd9aac15ac0b22df5a6f1.png`,
    label: "Dragon by gravestoneghost",
  },
  {
    id: "skull",
    url: `${BLOSSOM}/e3fe43939426e06bdd609cdafe791f126129285daaacafe659af4c67ba99da1a.jpeg`,
    label: "Skull by Julian Cela",
  },
  {
    id: "banana-king",
    url: `${BLOSSOM}/a4a82e86634d19798a4802213cb11a3b1952cd8231f4617c46eddc3ff9003b68.jpeg`,
    label: "Banana King by Aiden J arts",
  },
  // PLACEHOLDER rows, replace with artist submissions.
  {
    id: "abstract-02",
    url: `${BLOSSOM}/db56be2f909e0e82a95e35609ca6d32f4786a842fda37bfae3fd6455dec9ffc6.png`,
    label: "Blue face",
  },
  {
    id: "abstract-03",
    url: `${BLOSSOM}/59d9e73efde780b438c2d3b76f07b7a74437782abf72b9cfc46384bff55b2872.png`,
    label: "Orange face",
  },
  {
    id: "cat",
    url: `${BLOSSOM}/148408b075188b381df1450bb89b72d5b476c9d2422ab6197ee5d3fd93560357.png`,
    label: "Cat",
  },
  {
    id: "dog",
    url: `${BLOSSOM}/a50dc355d552183b8a7792bcd455b3d1c6e6e8e9b482d3187595b9eb353e8faa.png`,
    label: "Dog",
  },
  {
    id: "fox",
    url: `${BLOSSOM}/0d5495d30a971d7703cf2492e548d7c9639aa605b3b49a6c24ada8e50ad15118.png`,
    label: "Fox",
  },
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
