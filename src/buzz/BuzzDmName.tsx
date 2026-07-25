import { DisplayName } from "@/components/DisplayName";

/**
 * The display title of a Buzz DM channel: the OTHER participants' names,
 * comma-separated (a Buzz DM is a hidden NIP-29 channel whose 39000 carries
 * no useful name — the roster is the identity). Falls back to "Direct message"
 * while the roster resolves.
 */
export function BuzzDmName({
  members,
  selfPubkey,
  max = 3,
}: {
  members: string[];
  selfPubkey: string | undefined;
  max?: number;
}) {
  const others = members.filter((m) => m !== selfPubkey);
  // A self-DM ("notes to self") has only the viewer in it.
  const list = others.length > 0 ? others : selfPubkey ? [selfPubkey] : [];
  if (list.length === 0) return <>Direct message</>;
  const shown = list.slice(0, max);
  return (
    <>
      {shown.map((pk, i) => (
        <span key={pk}>
          {i > 0 && ", "}
          <DisplayName pubkey={pk} />
        </span>
      ))}
      {list.length > shown.length && <> +{list.length - shown.length}</>}
    </>
  );
}
