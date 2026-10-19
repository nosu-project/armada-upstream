import { defineMessages } from "@/i18n/intl";

/**
 * Words used verbatim across the app, translated once. Use one only where the
 * bare word is the whole text (a button, a menu item); a sentence gets its own id.
 * `<FormattedMessage {...common.cancel} />` or `intl.formatMessage(common.cancel)`.
 */
export const common = defineMessages({
  add: { id: "common.add", defaultMessage: "Add" },
  back: { id: "common.back", defaultMessage: "Back" },
  cancel: { id: "common.cancel", defaultMessage: "Cancel" },
  close: { id: "common.close", defaultMessage: "Close" },
  confirm: { id: "common.confirm", defaultMessage: "Confirm" },
  continue: { id: "common.continue", defaultMessage: "Continue" },
  copied: { id: "common.copied", defaultMessage: "Copied" },
  copy: { id: "common.copy", defaultMessage: "Copy" },
  copyLink: { id: "common.copyLink", defaultMessage: "Copy link" },
  create: { id: "common.create", defaultMessage: "Create" },
  delete: { id: "common.delete", defaultMessage: "Delete" },
  done: { id: "common.done", defaultMessage: "Done" },
  edit: { id: "common.edit", defaultMessage: "Edit" },
  error: { id: "common.error", defaultMessage: "Error" },
  learnMore: { id: "common.learnMore", defaultMessage: "Learn more" },
  loading: { id: "common.loading", defaultMessage: "Loading…" },
  next: { id: "common.next", defaultMessage: "Next" },
  no: { id: "common.no", defaultMessage: "No" },
  ok: { id: "common.ok", defaultMessage: "OK" },
  remove: { id: "common.remove", defaultMessage: "Remove" },
  reply: { id: "common.reply", defaultMessage: "Reply" },
  retry: { id: "common.retry", defaultMessage: "Retry" },
  save: { id: "common.save", defaultMessage: "Save" },
  saving: { id: "common.saving", defaultMessage: "Saving…" },
  search: { id: "common.search", defaultMessage: "Search" },
  send: { id: "common.send", defaultMessage: "Send" },
  settings: { id: "common.settings", defaultMessage: "Settings" },
  share: { id: "common.share", defaultMessage: "Share" },
  skip: { id: "common.skip", defaultMessage: "Skip" },
  tryAgain: { id: "common.tryAgain", defaultMessage: "Try again" },
  yes: { id: "common.yes", defaultMessage: "Yes" },
});
