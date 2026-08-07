"use strict";

const dbus = require("@jellybrick/dbus-next");
const { Variant } = dbus;

const {
  ACCESS_READ,
  Interface,
} = dbus.interface;

const ITEM_INTERFACE = "org.kde.StatusNotifierItem";
const ITEM_PATH = "/StatusNotifierItem";
const MENU_INTERFACE = "com.canonical.dbusmenu";
const MENU_PATH = "/MenuBar";
const SERVICE_NAME = "buzz.armada.app.StatusNotifierItem";
const WATCHER_INTERFACE = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH = "/StatusNotifierWatcher";

function nativeImageToArgbPixmaps(image, sizes = [22, 44]) {
  return sizes.map((size) => {
    const resized = image.resize({ width: size, height: size, quality: "best" });
    const { width, height } = resized.getSize();
    const bgra = resized.toBitmap();
    const argb = Buffer.allocUnsafe(bgra.length);
    for (let offset = 0; offset < bgra.length; offset += 4) {
      argb[offset] = bgra[offset + 3];
      argb[offset + 1] = bgra[offset + 2];
      argb[offset + 2] = bgra[offset + 1];
      argb[offset + 3] = bgra[offset];
    }
    return [width, height, argb];
  });
}

class ArmadaStatusNotifierItem extends Interface {
  constructor({ iconPixmaps, tooltip, onActivate, onContextMenu }) {
    super(ITEM_INTERFACE);
    // @jellybrick/dbus-next's transpiled Interface constructor creates empty
    // own metadata fields, shadowing the metadata configureMembers installs on
    // the subclass prototype. Restore those configured maps on the instance so
    // introspection and method dispatch expose the actual SNI contract.
    configuredInterface(this);
    this.iconPixmaps = iconPixmaps;
    this.tooltip = tooltip;
    this.onActivate = onActivate;
    this.onContextMenu = onContextMenu;
  }

  get Category() { return "Communications"; }
  get Id() { return "armada"; }
  get Title() { return "Armada"; }
  get Status() { return "Active"; }
  get WindowId() { return 0; }
  get IconThemePath() { return ""; }
  get IconName() { return ""; }
  get IconPixmap() { return this.iconPixmaps; }
  get OverlayIconName() { return ""; }
  get OverlayIconPixmap() { return []; }
  get AttentionIconName() { return ""; }
  get AttentionIconPixmap() { return []; }
  get AttentionMovieName() { return ""; }
  get ToolTip() { return ["", this.iconPixmaps, this.tooltip, ""]; }
  get ItemIsMenu() { return false; }
  get Menu() { return MENU_PATH; }

  ContextMenu(x, y) {
    queueMicrotask(() => this.onContextMenu?.(x, y));
  }

  Activate() {
    queueMicrotask(() => this.onActivate?.());
  }

  ProvideXdgActivationToken() {}

  SecondaryActivate() {
    queueMicrotask(() => this.onActivate?.());
  }

  Scroll() {}

  NewIcon() {}
  NewToolTip() {}
}

ArmadaStatusNotifierItem.configureMembers({
  properties: {
    Category: { signature: "s", access: ACCESS_READ },
    Id: { signature: "s", access: ACCESS_READ },
    Title: { signature: "s", access: ACCESS_READ },
    Status: { signature: "s", access: ACCESS_READ },
    WindowId: { signature: "i", access: ACCESS_READ },
    IconThemePath: { signature: "s", access: ACCESS_READ },
    IconName: { signature: "s", access: ACCESS_READ },
    IconPixmap: { signature: "a(iiay)", access: ACCESS_READ },
    OverlayIconName: { signature: "s", access: ACCESS_READ },
    OverlayIconPixmap: { signature: "a(iiay)", access: ACCESS_READ },
    AttentionIconName: { signature: "s", access: ACCESS_READ },
    AttentionIconPixmap: { signature: "a(iiay)", access: ACCESS_READ },
    AttentionMovieName: { signature: "s", access: ACCESS_READ },
    ToolTip: { signature: "(sa(iiay)ss)", access: ACCESS_READ },
    ItemIsMenu: { signature: "b", access: ACCESS_READ },
    Menu: { signature: "o", access: ACCESS_READ },
  },
  methods: {
    ContextMenu: { inSignature: "ii", outSignature: "" },
    Activate: { inSignature: "ii", outSignature: "" },
    ProvideXdgActivationToken: { inSignature: "s", outSignature: "" },
    SecondaryActivate: { inSignature: "ii", outSignature: "" },
    Scroll: { inSignature: "is", outSignature: "" },
  },
  signals: {
    NewIcon: { signature: "" },
    NewToolTip: { signature: "" },
  },
});

function configuredInterface(instance) {
  const configured = Object.getPrototypeOf(instance);
  instance.$properties = configured.$properties;
  instance.$methods = configured.$methods;
  instance.$signals = configured.$signals;
}

function menuProperty(signature, value) {
  return new Variant(signature, value);
}

class ArmadaDbusMenu extends Interface {
  constructor(getMenuEntries) {
    super(MENU_INTERFACE);
    configuredInterface(this);
    this.getMenuEntries = getMenuEntries;
  }

  get Version() { return 3; }
  get TextDirection() { return "ltr"; }
  get Status() { return "normal"; }
  get IconThemePath() { return []; }

