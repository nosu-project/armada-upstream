/**
 * Armada Service Worker
 *
 * Receives Web Push notifications from the Armada relay's push gateway and
 * focuses/opens the app at the relevant conversation when tapped.
 *
 * The relay sends a JSON payload: { title, body, icon, badge, data: { url, tag } }.
 */

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Armada", body: event.data.text() };
  }

  const data = payload.data ?? {};
  const options = {
    body: payload.body ?? "",
    icon: payload.icon || "/favicon.png",
    badge: payload.badge || "/favicon.png",
    data,
    // Collapse repeated notifications for the same conversation; renotify so a
    // new message in an already-notified conversation still alerts.
    tag: data.tag || "armada-notification",
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(payload.title ?? "Armada", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus an existing Armada tab and route it to the conversation.
        for (const client of clientList) {
          if (new URL(client.url).origin === self.location.origin) {
            client.navigate(target);
            return client.focus();
          }
        }
        // Otherwise open a fresh window at the target.
        return self.clients.openWindow(target);
      }),
  );
});

// Take control immediately so push works on first install without a reload.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
