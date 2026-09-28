import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { LandingPage } from "@/components/landing/LandingPage";
import { lazyWithReload } from "@/lib/chunkReload";
import { peekPendingJoin } from "@/lib/joinLink";

/**
 * The signed-out landing (marketing deck over the ASCII sea) plus the login
 * dialog and account wizard. Deliberately EAGER (in the entry chunk) so `/`
 * paints on mount; {@link LoginScreen} and `SignupWizard` are lazy and warmed
 * at idle. A pending `/join` link starts the wizard immediately. Signed-in
 * users never see this (`HomeRedirect`), except mid-wizard.
 */

const LoginScreen = lazy(lazyWithReload(() => import("@/components/auth/LoginScreen")));

const SignupWizard = lazy(
  lazyWithReload(() => import("@/pages/SignupWizard").then((m) => ({ default: m.SignupWizard }))),
);

export function WelcomePage() {
  // The sea reads scrollTop in its own frame; passed down, not state, so scrolling doesn't re-render.
  const landingScrollRef = useRef<HTMLElement>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  // Latches on first open; the dialog handles its own visibility.
  const [loginMounted, setLoginMounted] = useState(false);
  const [wizardActive, setWizardActive] = useState(() => !!peekPendingJoin());

  // Stable, so the memoized landing doesn't re-render when the dialog opens.
  const openLogin = useCallback(() => {
    setLoginMounted(true);
    setJoinOpen(true);
  }, []);

  // Warm both lazy branches at idle (like `useWarmRouteChunks`).
  useEffect(() => {
    const timer = setTimeout(() => {
      void import("@/components/auth/LoginScreen").catch(() => undefined);
      void import("@/pages/SignupWizard").catch(() => undefined);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  if (wizardActive) {
    // No fallback: a spinner would flash; the landing stays up while the chunk loads.
    return (
      <Suspense fallback={null}>
        <SignupWizard onExit={() => setWizardActive(false)} />
      </Suspense>
    );
  }

  // `h-full w-full`, not `flex-1`: this is a direct child of `#root` with no
  // flex parent, so it must size itself for `overflow-y-auto` to form the
  // scroll box the sea animates from.
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
