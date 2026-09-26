import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useBackOrHome } from "@/hooks/useBackOrHome";
import { APP_NAME } from "@/lib/platform";

export function TermsPage() {
  const back = useBackOrHome();

  return (
    <main className="flex-1 min-w-0 flex flex-col safe-area-top">
      {/* Header — a detached floating command bar matching the settings page chrome. */}
      <header className="relative h-12 touch:h-14 mx-2 mt-3 w-[calc(100%-1rem)] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="Back" onClick={back}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="font-semibold truncate leading-tight">Terms of Service</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto safe-area-bottom">
        <article className="max-w-2xl mx-auto px-4 sm:px-6 pb-16 pt-3 space-y-6 text-sm text-foreground/90 leading-relaxed">
          <p className="text-xs text-muted-foreground">Last updated: August 28, 2026</p>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">What These Terms Are</h2>
            <p>
              {APP_NAME} is a client application for the <strong>Nostr protocol</strong>, an open, decentralized
              communication network with no central operator. Your identity is a cryptographic key that belongs
              to you and works in any compatible app.
            </p>
            <p>
              These terms cover this app: the content policy that applies to it, the moderation tools it provides,
              and what its developers can and cannot do. They do not govern the Nostr network itself or your key.
              By using {APP_NAME}, you agree to these terms.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Your Account</h2>
            <p>
              Your account is a cryptographic key pair. If you sign in with a secret key, {APP_NAME} stores it on
              your device so you stay signed in; it is never sent to the developers or to any server. If you sign
              in with an external signer (a browser extension, signer app, or remote signer), the key stays with
              that signer and {APP_NAME} never sees it. You are responsible for safeguarding your key and any
              backups of it. If you lose it, you permanently lose access to the account; no one can reset or
              recover it for you.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Acceptable Use</h2>
            <p>
              {APP_NAME} has no tolerance for objectionable content or abusive users. You agree not to use{" "}
              {APP_NAME} to:
            </p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>Violate any applicable law or regulation</li>
              <li>Infringe on the rights of any person or entity</li>
              <li>Harass, abuse, or harm other users</li>
              <li>Distribute malware, spam, or unsolicited content</li>
              <li>Impersonate another person or entity</li>
              <li>Attempt to disrupt or compromise the service, relays, or infrastructure</li>
            </ul>
            <p>
              Individual relays and communities enforce their own rules and codes of conduct on top of this policy.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Content, Moderation, and Your Tools</h2>
            <p>
              You are solely responsible for the content you publish through {APP_NAME}. Content published to
              public relays may be visible to anyone, and because relays operate independently, it may not be
              removable from every relay once published.
            </p>
            <p>The app puts moderation where it can actually be enforced:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>
                <strong>You</strong> can delete your own messages, instantly hide any message from your view,
                block any user (removing their messages, reactions, and profile everywhere in the app), and
                report any message or user.
              </li>
              <li>
                <strong>Community moderators and server operators</strong> receive those reports for the spaces
                they run, and can remove content and eject members from them.
              </li>
            </ul>
            <p>
              {APP_NAME}'s developers do not operate the network and cannot delete content from relays they do
              not run.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">No Warranty</h2>
            <p>
              {APP_NAME} is provided "as is" and "as available," without warranties of any kind, express or implied.
              We do not guarantee that the app will be uninterrupted, secure, or error-free. You use the app at your
              own risk.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Limitation of Liability</h2>
            <p>
              To the fullest extent permitted by law, the developers of {APP_NAME} shall not be liable for any
              indirect, incidental, special, consequential, or punitive damages arising from your use of the app,
              including but not limited to loss of data, loss of access to your account, or exposure of published
              content.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Third-Party Services</h2>
            <p>
              {APP_NAME} interacts with third-party services (Nostr relays, Blossom file servers, and LiveKit
              voice servers) that are operated independently. Each has its own terms and policies. We are not
              responsible for the practices or content of these third-party services.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Changes to These Terms</h2>
            <p>
              We may update these terms from time to time. Changes will be reflected on this page with an updated
              date. Continued use of {APP_NAME} after changes constitutes acceptance of the revised terms.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Contact &amp; Reporting</h2>
            <p>
              To flag inappropriate activity, use the <strong>Report</strong> action available on every message
              and profile; it reaches the people who can act on it. To reach the team behind {APP_NAME} directly,
              including to report inappropriate activity or ask about these terms, visit{" "}
              <a href="https://soapbox.pub" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
                soapbox.pub
              </a>.
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
