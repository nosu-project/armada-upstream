import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useBackOrHome } from "@/hooks/useBackOrHome";
import { APP_NAME, SUPPORT_EMAIL } from "@/lib/platform";

/** The store listings' Support URL: how to get help and how to deal with abuse. */
export function SupportPage() {
  const back = useBackOrHome();
  const mail = (
    <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary hover:underline">
      {SUPPORT_EMAIL}
    </a>
  );

  return (
    <main className="flex-1 min-w-0 flex flex-col safe-area-top">
      <header className="relative h-12 touch:h-[3.25rem] mx-gutter mt-1 sidebar:mt-3 w-[calc(100%-2*var(--gutter))] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="Back" onClick={back}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="font-semibold truncate leading-tight">Help &amp; Support</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto safe-area-bottom">
        <article className="max-w-2xl mx-auto px-4 sm:px-6 pb-16 pt-3 space-y-6 text-sm text-foreground/90 leading-relaxed">
          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Contact Us</h2>
            <p>
              For questions, problems, feedback, or to report inappropriate activity, email {mail}. {APP_NAME} is
              made by Soapbox Technology LLC.
            </p>
            <p>
              When reporting abuse, include the person's profile link (npub) and, if you can, a screenshot or a
              link to the message.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Staying Safe</h2>
            <p>Every message and profile has tools for dealing with unwanted content:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>
                <strong>Report</strong> a message or person from its menu. In a community, the report goes to its
                moderators, who can remove the content and remove the member.
              </li>
              <li>
                <strong>Block</strong> a person to hide their messages, reactions, notifications and profile
                everywhere in {APP_NAME}. They are never told. Review blocked people in Settings › Blocked people.
              </li>
              <li>
                <strong>Hide</strong> any single message to remove it from your view immediately.
              </li>
              <li>
                <strong>Mute words</strong> in Settings › Muted words to hide every message that contains them.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Your Account</h2>
            <p>
              Your account is a secret key that only you hold. Nobody, including us, can recover it if it is lost,
              so back it up from Settings › Keys. To delete your account, use Settings › Delete account.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Policies</h2>
            <p>
              Read the{" "}
              <Link to="/terms" className="text-primary hover:underline">
                Terms of Service
              </Link>{" "}
              and the{" "}
              <Link to="/privacy" className="text-primary hover:underline">
                Privacy Policy
              </Link>
              .
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
