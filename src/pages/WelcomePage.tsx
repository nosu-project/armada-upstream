import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { LandingPage } from "@/components/landing/LandingPage";
import { lazyWithReload } from "@/lib/chunkReload";
import { peekPendingJoin } from "@/lib/joinLink";

/**
 * The signed-out landing surface — the marketing deck over the ASCII sea, plus
 * the two things it can open: the login dialog and the account wizard.
 *
 * This module is deliberately EAGER: it is statically imported by `AppRouter`
 * so it lands in the entry chunk and paints on the same tick React mounts,
 * with no second network round trip. That is the whole point of the file's
 * shape — a signed-out visitor at `/` is the one person who has downloaded the
 * bundle and wants exactly one screen out of it.
 *
 * Everything reachable FROM here is therefore lazy, because none of it is on
 * that first frame:
 *
 *  - {@link LoginScreen} pulls qrcode, the NIP-46 handshake and the Android
 *    signer enumeration. It arrives on the Join tap.
 *  - `SignupWizard` pulls nostr-tools, the login actions and the whole
 *    `ProfileSettings` editor. It arrives on "Create account" — or immediately
 *    when a `/join` referral link is pending, since that link's confirmation
 *    screen IS the wizard's first step.
 *
 * Both are warmed at idle below, so the tap is instant in practice while the
 * first paint still costs nothing.
 *
 * Signed-in users never render this: `HomeRedirect` in `AppRouter` owns that
 * decision and only reaches here while signed out, or while the wizard is
 * mid-flight (it logs the user in at step 2 and keeps going — see
 * `useOnboardingActive`).
 */

const LoginScreen = lazy(lazyWithReload(() => import("@/components/auth/LoginScreen")));

const SignupWizard = lazy(
  lazyWithReload(() => import("@/pages/SignupWizard").then((m) => ({ default: m.SignupWizard }))),
);

export function WelcomePage() {
  // The landing's scroll container. The ASCII sea reads its scrollTop inside
  // its own animation frame, so this is passed down rather than lifted into
  // state — scrolling the landing must not re-render this page.
  const landingScrollRef = useRef<HTMLElement>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  // Latches on the first open. The dialog owns its own visibility through
  // `isOpen`, so unmounting it on close would only throw away a chunk we have
  // already paid for.
  const [loginMounted, setLoginMounted] = useState(false);
  // A pending `/join` referral link starts the wizard straight away: its named
  // confirmation screen is the wizard's own first step, so there is no landing
  // to show first.
  const [wizardActive, setWizardActive] = useState(() => !!peekPendingJoin());

  const openLogin = () => {
    setLoginMounted(true);
    setJoinOpen(true);
  };

  // Warm both branches off the critical path, once the landing has painted.
  // Same bargain as `useWarmRouteChunks`: small first frame AND an instant tap.
  useEffect(() => {
    const timer = setTimeout(() => {
      void import("@/components/auth/LoginScreen").catch(() => undefined);
      void import("@/pages/SignupWizard").catch(() => undefined);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  if (wizardActive) {
    // No fallback chrome: the wizard is a full-screen takeover on the same
    // background, so a spinner between the tap and the chunk would be a flash
    // of nothing. The landing stays on screen for the moment it takes.
    return (
      <Suspense fallback={null}>
        <SignupWizard onExit={() => setWizardActive(false)} />
      </Suspense>
    );
  }

  // ── Signed-out landing ──────────────────────────────────────────────────
  // The marketing surface lives in {@link LandingPage}: a scrolling deck over
  // the ASCII sea. `<main>` is the scroll container, and the sea reads its
  // scrollTop directly, so the ref has to be handed down.
  //
  // `h-full w-full`, not `flex-1 min-w-0`: this used to be a child of
  // MainLayout's `flex h-full` row (CallProvider's shell), which is what gave
  // `flex-1` a height to fill. Outside the frame there is no flex parent — the
  // element is a direct child of `#root` (`height: 100%`) — so it has to size
  // itself, or `overflow-y-auto` never forms a scroll box and the sea, which
  // animates off this element's `scrollTop`, sits still while the body scrolls
  // instead.
  return (
    <main ref={landingScrollRef} className="relative h-full w-full overflow-y-auto">
      <LandingPage onJoin={openLogin} scrollRef={landingScrollRef} />

      {loginMounted && (
        <Suspense fallback={null}>
          <LoginScreen
            isOpen={joinOpen}
            onClose={() => setJoinOpen(false)}
            onLogin={() => setJoinOpen(false)}
            onSignupClick={() => {
              setJoinOpen(false);
              setWizardActive(true);
            }}
          />
        </Suspense>
      )}
    </main>
  );
}

export default WelcomePage;
