/** ToS consent under every "Create account" and "Log in" button. A plain anchor: a mid-dialog route change isn't safe. */
export function SignupTerms({ action = "creating an account" }: { action?: string }) {
  return (
    <p className="text-center text-xs leading-relaxed text-muted-foreground">
      By {action}, you agree to the{" "}
      <a href="/terms" className="text-primary hover:underline">
        Terms of Service
      </a>
      .
    </p>
  );
}
