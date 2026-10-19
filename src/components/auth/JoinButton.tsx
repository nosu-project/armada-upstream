import { useState } from "react";

import LoginScreen from "@/components/auth/LoginScreen";
import SignupDialog from "@/components/auth/SignupDialog";
import { Button } from "@/components/ui/button";
import { FormattedMessage } from "@/i18n";

/**
 * The canonical logged-out call to action; opens the login dialog. Never show a
 * raw Log in / Sign up pair.
 */
export function JoinButton({
  className,
  size,
  children,
}: {
  className?: string;
  size?: "default" | "sm" | "lg";
  children?: React.ReactNode;
}) {
  const [joinOpen, setJoinOpen] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);

  return (
    <>
      <Button size={size} className={className} onClick={() => setJoinOpen(true)}>
        {children ?? <FormattedMessage id="joinButton.join" defaultMessage="Join" />}
      </Button>
      <LoginScreen
        isOpen={joinOpen}
        onClose={() => setJoinOpen(false)}
        onLogin={() => setJoinOpen(false)}
        onSignupClick={() => {
          setJoinOpen(false);
          setSignupOpen(true);
        }}
      />
      <SignupDialog isOpen={signupOpen} onClose={() => setSignupOpen(false)} />
    </>
  );
}
