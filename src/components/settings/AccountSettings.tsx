import { useNostrLogin } from "@nostrify/react/login";
import { ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { LoginArea } from "@/components/auth/LoginArea";
import { AccountStandingDialog } from "@/components/settings/AccountStandingDialog";
import { KeyBackupSettings } from "@/components/settings/KeyBackupSettings";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { SyncSettings } from "@/components/settings/SyncSettings";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";

const RequestToVanishDialog = lazy(() =>
  import("@/components/RequestToVanishDialog").then((m) => ({ default: m.RequestToVanishDialog })),
);

/** Settings › Account: who is logged in, their key, sync, standing, and deletion. */
export function AccountSettings() {
  const { user } = useCurrentUser();
  const { logins } = useNostrLogin();
  const { config, updateConfig } = useAppContext();
  const [standingOpen, setStandingOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Only nsec logins have a key this client can show/back up.
  const activeLogin = logins[0];

  /** Retire Account Standing's nag on open (not close). */
  const openStanding = () => {
    setStandingOpen(true);
    updateConfig((current) =>
      current.accountStandingSeen ? current : { ...current, accountStandingSeen: true },
    );
  };

  return (
    <>
      <SettingsGroup
        id="account"
        title="Accounts"
        footer={user ? "Switch accounts, add another, or log out." : "Log in to sync your settings and join communities."}
      >
        <SettingsRow>
          <LoginArea className="w-full flex" />
        </SettingsRow>
      </SettingsGroup>

      {user && activeLogin?.type === "nsec" && (
        <SettingsGroup id="keys" title="Keys">
          <KeyBackupSettings nsec={activeLogin.data.nsec} pubkey={activeLogin.pubkey} />
        </SettingsGroup>
      )}

      {user && <SyncSettings />}

      {user && (
        <SettingsGroup id="standing">
          {/* Wears an alert shield until opened (the dialog reveals it's a joke). */}
          <SettingsRow
            icon={config.accountStandingSeen ? ShieldCheck : ShieldAlert}
            tone={config.accountStandingSeen ? "success" : "warning"}
            label="Account standing"
            chevron
            onClick={openStanding}
          />
        </SettingsGroup>
      )}

      {user && (
        <SettingsGroup
          id="danger"
          footer="Permanently remove your identity and request data deletion from relays."
        >
          <SettingsRow
            icon={Trash2}
            tone="destructive"
            label="Delete account"
            destructive
            onClick={() => setDeleteOpen(true)}
          />
        </SettingsGroup>
      )}

      {user && <AccountStandingDialog open={standingOpen} onOpenChange={setStandingOpen} />}
      {user && (
        <Suspense fallback={null}>
          <RequestToVanishDialog open={deleteOpen} onOpenChange={setDeleteOpen} />
        </Suspense>
      )}
    </>
  );
}