  entries() {
    const entries = this.getMenuEntries?.();
    return Array.isArray(entries) ? entries : [];
  }

  entry(id) {
    return this.entries().find((entry) => entry.id === id);
  }

  propertiesFor(id, requested = []) {
    const all = requested.length === 0;
    const include = (name) => all || requested.includes(name);
    const properties = {};
    if (id === 0) {
      if (include("children-display")) {
        properties["children-display"] = menuProperty("s", "submenu");
      }
      return properties;
    }

    const entry = this.entry(id);
    if (!entry) return properties;
    if (entry.type === "separator") {
      if (include("type")) properties.type = menuProperty("s", "separator");
      if (include("visible")) properties.visible = menuProperty("b", true);
      return properties;
    }

    if (include("label")) properties.label = menuProperty("s", entry.label || "");
    if (include("enabled")) properties.enabled = menuProperty("b", entry.enabled !== false);
    if (include("visible")) properties.visible = menuProperty("b", entry.visible !== false);
    return properties;
  }

  layoutFor(id, depth, requested) {
    if (id !== 0) return [id, this.propertiesFor(id, requested), []];
    const children = depth === 0
      ? []
      : this.entries().map((entry) => new Variant(
          "(ia{sv}av)",
          [entry.id, this.propertiesFor(entry.id, requested), []],
        ));
    return [0, this.propertiesFor(0, requested), children];
  }

  GetLayout(parentId, recursionDepth, propertyNames) {
    return [1, this.layoutFor(parentId, recursionDepth, propertyNames)];
  }

  GetGroupProperties(ids, propertyNames) {
    const selected = ids.length ? ids : [0, ...this.entries().map((entry) => entry.id)];
    return selected.map((id) => [id, this.propertiesFor(id, propertyNames)]);
  }

  GetProperty(id, name) {
    return this.propertiesFor(id, [name])[name] || menuProperty("s", "");
  }

  Event(id, eventId) {
    if (eventId !== "clicked") return;
    const entry = this.entry(id);
    if (entry?.enabled !== false) queueMicrotask(() => entry?.activate?.());
  }

  EventGroup(events) {
    const errors = [];
    for (const [id, eventId] of events) {
      if (!this.entry(id)) {
        errors.push(id);
        continue;
      }
      this.Event(id, eventId);
    }
    return errors;
  }

  AboutToShow() {
    return false;
  }

  AboutToShowGroup(ids) {
    return [[], ids.filter((id) => id !== 0 && !this.entry(id))];
  }
}

ArmadaDbusMenu.configureMembers({
  properties: {
    Version: { signature: "u", access: ACCESS_READ },
    TextDirection: { signature: "s", access: ACCESS_READ },
    Status: { signature: "s", access: ACCESS_READ },
    IconThemePath: { signature: "as", access: ACCESS_READ },
  },
  methods: {
    GetLayout: { inSignature: "iias", outSignature: "u(ia{sv}av)" },
    GetGroupProperties: { inSignature: "aias", outSignature: "a(ia{sv})" },
    GetProperty: { inSignature: "is", outSignature: "v" },
    Event: { inSignature: "isvu", outSignature: "" },
    EventGroup: { inSignature: "a(isvu)", outSignature: "ai" },
    AboutToShow: { inSignature: "i", outSignature: "b" },
    AboutToShowGroup: { inSignature: "ai", outSignature: "aiai" },
  },
});

class LinuxStatusNotifierTray {
  constructor(bus, item) {
    this.bus = bus;
    this.item = item;
    this.destroyed = false;
  }

  isDestroyed() {
    return this.destroyed;
  }

  setToolTip(tooltip) {
    if (this.destroyed || this.item.tooltip === tooltip) return;
    this.item.tooltip = tooltip;
    this.item.NewToolTip();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.bus.unexport(ITEM_PATH);
    this.bus.unexport(MENU_PATH);
    this.bus.disconnect();
  }
}

async function createLinuxStatusNotifier({
  image,
  tooltip,
  getMenuEntries,
  onActivate,
  onContextMenu,
}) {
  const bus = dbus.sessionBus();
  try {
    const item = new ArmadaStatusNotifierItem({
      iconPixmaps: nativeImageToArgbPixmaps(image),
      tooltip,
      onActivate,
      onContextMenu,
    });
    const menu = new ArmadaDbusMenu(getMenuEntries);
    bus.export(ITEM_PATH, item);
    bus.export(MENU_PATH, menu);
    await bus.requestName(SERVICE_NAME);

    const watcherObject = await bus.getProxyObject(
      "org.kde.StatusNotifierWatcher",
      WATCHER_PATH,
    );
    const watcher = watcherObject.getInterface(WATCHER_INTERFACE);
    // Register by object path so the watcher associates the item with this
    // connection's unique name. This also works through Flatpak's session-bus
    // proxy without granting ownership of the generic SNI service namespace.
    await watcher.RegisterStatusNotifierItem(ITEM_PATH);
    return new LinuxStatusNotifierTray(bus, item);
  } catch (error) {
    bus.disconnect();
    throw error;
  }
}

module.exports = {
  ITEM_INTERFACE,
  ITEM_PATH,
  MENU_INTERFACE,
  MENU_PATH,
  SERVICE_NAME,
  ArmadaDbusMenu,
  ArmadaStatusNotifierItem,
  createLinuxStatusNotifier,
  nativeImageToArgbPixmaps,
};
