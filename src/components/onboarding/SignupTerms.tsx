import { FormattedMessage } from "@/i18n";

/** ToS consent under every "Create account" and "Log in" button. A plain anchor: a mid-dialog route change isn't safe. */
export function SignupTerms({ action = "signup" }: { action?: "signup" | "login" | "continue" }) {
  const link = (chunks: React.ReactNode[]) => (
    <a href="/terms" className="text-primary hover:underline">
      {chunks}
    </a>
  );
  return (
    <p className="text-center text-xs leading-relaxed text-muted-foreground">
      <FormattedMessage
        id="signupTerms.consent"
        defaultMessage="By {action, select, login {logging in} continue {continuing} other {creating an account}}, you agree to the <link>Terms of Service</link>."
        values={{ action, link }}
      />
    </p>
  );
}
