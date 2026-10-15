import { Download, FileText, LifeBuoy, Mail, ScrollText, Shield } from "lucide-react";
import { useContext } from "react";

import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { SettingsSearchingContext } from "@/components/settings/settingsNav";
import { appVersionLabel } from "@/lib/appVersion";
import { SUPPORT_EMAIL } from "@/lib/platform";

/** Settings › Help & support. */
export function SupportSettings() {
  return (
    <SettingsGroup id="support">
      <SettingsRow
        icon={LifeBuoy}
        tone="success"
        label="Help & safety"
        description="Blocking, hiding, muted words, reporting and getting help."
        to="/support"
      />
      <SettingsRow
        icon={Mail}
        tone="accent2"
        label="Contact support"
        description={`Report inappropriate activity or ask for help at ${SUPPORT_EMAIL}.`}
        href={`mailto:${SUPPORT_EMAIL}`}
        chevron
      />
    </SettingsGroup>
  );
}

/** Settings › About Armada: version, release notes, downloads and the legal pages. */
export function AboutSettings() {
  const searching = useContext(SettingsSearchingContext);
  return (
    <>
      {!searching && (
        <div className="flex flex-col items-center gap-2 pt-2 pb-1 text-center">
          <span className="flex size-16 items-center justify-center clip-corner-lg bg-chrome neon-text">
            <svg width="36" height="36" viewBox="0 0 128 128" fill="none" aria-hidden>
              <path d="M64 4.225l-39.97 88.5h17.13l2.31-5.2 2.76-6.22-2.22-1.43-1.42-12.84h9.99l4.89-11.01L64 41.335l11.42 25.7h9.99l-1.43 12.84-2.22 1.43 2.77 6.22 2.31 5.2h17.13z" fill="currentColor" />
            </svg>
          </span>
          <div className="font-mono text-lg font-bold lowercase tracking-tight">armada</div>
          <div className="text-xs text-muted-foreground">Private communities that need no host.</div>
        </div>
      )}

      <SettingsGroup id="about">
        <SettingsRow label="Version" value={<span className="tabular-nums">{appVersionLabel()}</span>} />
        <SettingsRow icon={ScrollText} tone="primary" label="What's new" to="/changelog" />
        <SettingsRow icon={Download} tone="accent2" label="Get the apps" to="/downloads" />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow icon={FileText} tone="muted" label="Terms of service" to="/terms" />
        <SettingsRow icon={Shield} tone="muted" label="Privacy policy" to="/privacy" />
      </SettingsGroup>
    </>
  );
}
