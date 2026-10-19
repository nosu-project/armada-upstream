import { DisplayName } from "@/components/DisplayName";
import { FormattedMessage } from "@/i18n";

/**
 * A Buzz DM's title: the other participants' names (its 39000 carries no
 * useful name). Falls back to "Direct message" while the roster resolves.
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
  const list = others.length > 0 ? others : selfPubkey ? [selfPubkey] : [];
  if (list.length === 0) return <FormattedMessage id="buzzDmName.fallback" defaultMessage="Direct message" />;
  const shown = list.slice(0, max);
  return (
    <>
      {shown.map((pk, i) => (
        <span key={pk}>
          {i > 0 && ", "}
          <DisplayName pubkey={pk} />
        </span>
      ))}
      {list.length > shown.length && (
        <FormattedMessage id="buzzDmName.more" defaultMessage=" +{count}" values={{ count: list.length - shown.length }} />
      )}
    </>
  );
}
