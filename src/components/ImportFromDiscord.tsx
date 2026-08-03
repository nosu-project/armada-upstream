import { ExternalLink } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { bridgePortalUrl } from "@/lib/platform";
import { cn } from "@/lib/utils";

// The wizard pulls in the whole bridge API client and its step UI; nobody who
// never clicks "import" should pay for that chunk.
const DiscordImportWizard = lazy(() =>
  import("@/components/discord-import/DiscordImportWizard").then((m) => ({
    default: m.DiscordImportWizard,
  })),
);

/**
 * Entry points into the Discord bridge portal (`armada-discord-bridge`).
 *
 * None of the work happens here. The portal is a separate service that holds
 * the Discord OAuth application and bot token; Armada's whole job is to offer
 * the door and be accurate about where it leads. Every export renders `null`
 * when `VITE_BRIDGE_PORTAL_URL` is unset, so builds with no portal to point at
 * (the APK, the desktop app, forks, `npm run dev`) carry no Discord UI at all.
 *
 * What the user gets on the other side: they sign in with Discord, pick a
 * server they administer, and the portal mints a Concord community from its
 * channels and history — signed with *their own* Nostr key, so they own it —
 * then hands back an ordinary invite link. That link comes home through the
 * same paste field as any other invite; there is no private channel between
 * Armada and the portal.
 */

/** The Discord wordmark glyph. lucide dropped brand icons, so it's inlined. */
export function DiscordMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

/**
 * "Import a Discord server" — opens the in-app import wizard.
 *
 * Renders nothing when this build has no portal configured, so call sites can
 * drop it in unconditionally. A signed-out visitor is sent to the welcome page
 * first (the flow signs founding events, so it needs a key), matching what the
 * create-community tile does.
 */
export function ImportFromDiscordButton({
  className,
  variant = "outline",
  size,
}: {
  className?: string;
  variant?: "outline" | "secondary" | "ghost";
  size?: "sm" | "lg";
}) {
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const configured = Boolean(bridgePortalUrl("/import"));

  if (!configured) return null;

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={cn("w-full clip-corner-lg", className)}
        onClick={() => (user ? setOpen(true) : navigate("/welcome"))}
      >
        <DiscordMark className="size-4 shrink-0" />
        Import a Discord server
      </Button>
      {open && (
        <Suspense fallback={null}>
          <DiscordImportWizard onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

/**
 * The bridge section of a community's settings, for members who can manage it.
 *
 * Deliberately states the encryption cost up front rather than in a tooltip: a
 * bridged channel is readable in plaintext on Discord's servers, which is the
 * one thing a Concord owner must understand before setting one up. The portal
 * asks for explicit consent too — saying it twice is the right amount.
 */
export function DiscordBridgeSection({ canManage }: { canManage: boolean }) {
  const href = bridgePortalUrl("/");
  if (!href || !canManage) return null;

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Discord bridge
      </span>
      <div className="space-y-2.5 rounded-lg bg-secondary/40 p-3">
        <p className="text-xs text-muted-foreground">
          Mirror a channel to a Discord server, or import one into Armada. Set up
          and managed in the bridge portal with your Discord account.
        </p>
        <p className="text-xs text-muted-foreground">
          A bridged channel leaves end-to-end encryption: everything posted in it
          is readable in plaintext on Discord's servers. Unbridged channels are
          unaffected.
        </p>
        <Button asChild variant="outline" size="sm" className="clip-corner-lg">
          <a href={href} target="_blank" rel="noopener noreferrer">
            <DiscordMark className="size-4 shrink-0" />
            Open bridge portal
            <ExternalLink className="size-3.5 shrink-0 opacity-60" />
          </a>
        </Button>
      </div>
    </div>
  );
}
