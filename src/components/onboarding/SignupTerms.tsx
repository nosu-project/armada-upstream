/** ToS consent under every "Create account" button. A plain anchor: a mid-dialog route change isn't safe. */
export function SignupTerms() {
  return (
    <p className="text-center text-xs leading-relaxed text-muted-foreground">
      By creating an account, you agree to the{" "}
      <a href="/terms" className="text-primary hover:underline">
        Terms of Service
      </a>
      .
    </p>
  );
}
