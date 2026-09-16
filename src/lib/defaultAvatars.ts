/**
 * The dozen pictures offered to somebody who has just made an account.
 *
 * They exist because the alternative first thing a new account does is
 * nothing: a profile with no picture is the one everybody has, and a wall of
 * grey circles is how a network looks empty. One tap is a low enough price for
 * a face, and the pictures are ordinary enough that nobody is stuck with a
 * personality they did not choose.
 *
 * These are Signal's, rendered out of the vector drawables in Signal-Android
 * (`res/drawable/ic_avatar_*.xml`) onto the pastel backgrounds its own
 * `AvatarColor` table pairs them with, in the order `Avatars.kt` lists them.
 *
 * LICENSING, because the files are not Soapbox's: Signal-Android is GPL-3.0,
 * which AGPL-3.0-or-later may be combined with — so the web and F-Droid builds
 * are fine. The STORE builds are the open question. They rest on the section 7
 * additional permission in the README's License section, and Soapbox can only
 * grant that for copyright it holds (see AGENTS.md: no copyleft artwork you
 * don't own may enter a store build unless its holder has granted the same
 * permission). Replacing these twelve files with art Soapbox owns, or getting
 * that permission, is the fix; the module boundary is here so that is a
 * one-directory change and nothing above it has to know.
 *
 * The file is the thing that gets uploaded, not a name Armada resolves later —
 * a `picture` pointing at armada.buzz would be a picture that dies with this
 * deployment, and on the native builds the path is `capacitor://localhost`,
 * which resolves for nobody but the device that wrote it. See
 * {@link defaultAvatarFile}.
 */
export interface DefaultAvatar {
  /** The file under `public/avatars`. */
  id: string;
  /** What it is a picture of — the label read out to a screen reader. */
  label: string;
}

export const DEFAULT_AVATARS: readonly DefaultAvatar[] = [
  { id: "abstract-01", label: "Green face" },
  { id: "abstract-02", label: "Blue face" },
  { id: "abstract-03", label: "Orange face" },
  { id: "cat", label: "Cat" },
  { id: "dog", label: "Dog" },
  { id: "fox", label: "Fox" },
  { id: "tucan", label: "Toucan" },
  { id: "sloth", label: "Sloth" },
  { id: "dinosaur", label: "Dinosaur" },
  { id: "pig", label: "Pig" },
  { id: "incognito", label: "Incognito" },
  { id: "ghost", label: "Ghost" },
];

/**
 * Where one of them lives in this build.
 *
 * A literal path built from an id, and the ids are the list above — this value
 * ends up in `src` and could end up in a CSS `url()`, so it may never be built
 * from anything that came off a relay.
 */
export function defaultAvatarUrl(id: string): string {
  return `/avatars/${id}.png`;
}

/**
 * Fetch one of these out of the app bundle as a file ready to upload.
 *
 * The picture has to leave Armada to be any use. A kind 0 naming a path on
 * whatever host this build was served from is a profile picture that works in
 * Armada and nowhere else, and on the APK/IPA the origin isn't even reachable
 * from another device. So the bytes are read back out of the bundle and pushed
 * to a Blossom server like any other upload, and what goes in the event is
 * that server's URL.
 */
export async function defaultAvatarFile(id: string): Promise<File> {
  const response = await fetch(defaultAvatarUrl(id));
  if (!response.ok) throw new Error(`No such avatar: ${id}`);
  const blob = await response.blob();
  return new File([blob], `${id}.png`, { type: "image/png" });
}
