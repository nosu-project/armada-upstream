import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/platform";

export function TermsPage() {
  const navigate = useNavigate();

  return (
    <main className="flex-1 min-w-0 flex flex-col safe-area-top">
      {/* Header — a detached floating command bar matching the settings page chrome. */}
      <header className="relative h-12 touch:h-14 mx-2 mt-3 w-[calc(100%-1rem)] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="Back" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="font-semibold truncate leading-tight">Terms of Service</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto safe-area-bottom">
        <article className="max-w-2xl mx-auto px-4 sm:px-6 pb-16 pt-3 space-y-6 text-sm text-foreground/90 leading-relaxed">
          <p className="text-xs text-muted-foreground">Last updated: July 11, 2026</p>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Overview</h2>
            <p>
              {APP_NAME} is a client application for the <strong>Nostr protocol</strong>, an open, decentralized
              communication network. By using {APP_NAME}, you agree to these terms. Nostr itself is a protocol
              (like email or the web) — it does not have terms of service. Individual relays and apps may have
              their own rules.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Your Account</h2>
            <p>
              You are responsible for safeguarding the private key associated with your account. {APP_NAME} never
              accesses or stores your private key directly — it is managed by your chosen signer (browser
              extension, hardware device, or other NIP-07-compatible signer). If you lose access to your private
              key, you will permanently lose access to your account, and no one can recover it for you.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Acceptable Use</h2>
            <p>You agree not to use {APP_NAME} to:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>Violate any applicable law or regulation</li>
              <li>Infringe on the rights of any person or entity</li>
              <li>Harass, abuse, or harm other users</li>
              <li>Distribute malware, spam, or unsolicited content</li>
              <li>Impersonate another person or entity</li>
              <li>Attempt to disrupt or compromise the service, relays, or infrastructure</li>
            </ul>
            <p>
              Individual relays and communities may enforce their own rules and code of conduct. {APP_NAME} does not
              moderate content and cannot remove content from relays it does not operate.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Content and Publishing</h2>
            <p>
              You are solely responsible for the content you publish through {APP_NAME}. Content published to Nostr
              relays is public by default and may be visible to anyone. Once published, content may be difficult or
              impossible to remove, as relays operate independently and may not honor deletion requests.
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
              {APP_NAME} interacts with third-party services — Nostr relays, Blossom file servers, and LiveKit
              voice servers — that are operated independently. Each has its own terms and policies. We are not
              responsible for the practices or content of these third-party services.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Decentralized Nature</h2>
            <p>
              Because Nostr is decentralized, {APP_NAME} is a client — not a service provider. The app connects you
              to relays and communities you choose. We cannot control the availability, moderation, or data
              practices of those relays, nor can we guarantee that content you publish will be removable from them.
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
            <h2 className="text-base font-bold text-foreground">Contact</h2>
            <p>
              If you have questions about these terms, you can reach the team behind {APP_NAME} at{" "}
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
