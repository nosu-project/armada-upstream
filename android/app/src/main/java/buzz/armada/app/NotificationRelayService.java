package buzz.armada.app;

import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.graphics.drawable.IconCompat;

import buzz.armada.app.db.SelfState;
import buzz.armada.app.db.ServiceStore;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import okhttp3.Cache;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Foreground service that holds a persistent Nostr REQ subscription to the
 * user's relay(s) and posts a native notification the instant a matching event
 * arrives. This is the de-Googled instant-push path — no FCM, no Web Push, no
 * polling.
 *
 * One WebSocket per relay is kept open with a live REQ:
 *   - {@code {kinds:[9], #h:[...ids-hosted-here], since}} group messages (a
 *     NIP-29 group lives on one relay, so #h is scoped per relay)
 *   - {@code {kinds:[7,1111], #h:[...ids-hosted-here], #p:[userPubkey], since}} reactions/replies
 *   - {@code {kinds:[4], authors:[...follows], #p:[userPubkey], since}} DMs (friends only)
 *   - {@code {kinds:[1059], authors:[...stream pks], since}} Concord wraps
 *
 * On each EVENT we apply the user's prefs (mention vs all-group, per-type
 * toggles), dedupe by id, skip self, and post it into its room's conversation
 * notification (see {@code enqueueRoomMessage}).
 *
 * Resilience:
 *   - Exponential reconnect backoff per relay (1s → 5min cap), reset only
 *     after a connection survives long enough to be considered stable.
 *   - Network-aware: reconnects immediately when connectivity returns.
 *   - Re-reads config (login/logout/relay/group changes) via a SharedPreferences
 *     listener and rebuilds subscriptions live.
 */
public class NotificationRelayService extends Service {

    private static final String TAG = "ArmadaNotifSvc";
    private static final String SVC_CHANNEL_ID = "armada_background_service";
    // Bumped to _v2 so the stronger vibration + HIGH importance take effect on
    // installs that already created the old channel (channel settings are
    // immutable once created; only a new id picks up new settings). The old
    // channel is deleted in createChannels().
    private static final String MSG_CHANNEL_ID = "armada_notifications_v2";
    private static final String MSG_CHANNEL_ID_LEGACY = "armada_notifications";
    // A firm, attention-grabbing buzz for messages: wait, buzz, gap, buzz again.
    private static final long[] MSG_VIBRATION_PATTERN = { 0L, 400L, 200L, 400L };
    private static final int FOREGROUND_ID = 1;
    // Room notification ids are hashed into [2, ROOM_ID_MODULUS+1]. The band
    // just above it was the (now removed) per-community summary band; it's kept
    // reserved so cancelStaleSummaries can clear leftovers from old builds.
    private static final int ROOM_ID_MODULUS = 2_000_000_000;
    private static final int CONTENT_CAP = 140;
    // ── Per-channel conversation notifications ────────────────────────────────
    // Each CHANNEL (a Concord channel, a NIP-29 group) and each DM peer
    // gets ONE standalone conversation notification that accumulates its recent
    // messages via MessagingStyle — the community image (sender avatar for DMs)
    // on the left, "Community / #channel" (peer name) as the title. A busy
    // channel grows one thread; other channels get their own notification, each
    // with its own tap target and Mark read.
    //
    // There is deliberately NO per-community group summary: Android 7+ IGNORES
    // a group summary's custom title/large-icon and renders a collapsed stack
    // with the APP name + APP icon, repeating each child's conversation avatar
    // per line — so a summary can never carry the community's branding. And
    // merging a community's channels into ONE notification (tried) makes a tap
    // or Mark read act on every channel at once. Standalone per-channel
    // conversations are the only shape with both the branding and per-channel
    // actions.
    //
    // Every notification gets its OWN unique group key so Android's
    // auto-bundling (4+ ungrouped notifications) can't sweep separate
    // conversations into one system pile under the app icon.
    private static final String GROUP_PREFIX = "armada:";
    // The retired summary-id band ([SUMMARY_ID_BASE, +SUMMARY_ID_MODULUS)):
    // older builds posted per-community InboxStyle summaries here. Cleared on
    // startup so an upgrade doesn't leave orphaned summaries in the tray.
    private static final int SUMMARY_ID_BASE = 2_000_000_002;
    private static final int SUMMARY_ID_MODULUS = 140_000_000;
    // "Mark read" notification action: dismisses the notification AND enqueues a
    // durable read-marker the WebView applies (advancing the in-app read state)
    // on its next open/resume. Delivered to the running service as a start intent
    // (handled in onStartCommand WITHOUT tearing down relay connections).
    static final String ACTION_MARK_READ = "buzz.armada.app.action.MARK_READ";
    static final String EXTRA_ROOM_KEY = "armada_room_key";
    // Per-channel read-marker payload carried on the Mark read intent
    // (parallel arrays: channel roomKey ↔ last message ts in ms), so the
    // marker survives a service cold start with the right timestamp.
    static final String EXTRA_CHANNEL_KEYS = "armada_channel_keys";
    static final String EXTRA_CHANNEL_TS = "armada_channel_ts";
    // "Reply" notification action: a RemoteInput whose text the service sends
    // back into the conversation ITSELF — a NIP-29 kind 9, a NIP-17
    // gift-wrapped DM, or a Concord sealed message — with the shared
    // signer credential, so a reply typed on the lockscreen goes out with the
    // app dead. Delivered as a start intent, exactly like Mark read. Rooms
    // with no native send path don't get the action at all.
    static final String ACTION_REPLY = "buzz.armada.app.action.REPLY";
    static final String KEY_TEXT_REPLY = "armada_text_reply";
    // How long a reply publish waits for any relay's OK before failing.
    private static final long PUBLISH_TIMEOUT_MS = 20_000;
    // How long the one-shot kind-10050 inbox lookup gathers answers.
    private static final long DM_INBOX_TIMEOUT_MS = 4_000;
    // NIP-59: outgoing seal/wrap timestamps are tweaked into the past, ≤ 2 days.
    private static final long MAX_WRAP_BACKDATE_SECS = 2 * 24 * 3600;
    // Most recent messages kept per room for the MessagingStyle expansion.
    private static final int MAX_MESSAGES_PER_ROOM = 8;

    /**
     * Alerting posts one room may fire inside {@link #ALERT_BURST_WINDOW_MS}
     * before further messages post SILENTLY.
     *
     * A public Concord channel's write access is key possession (CORD-04 §1),
     * so anyone holding an invite link can fill it — and a measured campaign
     * ran 368 messages through one channel in half an hour, one every 3.4
     * seconds. Every one of them reached here and alerted, which is a phone
     * buzzing all night no matter what the timeline does about it: the fold in
     * `floodCluster.ts` is a render-layer rule that this service, a second
     * writer in another language, never sees.
     *
     * So the limit here is deliberately NOT a spam judgement. It is a ceiling
     * on interruptions, and it holds whatever the messages say — no content is
     * examined, nothing is classified, and a generator that writes better
     * sentences gains nothing. Past the budget the room's notification is still
     * POSTED and still accumulates its lines, so the tray shows what arrived
     * and the count keeps climbing; it just stops making noise.
     *
     * Every attempt is recorded, not just the ones that alert, so a sustained
     * flood keeps its own window full and stays quiet until it genuinely stops
     * — otherwise the budget would refill mid-flood and buzz once per window
     * for as long as the flood ran.
     */
    private static final int ALERT_BURST_MAX = 5;
    /**
     * Mentions get their own, smaller budget rather than breaking through.
     *
     * An @-ping is worth waking someone for, but `p` tags are attacker-chosen
     * — a flood that tags every recipient would walk straight through an
     * unconditional mention exemption, which is the one bypass that would make
     * the rest of this pointless. A separate budget keeps a real mention
     * audible while an ordinary flood exhausts only the message budget.
     */
    private static final int ALERT_BURST_MAX_MENTION = 3;
    private static final long ALERT_BURST_WINDOW_MS = 120_000L;
    /** Bound per room; entries older than the window are pruned on every check. */
    private static final int ALERT_BURST_MAX_TRACKED = 256;
    private final java.util.Map<String, java.util.ArrayDeque<Long>> alertBurst = new java.util.HashMap<>();
    private final java.util.Map<String, java.util.ArrayDeque<Long>> mentionBurst = new java.util.HashMap<>();

    private static final long INITIAL_BACKOFF_MS = 1_000;
    private static final long MAX_BACKOFF_MS = 5 * 60 * 1_000;
    // A connection must survive this long before a subsequent failure resets
    // the backoff. Resetting in onOpen instead (the old behavior) meant a
    // relay that accepts the handshake but drops the socket right after
    // (auth-walled, overloaded, misbehaving proxy) reconnected every 1s
    // forever — a battery-melting hot loop while the phone sleeps.
    private static final long STABLE_CONNECTION_MS = 60_000;

    private OkHttpClient httpClient;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private ConnectivityManager.NetworkCallback networkCallback;
    private SharedPreferences.OnSharedPreferenceChangeListener configListener;

    // Active connections, one per relay URL.
    private final List<RelayConnection> connections = new ArrayList<>();

    // Current config snapshot.
    private String userPubkey;
    private final List<String> relayUrls = new ArrayList<>();
    private final Set<String> groupIds = new LinkedHashSet<>();
    // relay URL → the NIP-29 group ids hosted on THAT relay. A NIP-29 group is
    // intrinsically tied to a single relay (its `h` id is only meaningful on
    // its host), so each relay's kind-9 REQ is scoped to just its own groups —
    // the same relay→subscription model as Concord's relayToPks2, never a
    // broadcast of every joined id to every relay. Built in loadConfig from the
    // `groupSubs` config; falls back to relayUrls × groupIds for a config
    // written by an older build that shipped only the flat arrays.
    private final Map<String, Set<String>> relayToGroupIds = new HashMap<>();
    // The subset of the above whose notification level is "mentions only",
    // as `relay + '\0' + groupId` keys — relay-scoped for the same reason
    // relayToGroupIds is: an `h` id names a group only together with its host,
    // so a flat id set would mute the same-named group on every other relay.
    // These groups stay SUBSCRIBED (a mention still has to arrive); the
    // suppression happens per event in wantsNotification.
    private final Set<String> mentionOnlyGroupKeys = new LinkedHashSet<>();
    private final Set<String> dmRelays = new LinkedHashSet<>();
    // People the user follows (kind 3 `p` tags, hex). DM (kind 4) subscriptions
    // are scoped to `authors:[...dmFollows]` so notifications only fire for DMs
    // from friends — matching the client's permanent friends-only DM view.
    private final Set<String> dmFollows = new LinkedHashSet<>();
    // The "known" DM peers (hex): follows ∪ accepted ∪ pinned, the WebView's
    // `useKnownDmPeers` set. A NIP-17 wrap's author is ephemeral, so its inbox
    // subscription can't be author-scoped like kind 4 — the friend-vs-stranger
    // test happens here, after the wrap is opened. A peer NOT in this set is a
    // request, notified per `dmRequests`.
    private final Set<String> dmKnownPeers = new LinkedHashSet<>();
    // How to notify for a DM from a peer NOT in dmKnownPeers: "off" (silent),
    // "generic" (a content-blind request ping) or "full" (name/avatar/preview).
    // A stranger controls the message text, their display name and their avatar,
    // so the default keeps all three off the lock screen. Empty/unknown value ⇒
    // "generic". Only consulted when the `directMessages` pref is on.
    private String dmRequests = "generic";
    // Relays carrying the user's OWN replaceable documents (see SelfState) —
    // the client's general pool: app relays + the user's NIP-65 read relays.
    // Kept separate from `relayUrls`, which is derived from the kind-10009 list
    // and therefore holds NIP-29 servers only: a Concord-only user has none, and
    // scoping self-state to them would mean never watching the relays their
    // settings are actually published to.
    private final Set<String> selfRelays = new LinkedHashSet<>();
    private JSONObject prefs = new JSONObject();
    // Concord (CORD-02) channel subscriptions, keyed for fast lookup:
    //   pkToStream2: stream pubkey (the kind-1059 wrap's author, hex) → decrypt
    //                material + display name + deep link for that channel/epoch
    //   relayToPks2: relay url → the stream pubkeys that live on that relay
    private final java.util.Map<String, ConcordStream> pkToStream2 = new java.util.HashMap<>();
    private final java.util.Map<String, Set<String>> relayToPks2 = new java.util.HashMap<>();
    // The user's shared signer (nsec key / Amber grant / NIP-46 session),
    // rebuilt on every config load. Opens NIP-17 gift wraps addressed to the
    // user (the DM wrap filter is `{kinds:[1059], "#p":[userPubkey]}` on the DM
    // relays — the sender is hidden, so it can't be authors-scoped) and signs
    // NIP-42 AUTH natively; null when the WebView shipped no credential.
    private volatile NativeSigner nativeSigner;
    // Public Git activity is subscribed on announcement activity relays only.
    // The repository -> C2 route mapping never enters a relay filter.
    private final Map<String, GitRepository> gitRepositories = new HashMap<>();
    private final Map<String, Set<String>> gitRepositoriesByRelay = new HashMap<>();
    private static final int GIT_ROOT_FILTER_CHUNK_SIZE = 100;
    // De-dupe notifications across relays/reconnects for this service lifetime.
    private final Set<String> notifiedIds = new HashSet<>();
    // Connect time; we only notify for events at/after this to avoid backfill spam.
    private long sinceSec;

    // NIP-59 backdates a gift wrap's `created_at` by up to 2 days, and relays
    // apply `since` to LIVE streamed events too — so a `since` anywhere near
    // `now` filters out virtually every live NIP-17 DM wrap (only a backdate
    // that randomly lands inside the window would pass). The DM wrap filter
    // therefore rewinds `since` by the full backdate window (+ 1h slack) and
    // asks for NO stored replay (`limit: 0` — live-only; history is the
    // WebView's DM inbox sync to handle). For relays that ignore `limit: 0`,
    // notifiedIds dedupes within the service lifetime and the shared-DB
    // `storedBefore` check suppresses wraps either side already stored.
    private static final long DM17_SINCE_REWIND_SEC = 2 * 24 * 3600 + 3600;

    // roomKey → the accumulating per-room notification (Signal/Discord style).
    // The roomKey is a stable identifier for the conversation (NIP-29 groupId,
    // Concord channel id, or "dm:<peer>"), so successive
    // messages UPDATE the same notification instead of stacking a new one per
    // event.
    private final Map<String, RoomNotif> roomNotifs = new HashMap<>();

    // Resolved (decoded, circle-cropped) community icons, keyed by
    // CommunityRef.imageCacheKey(). Populated async; used as the conversation
    // shortcut's avatar (the left icon on Android 11+). Kept separate from
    // avatarCache (sender avatars).
    private final Map<String, Bitmap> groupImageCache = new HashMap<>();
    // In-flight community-icon fetches (by imageCacheKey) so a burst of messages
    // in one community doesn't kick off the same fetch repeatedly.
    private final Set<String> groupImageInFlight = new HashSet<>();

    /**
     * The roomKey(s) the WebView is currently showing on screen (set via
     * {@code ArmadaNotification.setActiveRooms}), or empty when the app is
     * backgrounded / on a non-chat screen. Held on the live instance only —
     * never persisted — so killing the WebView or the service immediately
     * resumes notifications. When a message arrives for an active room we
     * suppress the notification (it's redundant: the live timeline already
     * shows it). Mentions are still surfaced, since a mention is a deliberate
     * @-ping even on the visible channel.
     */
    private static volatile Set<String> activeRoomKeys =
            java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());


    // pubkey → resolved profile (kind 0), DURABLE: persisted to its own
    // SharedPreferences file so a service restart (Doze, OEM kills, reboots,
    // START_STICKY relaunches) doesn't re-broadcast a one-shot kind-0 REQ to
    // every relay for every author. Also holds NEGATIVE entries (fetched,
    // nothing found) so a profile-less author doesn't re-broadcast on every
    // message. Loaded in onCreate; writes are debounced (markProfilesDirty).
    private ProfileStore profileStore = new ProfileStore();
    // Whether a debounced profile-store persist is already scheduled.
    private boolean profilePersistScheduled = false;
    // pubkey → waiters for an in-flight kind-0 fetch, so concurrent events for
    // the same author share a single REQ.
    private final Map<String, List<ProfileCallback>> pendingProfiles = new HashMap<>();
    // pubkey → best (newest) kind-0 seen so far for an in-flight fetch, across
    // all relays it was broadcast to. A profile from one relay can be staler
    // than another's, so we keep the highest created_at rather than first-wins.
    private final Map<String, Profile> bestProfile = new HashMap<>();
    // pubkey → newest verified kind-10050 gathered by an in-flight DM-inbox
    // lookup (reply addressing), across relays. Read + cleared by the lookup's
    // timeout in resolveDmInbox.
    private final Map<String, JSONObject> bestInbox = new HashMap<>();
    // The user's OWN kind-0 + avatar, for the MessagingStyle self person a
    // sent quick reply renders as. Resolved once per config load through the
    // ordinary profile path (memory store → shared DB → relays), so the
    // notification build stays synchronous; a late arrival re-posts the rooms
    // that already show a reply (see warmSelfProfile).
    private Profile selfProfile;
    private Bitmap selfAvatar;
    private boolean selfProfilePending;
    // avatar URL → circle-cropped bitmap, decoded once and reused. Backed by a
    // persistent disk cache (avatarDir) so a warm avatar survives service
    // restarts and lands in the FIRST, alerting post instead of a later silent
    // re-post.
    private final Map<String, Bitmap> avatarCache = new HashMap<>();
    // Decoded, circle-cropped avatars persisted across restarts (getCacheDir()).
    private File avatarDir;
    // Avatar/image HTTP client: derived from httpClient (shares the dispatcher +
    // connection pool) but with its OWN read/call timeouts and a disk cache.
    // Kept SEPARATE from httpClient because httpClient drives the long-lived
    // relay WebSockets — a callTimeout there would tear the sockets down.
    private OkHttpClient avatarClient;
    // groupId → resolved group name (kind 39000). Cached for the service lifetime
    // so the room name in a notification doesn't re-fetch on every event.
    private final Map<String, String> groupNameCache = new HashMap<>();
    // groupId → the group's `picture` URL (kind 39000). Populated by the same
    // metadata fetch that resolves the name; used as the NIP-29 conversation's
    // avatar (a plain public URL — no decrypt).
    private final Map<String, String> groupPictureCache = new HashMap<>();
    // groupId → waiters for an in-flight kind-39000 fetch.
    private final Map<String, List<GroupNameCallback>> pendingGroupNames = new HashMap<>();
    // Largest dimension (px) we keep for an avatar large-icon.
    private static final int AVATAR_PX = 128;
    // Max decoded avatars kept on disk; least-recently-used pruned on save.
    private static final int AVATAR_DISK_MAX = 500;
    // On-disk HTTP cache for avatar byte fetches (shared with re-downloads).
    private static final long AVATAR_HTTP_CACHE_BYTES = 8L * 1024 * 1024;
    // How long to wait for a kind-0 profile before firing a name-less fallback.
    private static final long PROFILE_TIMEOUT_MS = 4_000;
    // How long a NEGATIVE profile entry suppresses re-broadcasts (24h).
    private static final long PROFILE_MISS_TTL_MS = 24L * 60 * 60 * 1000;
    // How long a cached profile is served without a background refresh (7d).
    private static final long PROFILE_STALE_MS = 7L * 24 * 60 * 60 * 1000;
    // Cap on persisted profiles; least-recently-fetched evicted on persist.
    private static final int PROFILE_STORE_MAX = 1000;
    // Debounce for writing the profile store to SharedPreferences.
    private static final long PROFILE_PERSIST_DEBOUNCE_MS = 1_000;
    // SharedPreferences file holding the serialized ProfileStore.
    private static final String PROFILES_PREFS = "armada_notif_profiles";
    private static final String PROFILES_KEY = "profiles";

    /** Minimal author profile: display name + avatar URL + nip05 (any may be null). */
    private static final class Profile {
        final String name;
        final String picture;
        final String nip05;
        /** kind-0 created_at, so a newer event from another relay wins. */
        final long ts;
        Profile(String name, String picture, String nip05, long ts) {
            this.name = name;
            this.picture = picture;
            this.nip05 = nip05;
            this.ts = ts;
        }
    }

    private interface ProfileCallback {
        void onProfile(Profile profile);
    }

    /**
     * Per-stream Concord decrypt material: the NIP-44 conversation key that
     * opens the stream's kind-1059 wraps (wrap → seal → rumor), the channel id
     * + epoch the rumor must bind to, and the display/deep-link strings for
     * the notification. One entry per (channel, epoch) — each epoch has its
     * own stream pubkey and conversation key.
     */
    private static final class ConcordStream {
        final byte[] convKey;     // raw 32-byte NIP-44 conversation key
        final String communityId; // hex; names the ArmadaDB tenant opened rumors are filed in
        final String channelId;   // hex; the rumor's `channel` tag must match
        final String epoch;       // decimal string; the rumor's `epoch` tag must match
        final String name;        // "Community / #channel" display name
        final String url;         // in-app deep link (/c/<communityId>/<channelId>)
        final CommunityRef community; // the community this stream's channel belongs to
        // CORD-08 disappearing-message timer (seconds, 0 = off) — the quick
        // reply stamps sendTime + timer on its rumor + wrap while set.
        final long timerSecs;
        // Channel set to "mentions only": still subscribed (a mention has to
        // arrive to be seen), but non-mention traffic notifies nothing.
        final boolean mentionOnly;
        ConcordStream(byte[] convKey, String communityId, String channelId, String epoch,
                       String name, String url, CommunityRef community, long timerSecs,
                       boolean mentionOnly) {
            this.convKey = convKey;
            this.communityId = communityId;
            this.channelId = channelId;
            this.epoch = epoch;
            this.name = name;
            this.url = url;
            this.community = community;
            this.timerSecs = timerSecs;
            this.mentionOnly = mentionOnly;
        }
    }

    private static final class GitAttachment {
        final String communityId, channelId; final long attachedAt, detachedAt;
        GitAttachment(String communityId, String channelId, long attachedAt, long detachedAt) {
            this.communityId = communityId; this.channelId = channelId;
            this.attachedAt = attachedAt; this.detachedAt = detachedAt;
        }
        boolean activeAt(long timestamp) { return timestamp >= attachedAt && (detachedAt < 0 || timestamp < detachedAt); }
        boolean live() { return detachedAt < 0; }
    }
    private static final class GitRoot {
        final String id, author; final int kind;
        GitRoot(String id, String author, int kind) { this.id = id; this.author = author; this.kind = kind; }
    }
    private static final class GitRepository {
        final String address, owner; final Set<String> maintainers = new HashSet<>();
        final List<GitAttachment> attachments = new ArrayList<>();
        final Map<String, GitRoot> roots = new HashMap<>();
        GitRepository(String address, String owner) { this.address = address; this.owner = owner; }
        boolean live() { for (GitAttachment a : attachments) if (a.live()) return true; return false; }
    }

    private interface GroupNameCallback {
        /** Receives the group's display name, or null if unresolved. */
        void onName(String name);
    }

    /**
     * The COMMUNITY a room belongs to: its stable key, display name, and the
     * conversation avatar source (the channel notification's left icon). The
     * icon is either a plain https URL (a NIP-29 kind-39000 `picture`) or an
     * encrypted-blob pointer the service fetches and AES-GCM decrypts itself
     * (Concord community icons — key/nonce/hash are shipped from the
     * WebView, the same trust model as the channel decrypt keys). A null/empty
     * image url ⇒ the notification shows the app icon only.
     */
    private static final class CommunityRef {
        final String groupKey;   // stable community key
        final String title;      // community/server display name
        final String url;        // community-level deep link (fallback tap target)
        final String imageUrl;   // https URL to fetch, or null
        final byte[] imgKey;     // AES-256-GCM key for an encrypted icon, or null
        final byte[] imgNonce;   // GCM nonce, or null
        final String imgHash;    // plaintext sha256 hex (cache key + integrity), or null

        CommunityRef(String groupKey, String title, String url,
                     String imageUrl, byte[] imgKey, byte[] imgNonce, String imgHash) {
            this.groupKey = groupKey;
            this.title = title;
            this.url = url;
            this.imageUrl = imageUrl;
            this.imgKey = imgKey;
            this.imgNonce = imgNonce;
            this.imgHash = imgHash;
        }

        boolean hasImage() {
            return imageUrl != null && !imageUrl.isEmpty();
        }

        /** Stable cache key for the resolved (decoded) icon bitmap. */
        String imageCacheKey() {
            return imgHash != null && !imgHash.isEmpty() ? "ci:h:" + imgHash : "ci:u:" + imageUrl;
        }
    }

    /**
     * One message line held in a room's notification. Raw data, not a built
     * MessagingStyle.Message: a sender avatar resolves late (network fetch),
     * so the line is matched by identity (sender + timestamp + text) and its
     * Message rebuilt at notify time (see {@link #buildRoomNotification}).
     */
    private static final class MsgEntry {
        final String senderKey;      // author pubkey (or a fallback key)
        final String senderName;
        Bitmap avatar;               // sender avatar; resolves late (may stay null)
        String text;                 // mutable: a failed reply rewrites its line in place
        final long tsMs;
        // True for a line the user sent from the Reply action — rendered as an
        // outgoing message (the MessagingStyle self person, no sender bubble).
        final boolean fromSelf;

        MsgEntry(String senderKey, String senderName, Bitmap avatar, String text, long tsMs,
                 boolean fromSelf) {
            this.senderKey = senderKey;
            this.senderName = senderName;
            this.avatar = avatar;
            this.text = text;
            this.tsMs = tsMs;
            this.fromSelf = fromSelf;
        }
    }

    /**
     * One conversation's accumulating notification: a single channel (NIP-29
     * group / Concord channel) or a single DM peer. Holds the room's display
     * title + deep-link, a bounded history of recent messages (for the
     * MessagingStyle expansion), and the stable notification id derived from
     * the roomKey. New messages append here and re-post the SAME id so a busy
     * room shows as a single, growing thread — not a flat stack of per-event
     * notifs.
     */
    private static final class RoomNotif {
        final String roomKey;
        final int notifId;
        String title;                // conversation/room name shown as the notif title
        String url;                  // deep-link of the LATEST message (tap target)
        // The community this room belongs to — its image/name brand the
        // notification. Null for DMs, which also makes it the room's
        // group-vs-1:1 discriminator (null ⇒ 1:1).
        CommunityRef community;
        final List<MsgEntry> messages = new ArrayList<>();
        long lastTimestampMs;
        // Most recent sender avatar seen for this room, used as the collapsed
        // notification's large icon (MessagingStyle Person icons only render in
        // the expanded view on many devices — the large icon is the fallback).
        Bitmap lastAvatar;

        RoomNotif(String roomKey, int notifId) {
            this.roomKey = roomKey;
            this.notifId = notifId;
        }
    }

    // Live instance so the plugin can route a signed AUTH event back to us.
    private static NotificationRelayService instance;

    /**
     * Called by the plugin once the WebView has signed a NIP-42 challenge.
     * Routes the kind-22242 event to the matching relay connection.
     */
    static void submitAuth(String relayUrl, String eventJson) {
        NotificationRelayService svc = instance;
        if (svc == null) return;
        svc.handler.post(() -> svc.deliverAuth(relayUrl, eventJson));
    }

    /**
     * Record the roomKey(s) the WebView is currently showing (empty = not on a
     * chat screen / app backgrounded). Called from the plugin's
     * {@code setActiveRooms} bridge method. Suppresses redundant notifications
     * for the rooms the user is already looking at.
     */
    static void setActiveRooms(Set<String> roomKeys) {
        Set<String> next = roomKeys != null ? roomKeys : new HashSet<>();
        // Copy into a ConcurrentHashMap-backed set so reads from the WebSocket
        // thread (handleEvent → isActivelyViewed) never race a concurrent
        // write from the Capacitor bridge thread. A plain HashSet can lose
        // visibility of puts across threads even with a volatile reference.
        Set<String> concurrent = java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
        concurrent.addAll(next);
        activeRoomKeys = concurrent;
        if (BuildConfig.DEBUG) Log.d(TAG, "setActiveRooms: " + concurrent);
    }

    /**
     * Cancel the tray notifications for conversations the WebView reports as
     * read (the in-app read state advanced — the user read them here, or it
     * synced from another device). Called from the plugin's {@code dismissRead}
     * bridge method. The reverse of a "Mark read" action tap: read state → tray,
     * instead of a tray tap → read state.
     *
     * @param readByKey WebView read-state key → last-read unix seconds
     *                  ({@code dm:<pk>}, {@code c2:<id>},
     *                  {@code <relayUrl>::<groupId>}).
     */
    static void dismissRead(java.util.Map<String, Long> readByKey) {
        NotificationRelayService svc = instance;
        if (svc == null || readByKey == null || readByKey.isEmpty()) return;
        // roomNotifs is confined to the main handler thread (onRelayMessage
        // posts there), so mutate it there too — never from the bridge thread.
        svc.handler.post(() -> svc.applyDismissRead(readByKey));
    }

    /**
     * Cancel each posted room whose newest notified message is at/older than
     * the read timestamp the WebView reports for that conversation, and drop its
     * accumulated history so a later message starts fresh rather than
     * resurrecting read lines. A room with a newer unread message is left up.
     */
    private void applyDismissRead(java.util.Map<String, Long> readByKey) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        java.util.Iterator<Map.Entry<String, RoomNotif>> it = roomNotifs.entrySet().iterator();
        while (it.hasNext()) {
            RoomNotif r = it.next().getValue();
            String readKey = readKeyForRoom(r.roomKey);
            if (readKey == null) continue;
            Long readTsSec = readByKey.get(readKey);
            if (readTsSec == null) continue;
            if (readTsSec * 1000L >= r.lastTimestampMs) {
                manager.cancel(r.notifId);
                it.remove();
                if (BuildConfig.DEBUG) Log.d(TAG, "DISMISS (read): " + r.roomKey);
            }
        }
    }

    /**
     * The WebView read-state key for a notification room, or null when the room
     * can't be attributed to a conversation (an opaque NIP-17 wrap the service
     * couldn't unwrap). Inverse of {@code NativeReadMarkerSync}'s mapping:
     *   {@code dm:<pk>}            → {@code dm:<pk>}            (unchanged)
     *   {@code c2:<channelId>}     → {@code c2:<channelId>}    (unchanged)
     *   {@code h:<relayUrl>|<gid>} → {@code <relayUrl>::<gid>}
     */
    private String readKeyForRoom(String roomKey) {
        if (roomKey == null) return null;
        if (roomKey.startsWith("dm:") || roomKey.startsWith("c2:")) return roomKey;
        if (roomKey.startsWith("h:")) {
            String rest = roomKey.substring(2);
            int i = rest.lastIndexOf('|');
            return i > 0 ? rest.substring(0, i) + "::" + rest.substring(i + 1) : null;
        }
        return null;
    }

    private void deliverAuth(String relayUrl, String eventJson) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl)) {
                rc.sendAuth(eventJson);
                return;
            }
        }
    }

    // ── Lifecycle helpers (boot, watchdog, Application eager start) ────────────

    /** True when background notifications are enabled and a user is logged in. */
    static boolean isConfigured(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(
                ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        return sp.getBoolean("enabled", false) && sp.getString("userPubkey", null) != null;
    }

    static void startIfConfigured(Context ctx) {
        startIfConfigured(ctx, true);
    }

    /**
     * Start the service iff it's configured and not already running.
     *
     * The running check matters: every caller here (boot, retry alarm,
     * watchdog, ArmadaApplication) only wants "ensure the service is up".
     * Delivering a redundant start to a live service would run
     * onStartCommand → loadConfigAndReconnect, which tears down and rebuilds
     * every relay socket — so a 15-min watchdog would churn healthy
     * connections (re-handshake, re-AUTH, rebuild the signer) and open a
     * recurring miss window for the live-only NIP-17 DM subscription. All
     * parties touch {@code instance} on the main thread, so the check is
     * race-free.
     *
     * specialUse can be started from boot, but a background FGS start can
     * still be refused in some states (throwing
     * ForegroundServiceStartNotAllowedException). When {@code allowRetry} is
     * set we schedule a short one-shot retry alarm, which succeeds once the
     * app is exempt from battery optimizations; the retry/watchdog alarms
     * pass {@code false} so they don't stack retries.
     */
    static void startIfConfigured(Context ctx, boolean allowRetry) {
        if (instance != null) return;
        if (!isConfigured(ctx)) return;
        Intent i = new Intent(ctx, NotificationRelayService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Exception e) {
            if (allowRetry && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && e instanceof ForegroundServiceStartNotAllowedException) {
                BootReceiver.scheduleRetry(ctx);
            } else {
                Log.w(TAG, "startIfConfigured failed", e);
            }
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannels();
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                    ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    : 0;
            ServiceCompat.startForeground(this, FOREGROUND_ID, buildForegroundNotification(), type);
        } catch (Exception e) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && e instanceof ForegroundServiceStartNotAllowedException) {
                Log.w(TAG, "Foreground start not allowed, stopping.");
                stopSelf();
                return;
            }
            throw e;
        }

        httpClient = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .pingInterval(30, TimeUnit.SECONDS) // keep the socket alive + detect drops
                .build();

        // Avatar/image fetches: bounded timeouts (so a slow host can't stall the
        // silent re-post forever) + a disk HTTP cache. Derived from httpClient so
        // it reuses the same dispatcher/connection pool, but its callTimeout must
        // NOT leak onto the WebSocket client above.
        avatarDir = new File(getCacheDir(), "avatars");
        avatarClient = httpClient.newBuilder()
                .readTimeout(15, TimeUnit.SECONDS)
                .callTimeout(30, TimeUnit.SECONDS)
                .pingInterval(0, TimeUnit.SECONDS) // no pings on one-shot image GETs
                .cache(new Cache(new File(getCacheDir(), "avatar-http"), AVATAR_HTTP_CACHE_BYTES))
                .build();

        sinceSec = System.currentTimeMillis() / 1000;
        profileStore = ProfileStore.deserialize(
                getSharedPreferences(PROFILES_PREFS, Context.MODE_PRIVATE)
                        .getString(PROFILES_KEY, null));
        registerNetworkCallback();
        registerConfigListener();
        cancelStaleSummaries();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A "Mark read" action tap arrives as a start intent. Handle it WITHOUT
        // running loadConfigAndReconnect (which tears down + rebuilds every relay
        // socket) so acknowledging a notification doesn't churn live connections.
        if (intent != null && ACTION_MARK_READ.equals(intent.getAction())) {
            BootReceiver.scheduleWatchdog(this);
            // Cold-started just for this action (process was dead): load the
            // config first so the relay subscriptions come up AND the z→channel
            // map the read-marker needs is populated before handleMarkRead reads it.
            if (connections.isEmpty()) loadConfigAndReconnect();
            handleMarkRead(intent);
            return START_STICKY;
        }
        // A "Reply" action tap arrives the same way, and likewise must not
        // rebuild the relay sockets — the publish rides the live ones (or the
        // per-connection outbox, when cold-started and still connecting).
        if (intent != null && ACTION_REPLY.equals(intent.getAction())) {
            BootReceiver.scheduleWatchdog(this);
            if (connections.isEmpty()) loadConfigAndReconnect();
            handleReply(intent);
            return START_STICKY;
        }
        // Re-arm the self-healing watchdog on every start so it survives a
        // START_STICKY relaunch. It's cancelled when the user turns
        // notifications off (loadConfigAndReconnect's disabled branch).
        BootReceiver.scheduleWatchdog(this);
        loadConfigAndReconnect();
        return START_STICKY;
    }

    /**
     * Defensive: the service runs as a specialUse foreground service, which is
     * NOT subject to Android 15's dataSync/mediaProcessing runtime cap, so this
     * shouldn't fire. It's kept as a safety net in case the type ever changes:
     * onTimeout requires stopping within seconds (or the app is killed for
     * "foreground service did not stop"), after which the watchdog alarm / the
     * next app launch (ArmadaApplication) brings the service back.
     */
    @Override
    public void onTimeout(int startId) {
        handleTimeout();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        handleTimeout();
    }

    private void handleTimeout() {
        Log.w(TAG, "Foreground service timed out; stopping, watchdog will retry.");
        BootReceiver.scheduleWatchdog(this);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (instance == this) instance = null;
        NativeSigner signer = nativeSigner;
        nativeSigner = null;
        if (signer != null) signer.close();
        closeAllConnections();
        unregisterNetworkCallback();
        unregisterConfigListener();
        handler.removeCallbacksAndMessages(null);
        // Flush any debounced profile writes so the next service instance
        // starts with the warm cache (apply() is async but safe here).
        if (profilePersistScheduled) {
            profilePersistScheduled = false;
            persistProfiles();
        }
        if (avatarClient != null && avatarClient.cache() != null) {
            try {
                avatarClient.cache().close(); // flush the HTTP disk cache
            } catch (Exception ignored) {
                // Best-effort flush; the process is going away regardless.
            }
        }
        if (httpClient != null) {
            // avatarClient shares this dispatcher (derived via newBuilder), so
            // one shutdown drains both clients' worker threads.
            httpClient.dispatcher().executorService().shutdownNow();
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── Config ────────────────────────────────────────────────────────────────

    private void loadConfigAndReconnect() {
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        if (!sp.getBoolean("enabled", false)) {
            Log.d(TAG, "Disabled in config; stopping.");
            BootReceiver.cancelWatchdog(this);
            stopSelf();
            return;
        }
        userPubkey = sp.getString("userPubkey", null);
        relayUrls.clear();
        relayUrls.addAll(parseStringArray(sp.getString("relayUrls", null)));
        groupIds.clear();
        groupIds.addAll(parseStringArray(sp.getString("groupIds", null)));
        parseGroupSubs(sp.getString("groupSubs", null),
                parseStringArray(sp.getString("mentionOnlyGroupIds", null)));
        dmRelays.clear();
        dmRelays.addAll(parseStringArray(sp.getString("dmRelays", null)));
        dmFollows.clear();
        dmFollows.addAll(parseStringArray(sp.getString("dmFollows", null)));
        dmKnownPeers.clear();
        dmKnownPeers.addAll(parseStringArray(sp.getString("dmKnownPeers", null)));
        dmRequests = sp.getString("dmRequests", "generic");
        selfRelays.clear();
        selfRelays.addAll(parseStringArray(sp.getString("selfRelays", null)));
        try {
            String p = sp.getString("prefs", null);
            prefs = p != null ? new JSONObject(p) : new JSONObject();
        } catch (JSONException e) {
            prefs = new JSONObject();
        }
        parseConcordSubs(sp.getString("concord2Subs", null));
        parseGitSubs(sp.getString("gitSubs", null));

        // The user's shared signer credential (Keystore-sealed by the plugin):
        // lets the service open ANY gift wrap addressed to the user and answer
        // NIP-42 AUTH itself — see NativeSigner. Absent/undecryptable ⇒ null,
        // and DM wraps degrade to the generic notification.
        NativeSigner oldSigner = nativeSigner;
        nativeSigner = null;
        if (oldSigner != null) oldSigner.close();
        String sealedSigner = sp.getString("signerSealed", null);
        if (sealedSigner != null) {
            String signerJson = SealedStore.open(sealedSigner);
            if (signerJson != null) {
                try {
                    nativeSigner = NativeSigner.from(this, httpClient, userPubkey, new JSONObject(signerJson));
                } catch (JSONException e) {
                    Log.w(TAG, "signer config unreadable");
                }
            }
            if (nativeSigner == null) Log.w(TAG, "shared signer credential unavailable");
        }

        // The relays to connect to: NIP-29 group relays ∪ DM relays ∪ Concord
        // relays ∪ the general relays carrying the user's own documents.
        Set<String> allRelays = new LinkedHashSet<>(relayUrls);
        allRelays.addAll(relayToGroupIds.keySet());
        allRelays.addAll(dmRelays);
        allRelays.addAll(selfRelays);
        allRelays.addAll(relayToPks2.keySet());
        allRelays.addAll(gitRepositoriesByRelay.keySet());

        if (userPubkey == null || allRelays.isEmpty()) {
            Log.d(TAG, "No pubkey/relays; not connecting.");
            closeAllConnections();
            return;
        }

        // Rebuild all connections with the current filters.
        closeAllConnections();
        for (String url : allRelays) {
            RelayConnection rc = new RelayConnection(url);
            connections.add(rc);
            rc.connect();
        }

        // Warm the user's own profile for the quick-reply self person, now
        // that a relay fetch has somewhere to go if the store misses.
        warmSelfProfile();
    }

    /**
     * Build a {@link CommunityRef} from a subscription's community fields. The
     * optional {@code communityImage} object is the conversation's avatar: either
     * a plain https URL ({@code {url}} only) or an encrypted-blob pointer
     * ({@code {url,key,nonce,hash}} hex) the service fetches and AES-GCM
     * decrypts itself. Key/nonce present but malformed ⇒ treated as no image.
     */
    private static CommunityRef communityRefFromSub(
            JSONObject sub, String groupKey, String title, String url) {
        String imageUrl = null;
        byte[] imgKey = null;
        byte[] imgNonce = null;
        String imgHash = null;
        JSONObject img = sub.optJSONObject("communityImage");
        if (img != null) {
            String u = img.optString("url", "");
            if (!u.isEmpty()) {
                imageUrl = u;
                byte[] k = ConcordCrypto.hexToBytes(img.optString("key", null));
                byte[] n = ConcordCrypto.hexToBytes(img.optString("nonce", null));
                // An encrypted pointer needs BOTH key and nonce; a plain URL has
                // neither. A half-present pair is unusable — fall back to plain.
                if (k != null && n != null) {
                    imgKey = k;
                    imgNonce = n;
                }
                String h = img.optString("hash", "");
                imgHash = h.isEmpty() ? null : h;
            }
        }
        return new CommunityRef(groupKey, title, url, imageUrl, imgKey, imgNonce, imgHash);
    }

    /**
     * Parse the NIP-29 group subscriptions JSON ([{relay,id}, …]) into
     * {@link #relayToGroupIds}: each joined group mapped to its single host
     * relay, so the kind-9/7/1111 REQ on a relay carries only the groups that
     * relay actually hosts. Falls back — when the config carries no
     * {@code groupSubs} (written by an older build) — to the legacy flat model:
     * every {@code groupId} on every {@code relayUrl}.
     *
     * <p>Also fills {@link #mentionOnlyGroupKeys} from each sub's
     * {@code mentionOnly} flag. {@code flatMentionOnly} is the older flat
     * {@code mentionOnlyGroupIds} list and is used ONLY on the legacy fallback
     * path, where every id is already paired with every relay anyway.
     */
    private void parseGroupSubs(String json, List<String> flatMentionOnly) {
        relayToGroupIds.clear();
        mentionOnlyGroupKeys.clear();
        if (json != null) {
            try {
                JSONArray arr = new JSONArray(json);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject sub = arr.optJSONObject(i);
                    if (sub == null) continue;
                    String relay = sub.optString("relay", "");
                    String id = sub.optString("id", "");
                    if (relay.isEmpty() || id.isEmpty()) continue;
                    Set<String> set = relayToGroupIds.get(relay);
                    if (set == null) {
                        set = new LinkedHashSet<>();
                        relayToGroupIds.put(relay, set);
                    }
                    set.add(id);
                    if (sub.optBoolean("mentionOnly", false)) {
                        mentionOnlyGroupKeys.add(groupKey(relay, id));
                    }
                }
                return;
            } catch (JSONException e) {
                Log.w(TAG, "Failed to parse groupSubs", e);
                relayToGroupIds.clear();
                mentionOnlyGroupKeys.clear();
            }
        }
        // Legacy fallback: no per-relay mapping shipped — subscribe every
        // joined group on every group relay (imprecise, but keeps an older
        // config working until the WebView reconfigures with groupSubs).
        if (groupIds.isEmpty()) return;
        for (String relay : relayUrls) {
            relayToGroupIds.put(relay, new LinkedHashSet<>(groupIds));
            for (String id : flatMentionOnly) {
                if (groupIds.contains(id)) mentionOnlyGroupKeys.add(groupKey(relay, id));
            }
        }
    }

    private static String groupKey(String relayUrl, String groupId) {
        return relayUrl + "\u0000" + groupId;
    }

    /**
     * Is this NIP-29 group set to "mentions only"? A group we can't identify
     * (no `h` tag) is not — the per-kind prefs still decide.
     */
    private boolean isMentionOnlyGroup(String relayUrl, String groupId) {
        if (relayUrl == null || groupId == null) return false;
        return mentionOnlyGroupKeys.contains(groupKey(relayUrl, groupId));
    }

    /**
     * Parse the Concord subscriptions JSON
     * ([{relays:[],communityId,communityName,channelId,channelName,
     *    streams:[{pk,convKey,epoch}]}, …])
     * into the lookup maps: stream-pubkey→decrypt-material and relay→{pk…}.
     * V2 traffic is kind-1059 wraps AUTHORED BY the derived stream keys (no
     * routing tag); the per-stream conversation key opens wrap → seal → rumor
     * for a rich "<sender>: <preview>" body.
     */
    private void parseConcordSubs(String json) {
        pkToStream2.clear();
        relayToPks2.clear();
        if (json == null) return;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject sub = arr.optJSONObject(i);
                if (sub == null) continue;
                String community = sub.optString("communityName", "Community");
                String channel = sub.optString("channelName", "channel");
                String communityId = sub.optString("communityId", "");
                String channelId = sub.optString("channelId", "");
                if (communityId.isEmpty() || channelId.isEmpty()) continue;
                boolean mentionOnly = sub.optBoolean("mentionOnly", false);
                String name = community + " / #" + channel;
                String url = "/c/" + uriEncode(communityId) + "/" + uriEncode(channelId);
                JSONArray streams = sub.optJSONArray("streams");
                JSONArray relays = sub.optJSONArray("relays");
                if (streams == null || relays == null) continue;

                // The community this channel belongs to — its image/name
                // brand the channel's notification. The community ref
                // deep-links to the community; the notification itself links
                // to the channel.
                CommunityRef ref = communityRefFromSub(
                        sub, GROUP_PREFIX + "c2:" + communityId, community,
                        "/c/" + uriEncode(communityId));

                List<String> pkList = new ArrayList<>();
                for (int j = 0; j < streams.length(); j++) {
                    JSONObject s = streams.optJSONObject(j);
                    if (s == null) continue;
                    String pk = s.optString("pk", null);
                    byte[] convKey = ConcordCrypto.hexToBytes(s.optString("convKey", null));
                    if (pk == null || pk.isEmpty() || convKey == null || convKey.length != 32) continue;
                    pkList.add(pk);
                    pkToStream2.put(pk, new ConcordStream(
                            convKey, communityId, channelId, s.optString("epoch", ""),
                            name, url, ref, Math.max(0, sub.optLong("timerSecs", 0)),
                            mentionOnly));
                }
                for (int j = 0; j < relays.length(); j++) {
                    String relay = relays.optString(j);
                    if (relay == null || relay.isEmpty()) continue;
                    Set<String> set = relayToPks2.get(relay);
                    if (set == null) {
                        set = new LinkedHashSet<>();
                        relayToPks2.put(relay, set);
                    }
                    set.addAll(pkList);
                }
            }
        } catch (JSONException e) {
            Log.w(TAG, "Failed to parse concordSubs", e);
        }
    }

    /** Parse additive schema-v2 Git configuration. Bad/old records are ignored,
     * preserving the original notification planes. */
    private void parseGitSubs(String json) {
        gitRepositories.clear(); gitRepositoriesByRelay.clear();
        if (json == null) return;
        try {
            JSONArray all = new JSONArray(json);
            for (int i = 0; i < all.length(); i++) {
                JSONObject value = all.optJSONObject(i); if (value == null) continue;
                String address = value.optString("address", "");
                String owner = value.optString("owner", "");
                if (!validRepositoryAddress(address) || !validHex(owner) || !owner.equals(address.split(":", 3)[1])) continue;
                GitRepository repository = new GitRepository(address, owner);
                JSONArray maintainers = value.optJSONArray("maintainers");
                if (maintainers != null) for (int j = 0; j < maintainers.length(); j++) {
                    String pk = maintainers.optString(j); if (validHex(pk)) repository.maintainers.add(pk);
                }
                JSONArray attachments = value.optJSONArray("attachments");
                if (attachments != null) for (int j = 0; j < attachments.length(); j++) {
                    JSONObject a = attachments.optJSONObject(j); if (a == null) continue;
                    String community = a.optString("communityId", ""), channel = a.optString("channelId", "");
                    long attached = a.optLong("attachedAt", -1), detached = a.has("detachedAt") ? a.optLong("detachedAt", -1) : -1;
                    if (!community.isEmpty() && !channel.isEmpty() && attached >= 0 && (detached < 0 || detached >= attached)) repository.attachments.add(new GitAttachment(community, channel, attached, detached));
                }
                JSONArray roots = value.optJSONArray("ticketRoots");
                if (roots != null) for (int j = 0; j < roots.length(); j++) {
                    JSONObject root = roots.optJSONObject(j); if (root == null) continue;
                    String id = root.optString("id", ""), author = root.optString("author", ""); int kind = root.optInt("kind", 0);
                    if (validHex(id) && validHex(author) && (kind == 1618 || kind == 1621)) repository.roots.put(id, new GitRoot(id, author, kind));
                }
                if (repository.attachments.isEmpty()) continue;
                gitRepositories.put(address, repository);
                JSONArray relays = value.optJSONArray("relays");
                if (relays != null && repository.live()) for (int j = 0; j < relays.length(); j++) {
                    String relay = relays.optString(j, "");
                    // The client resolves which relay is the discovery index and
                    // drops it before writing gitSubs, so these are activity
                    // relays only; the service holds no host of its own.
                    if (relay.isEmpty()) continue;
                    Set<String> addresses = gitRepositoriesByRelay.get(relay);
                    if (addresses == null) gitRepositoriesByRelay.put(relay, addresses = new LinkedHashSet<>());
                    addresses.add(address);
                }
            }
        } catch (JSONException e) { Log.w(TAG, "Failed to parse gitSubs", e); }
    }

    private static boolean validHex(String value) { return value != null && value.matches("[0-9a-f]{64}"); }
    private static boolean validRepositoryAddress(String value) {
        return value != null && value.matches("30617:[0-9a-f]{64}:.+");
    }

    // ── Per-relay connection ────────────────────────────────────────────────

    private class RelayConnection {
        final String relayUrl;
        WebSocket ws;
        long backoffMs = INITIAL_BACKOFF_MS;
        boolean closed = false;

        // When the current connection attempt started (main thread only).
        // Used by scheduleReconnect to distinguish "stable connection finally
        // died" (reset backoff) from "relay drops us right away" (keep growing).
        long connectAttemptAt = 0;

        // Single pending reconnect, cancellable — prevents a queued reconnect
        // and the network callback from racing to open duplicate sockets.
        final Runnable reconnectRunnable = this::connect;

        final String subGroups = "ag-" + Long.toHexString(System.nanoTime());
        final String subDirect = "ad-" + Long.toHexString(System.nanoTime() + 1);
        final String subDm = "am-" + Long.toHexString(System.nanoTime() + 3);
        // Prefix for one-shot kind-0 profile lookups. The sub id embeds only a
        // TRUNCATED key (see shortKey) so it stays within NIP-01's customary
        // 64-char subscription-id cap — strfry-family relays reject longer ids
        // with "invalid subscription id length" (#50). The full pubkey/groupId
        // is recovered through the lookup maps below, not the sub id.
        final String profilePrefix = "ap-" + Long.toHexString(System.nanoTime() + 4) + "-";
        // Prefix for one-shot kind-39000 group-metadata lookups.
        final String groupPrefix = "ah-" + Long.toHexString(System.nanoTime() + 5) + "-";
        final String subConcord = "a2-" + Long.toHexString(System.nanoTime() + 6);
        final String subDm17 = "a7-" + Long.toHexString(System.nanoTime() + 7);
        final String subGitRoots = "ag-" + Long.toHexString(System.nanoTime() + 8);
        final String subGitChildren = "ai-" + Long.toHexString(System.nanoTime() + 9);
        final String subSelf = "as-" + Long.toHexString(System.nanoTime() + 11);
        // Prefix for one-shot kind-10050 DM-inbox lookups (reply addressing).
        final String inboxPrefix = "ax-" + Long.toHexString(System.nanoTime() + 10) + "-";
        // One-shot lookup sub id → the full pubkey / group id it was issued
        // for. Entries are removed when the lookup resolves; capped clears
        // protect against relays that never answer.
        final Map<String, String> profileLookups = new HashMap<>();
        final Map<String, String> groupLookups = new HashMap<>();
        final Map<String, String> inboxLookups = new HashMap<>();
        // In-flight reply publishes (event id → waiter) awaiting this relay's
        // OK, and frames queued while the socket is down (flushed on the next
        // open) — how a reply typed on a cold-started service survives the
        // connect. Main-thread confined, like everything else here.
        final Map<String, PendingPublish> pendingPublishes = new HashMap<>();
        final List<PendingPublish> outbox = new ArrayList<>();
        // ids of the kind-22242s we sent and haven't seen an OK for. NIP-42
        // allows several AUTHs per connection (the user + every Concord
        // stream key), so this is a set; a relay's OK for some other event
        // can't trigger a REQ re-send.
        final Set<String> pendingAuthIds = new HashSet<>();
        // Backoff for relay-initiated CLOSED resubscribes (#49): a relay that
        // drops a standing sub (restart, transient error, rate limit) earns a
        // DELAYED re-REQ with a growing gap, never an instant retry loop.
        // Reset when a fresh socket session opens.
        long subRetryBackoffMs = INITIAL_BACKOFF_MS;
        final Runnable resubscribeRunnable = () -> {
            if (!closed && ws != null) sendReqs(ws);
        };
        // Coalesces the REQ re-send that follows AUTH acks (#49): the user +
        // every Concord stream key each get their own OK, so an auth round
        // used to trigger one full sendReqs PER OK — dozens of duplicate REQ
        // bursts per challenge. One re-send shortly after the burst settles
        // covers them all.
        boolean authResendPending = false;
        final Runnable authResendRunnable = () -> {
            authResendPending = false;
            if (!closed && ws != null) sendReqs(ws);
        };

        /** Re-send REQs shortly, collapsing a burst of AUTH OKs into one round. */
        void scheduleAuthResend() {
            if (authResendPending) return;
            authResendPending = true;
            handler.postDelayed(authResendRunnable, 300);
        }

        RelayConnection(String relayUrl) {
            this.relayUrl = relayUrl;
        }

        void connect() {
            // ws != null guard: a socket is already open (or opening). Without
            // it, a stale queued reconnect firing after the network callback
            // already reconnected would open a second socket and orphan the
            // first — leaked sockets keep pinging and re-failing forever.
            if (closed || ws != null || !isNetworkAvailable()) return;
            connectAttemptAt = System.currentTimeMillis();
            Request request = new Request.Builder().url(relayUrl).build();
            ws = httpClient.newWebSocket(request, new WebSocketListener() {
                @Override
                public void onOpen(WebSocket webSocket, Response response) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "WS open: " + relayUrl);
                    // A fresh socket session: CLOSED-resubscribe backoff starts
                    // over, and a pending auth re-send belongs to the old session.
                    handler.post(() -> {
                        subRetryBackoffMs = INITIAL_BACKOFF_MS;
                        handler.removeCallbacks(resubscribeRunnable);
                        authResendPending = false;
                        handler.removeCallbacks(authResendRunnable);
                        flushOutbox(webSocket);
                    });
                    sendReqs(webSocket);
                }

                @Override
                public void onMessage(WebSocket webSocket, String text) {
                    handler.post(() -> onRelayMessage(text, relayUrl));
                }

                @Override
                public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                    Log.w(TAG, "WS failure (" + relayUrl + "): " + t.getMessage());
                    handler.post(RelayConnection.this::scheduleReconnect);
                }

                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    handler.post(() -> {
                        if (!closed) scheduleReconnect();
                    });
                }
            });
        }

        void sendReqs(WebSocket webSocket) {
            try {
                // NIP-29 groups hosted on THIS relay (a group lives on exactly
                // one relay, so we only ask each relay for its own groups).
                Set<String> myGroups = relayToGroupIds.get(relayUrl);
                if (myGroups != null && !myGroups.isEmpty()) {
                    JSONArray h = new JSONArray();
                    for (String id : myGroups) h.put(id);

                    // Group messages: kind 9 in the groups this relay hosts.
                    JSONObject f = new JSONObject();
                    f.put("kinds", new JSONArray().put(9));
                    f.put("#h", h);
                    f.put("since", sinceSec);
                    webSocket.send(reqMessage(subGroups, f));

                    // Reactions/replies to me, scoped to those groups so the
                    // query is a valid NIP-29 request (relays reject a #p-only
                    // filter with "must have 'h','e' or 'a' tag").
                    JSONObject f2 = new JSONObject();
                    f2.put("kinds", new JSONArray().put(7).put(1111));
                    f2.put("#h", h);
                    f2.put("#p", new JSONArray().put(userPubkey));
                    f2.put("since", sinceSec);
                    webSocket.send(reqMessage(subDirect, f2));
                }
                // Direct messages (kind 4) addressed to me, on the DM/app relays
                // (NOT the NIP-29 group relays — DMs don't live there). Scoped to
                // `authors:[...dmFollows]` so only DMs from people I follow notify
                // (permanent friends-only). No follows ⇒ no DM subscription.
                if (dmRelays.contains(relayUrl) && !dmFollows.isEmpty()) {
                    JSONObject f4 = new JSONObject();
                    f4.put("kinds", new JSONArray().put(4));
                    JSONArray dmAuthors = new JSONArray();
                    for (String pk : dmFollows) dmAuthors.put(pk);
                    f4.put("authors", dmAuthors);
                    f4.put("#p", new JSONArray().put(userPubkey));
                    f4.put("since", sinceSec);
                    webSocket.send(reqMessage(subDm, f4));
                }
                // NIP-17 gift-wrapped DMs (kind 1059) addressed to me, on the
                // DM/app relays. The wrap AUTHOR hides the sender, so this can't
                // be authors-scoped — it's a broad `#p` inbox filter. Each wrap
                // is opened with the shared signer credential (NativeSigner) for
                // a rich "<sender>: <preview>" notification in handleDm17Wrap.
                // `since` rewinds the NIP-59 backdate window (a wrap's outer
                // created_at is up to 2 days in the past, so `since = sinceSec`
                // never matches a live wrap) and `limit: 0` skips the stored
                // replay that rewind would otherwise pull in (live-only).
                if (dmRelays.contains(relayUrl) && prefBool("directMessages", true)) {
                    JSONObject f6 = new JSONObject();
                    f6.put("kinds", new JSONArray().put(1059));
                    f6.put("#p", new JSONArray().put(userPubkey));
                    f6.put("since", Math.max(0, sinceSec - DM17_SINCE_REWIND_SEC));
                    f6.put("limit", 0);
                    webSocket.send(reqMessage(subDm17, f6));
                }
                // Concord channel wraps on this relay: kind-1059 events
                // AUTHORED BY the derived stream keys (no routing tag at all).
                Set<String> pks = relayToPks2.get(relayUrl);
                if (pks != null && !pks.isEmpty()) {
                    JSONObject f5 = new JSONObject();
                    f5.put("kinds", new JSONArray().put(1059));
                    JSONArray authors = new JSONArray();
                    for (String pk : pks) authors.put(pk);
                    f5.put("authors", authors);
                    f5.put("since", sinceSec);
                    webSocket.send(reqMessage(subConcord, f5));
                }
                Set<String> repositories = gitRepositoriesByRelay.get(relayUrl);
                if (repositories != null && !repositories.isEmpty()) {
                    JSONObject roots = new JSONObject(); roots.put("kinds", new JSONArray().put(1618).put(1621));
                    JSONArray addresses = new JSONArray(); for (String address : repositories) addresses.put(address);
                    roots.put("#a", addresses); roots.put("since", sinceSec);
                    webSocket.send(reqMessage(subGitRoots, roots));
                    // Root children are bounded like the TS wire (100 ids/filter), with
                    // NIP-22's uppercase E and NIP-34 status's lowercase e kept separate.
                    List<String> ids = new ArrayList<>();
                    for (String address : repositories) { GitRepository repo = gitRepositories.get(address); if (repo != null) ids.addAll(repo.roots.keySet()); }
                    java.util.Collections.sort(ids);
                    for (int offset = 0; offset < ids.size(); offset += GIT_ROOT_FILTER_CHUNK_SIZE) {
                        JSONArray chunk = new JSONArray(); for (String root : ids.subList(offset, Math.min(ids.size(), offset + GIT_ROOT_FILTER_CHUNK_SIZE))) chunk.put(root);
                        JSONObject comments = new JSONObject(); comments.put("kinds", new JSONArray().put(1111)); comments.put("#E", chunk); comments.put("since", sinceSec);
                        webSocket.send(reqMessage(subGitChildren + "c" + offset, comments));
                        JSONObject statuses = new JSONObject(); statuses.put("kinds", new JSONArray().put(1630).put(1631).put(1632).put(1633)); statuses.put("#e", chunk); statuses.put("since", sinceSec);
                        webSocket.send(reqMessage(subGitChildren + "s" + offset, statuses));
                    }
                }
                // The user's OWN replaceable documents (SelfState): follow and
                // mute lists, the NIP-29 server/channel list, the Concord
                // vaults, DM/Blossom/emoji lists, and the NIP-78 settings
                // document that carries the community rail's arrangement.
                //
                // Watched on the general relays and on the NIP-29 servers,
                // because that is where the client publishes them (its event
                // router fans a write out to the app relays, the user's servers
                // and their NIP-65 write set) — so this is the set on which
                // another device's change can actually be found.
                //
                // Deliberately NO `since`, unlike every other filter here. All
                // of these are replaceable, so a relay stores exactly one
                // version and an unbounded filter returns a handful of events;
                // a `since` would only mean that a change made while this
                // device was off is never seen at all, which is the whole
                // failure this subscription exists to fix. It also makes every
                // reconnect a full catch-up for free.
                if (userPubkey != null && !userPubkey.isEmpty()
                        && (selfRelays.contains(relayUrl) || relayUrls.contains(relayUrl))) {
                    JSONArray me = new JSONArray().put(userPubkey);

                    JSONArray selfKinds = new JSONArray();
                    for (int kind : SelfState.KINDS) selfKinds.put(kind);
                    JSONObject bare = new JSONObject();
                    bare.put("kinds", selfKinds);
                    bare.put("authors", me);

                    // Kind 30078 is shared with every other NIP-78 client on
                    // this identity, so it is asked for by `d` rather than
                    // wholesale.
                    JSONArray dTags = new JSONArray();
                    for (String d : SelfState.D_TAGS) dTags.put(d);
                    JSONObject documents = new JSONObject();
                    documents.put("kinds", new JSONArray().put(SelfState.KIND_APP_SPECIFIC));
                    documents.put("authors", me);
                    documents.put("#d", dTags);

                    // The GIF-favorite shards are named by topic, not by `d`.
                    JSONObject shards = new JSONObject();
                    shards.put("kinds", new JSONArray().put(SelfState.KIND_APP_SPECIFIC));
                    shards.put("authors", me);
                    shards.put("#t", new JSONArray().put(SelfState.TOPIC_GIF_FAVORITES));

                    webSocket.send(reqMessage(subSelf, bare, documents, shards));
                }
            } catch (JSONException e) {
                Log.w(TAG, "Failed to build REQ", e);
            }
        }

        /**
         * Send (or queue, while the socket is down) an EVENT frame, resolving
         * the callback on this relay's OK — or on the publisher's timeout.
         */
        void publish(JSONObject event, PublishCallback cb) {
            String eventId = event.optString("id", "");
            PendingPublish p = new PendingPublish(eventId,
                    new JSONArray().put("EVENT").put(event).toString(), cb);
            if (ws != null) {
                pendingPublishes.put(eventId, p);
                ws.send(p.frame);
            } else {
                outbox.add(p);
            }
        }

        /** Flush publishes queued while the socket was down (main thread). */
        void flushOutbox(WebSocket webSocket) {
            if (closed || outbox.isEmpty()) return;
            for (PendingPublish p : outbox) {
                pendingPublishes.put(p.eventId, p);
                webSocket.send(p.frame);
            }
            outbox.clear();
        }

        void sendAuth(String eventJson) {
            if (ws == null) return;
            try {
                JSONObject event = new JSONObject(eventJson);
                String eid = event.optString("id", null);
                if (eid != null && !eid.isEmpty()) pendingAuthIds.add(eid);
                JSONArray auth = new JSONArray();
                auth.put("AUTH");
                auth.put(event);
                ws.send(auth.toString());
                if (BuildConfig.DEBUG) Log.d(TAG, "Sent AUTH to " + relayUrl);
            } catch (JSONException e) {
                Log.w(TAG, "Failed to send AUTH", e);
            }
        }

        /**
         * Fire a one-shot kind-0 REQ for {@code pubkey}. The matching EVENT is
         * picked up in {@link #onRelayMessage} (sub id starts with
         * {@link #profilePrefix}); the relay's EOSE / our timeout closes it.
         */
        void fetchProfile(String pubkey) {
            if (closed || ws == null) return;
            try {
                JSONObject f = new JSONObject();
                f.put("kinds", new JSONArray().put(0));
                f.put("authors", new JSONArray().put(pubkey));
                f.put("limit", 1);
                ws.send(reqMessage(profileSubId(pubkey), f));
            } catch (JSONException e) {
                if (BuildConfig.DEBUG) Log.w(TAG, "Failed to build profile REQ", e);
            }
        }

        /**
         * Fire a one-shot kind-39000 (NIP-29 group metadata) REQ for
         * {@code groupId}, scoped with a `#d` filter. The EVENT is picked up in
         * {@link #onRelayMessage} (sub id starts with {@link #groupPrefix}).
         */
        void fetchGroupName(String groupId) {
            if (closed || ws == null) return;
            try {
                JSONObject f = new JSONObject();
                f.put("kinds", new JSONArray().put(39000));
                f.put("#d", new JSONArray().put(groupId));
                f.put("limit", 1);
                ws.send(reqMessage(groupSubId(groupId), f));
            } catch (JSONException e) {
                if (BuildConfig.DEBUG) Log.w(TAG, "Failed to build group-name REQ", e);
            }
        }

        /**
         * The sub id for a one-shot profile lookup, registered in
         * {@link #profileLookups} so the full pubkey can be recovered. Embeds
         * only a truncated key: relays commonly cap subscription ids at 64
         * chars and reject longer ones outright, so `prefix + full 64-hex
         * pubkey` (~84 chars) meant those relays' notifications never fired (#50).
         */
        String profileSubId(String pubkey) {
            String subId = profilePrefix + shortKey(pubkey);
            if (profileLookups.size() > 512) profileLookups.clear();
            profileLookups.put(subId, pubkey);
            return subId;
        }

        /** Group-metadata analogue of {@link #profileSubId}. */
        String groupSubId(String groupId) {
            String subId = groupPrefix + shortKey(groupId);
            if (groupLookups.size() > 512) groupLookups.clear();
            groupLookups.put(subId, groupId);
            return subId;
        }

        /**
         * Fire a one-shot kind-10050 REQ for {@code pubkey}'s published NIP-17
         * inbox — where a DM reply's peer copy must be delivered. The matching
         * EVENT is gathered in {@link #onRelayMessage}; the reply's own timeout
         * resolves with the newest list seen across relays.
         */
        void fetchDmInbox(String pubkey) {
            if (closed || ws == null) return;
            try {
                JSONObject f = new JSONObject();
                f.put("kinds", new JSONArray().put(10050));
                f.put("authors", new JSONArray().put(pubkey));
                f.put("limit", 1);
                ws.send(reqMessage(inboxSubId(pubkey), f));
            } catch (JSONException e) {
                if (BuildConfig.DEBUG) Log.w(TAG, "Failed to build inbox REQ", e);
            }
        }

        /** DM-inbox analogue of {@link #profileSubId}. */
        String inboxSubId(String pubkey) {
            String subId = inboxPrefix + shortKey(pubkey);
            if (inboxLookups.size() > 512) inboxLookups.clear();
            inboxLookups.put(subId, pubkey);
            return subId;
        }

        void closeSub(String subId) {
            if (ws == null) return;
            try {
                JSONArray close = new JSONArray();
                close.put("CLOSE");
                close.put(subId);
                ws.send(close.toString());
            } catch (Exception ignored) {}
        }

        void scheduleReconnect() {
            if (closed) return;
            ws = null;
            // Only a connection that stayed up for a while earns a backoff
            // reset; instant drops keep doubling toward the 5-minute cap.
            if (connectAttemptAt > 0
                    && System.currentTimeMillis() - connectAttemptAt >= STABLE_CONNECTION_MS) {
                backoffMs = INITIAL_BACKOFF_MS;
            }
            long delay = backoffMs;
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            handler.removeCallbacks(reconnectRunnable);
            handler.postDelayed(reconnectRunnable, delay);
        }

        /**
         * Re-send this connection's standing REQs after a relay-initiated
         * CLOSED (#49), with an exponential per-connection delay (1s → 5min)
         * so a relay that keeps dropping the sub can never be hammered in a
         * tight loop. Never used for `auth-required` CLOSEDs — those re-send
         * through the AUTH → OK path instead.
         */
        void scheduleResubscribe() {
            if (closed || ws == null) return;
            handler.removeCallbacks(resubscribeRunnable);
            handler.postDelayed(resubscribeRunnable, subRetryBackoffMs);
            subRetryBackoffMs = Math.min(subRetryBackoffMs * 2, MAX_BACKOFF_MS);
        }

        void close() {
            closed = true;
            handler.removeCallbacks(reconnectRunnable);
            handler.removeCallbacks(resubscribeRunnable);
            // Fail any in-flight/queued reply publish rather than strand its
            // waiter until the timeout (the tally treats it as this relay's no).
            for (PendingPublish p : pendingPublishes.values()) p.cb.done(false);
            pendingPublishes.clear();
            for (PendingPublish p : outbox) p.cb.done(false);
            outbox.clear();
            if (ws != null) {
                try { ws.close(1000, "service reconfigured"); } catch (Exception ignored) {}
                ws = null;
            }
        }

        void resetAndConnectNow() {
            backoffMs = INITIAL_BACKOFF_MS;
            handler.removeCallbacks(reconnectRunnable);
            if (ws == null) connect();
        }
    }

    /** Callback for a native EVENT publish (per relay, and for the overall tally). */
    private interface PublishCallback {
        void done(boolean ok);
    }

    /** One EVENT frame awaiting a relay's OK (or queued for the next open). */
    private static final class PendingPublish {
        final String eventId;
        final String frame;
        final PublishCallback cb;
        // One delayed re-send is allowed after an `auth-required:` OK — the
        // service AUTHs on challenge, so the retry usually lands authenticated.
        boolean authRetried;

        PendingPublish(String eventId, String frame, PublishCallback cb) {
            this.eventId = eventId;
            this.frame = frame;
            this.cb = cb;
        }
    }

    /** `["REQ", <sub>, <filter>, …]` — NIP-01 allows several filters per REQ. */
    private String reqMessage(String subId, JSONObject... filters) throws JSONException {
        JSONArray req = new JSONArray();
        req.put("REQ");
        req.put(subId);
        for (JSONObject filter : filters) req.put(filter);
        return req.toString();
    }

    /**
     * Truncate a hex pubkey / group id for embedding in a subscription id.
     * 24 hex chars keep concurrent lookups distinct for all practical
     * purposes while the whole sub id stays well under the 64-char cap many
     * relays enforce (#50); the full value is recovered via the per-connection
     * lookup maps, never parsed back out of the sub id.
     */
    private static String shortKey(String value) {
        return value.length() <= 24 ? value : value.substring(0, 24);
    }

    private void onRelayMessage(String text, String relayUrl) {
        try {
            JSONArray msg = new JSONArray(text);
            String type = msg.optString(0);
            if ("AUTH".equals(type)) {
                // NIP-42 challenge. The bridge is still emitted when the
                // WebView is up (it signs the Concord STREAM auths, whose
                // derived keys live JS-side), but the user's own kind-22242 is
                // signed natively whenever a shared signer credential exists —
                // so auth-gated subscriptions (the classic #p DM inbox wall)
                // survive with the app killed. A duplicate user AUTH from the
                // bridge is harmless; a relay just re-authenticates.
                String challenge = msg.optString(1);
                if (BuildConfig.DEBUG) Log.d(TAG, "AUTH challenge from " + relayUrl);
                boolean bridged = ArmadaNotificationPlugin.emitAuthChallenge(relayUrl, challenge);
                NativeSigner signer = nativeSigner;
                if (signer != null) {
                    JSONArray authTags = new JSONArray()
                            .put(new JSONArray().put("relay").put(relayUrl))
                            .put(new JSONArray().put("challenge").put(challenge));
                    signer.signEvent(22242, "", authTags, System.currentTimeMillis() / 1000, ev -> {
                        if (ev != null) deliverAuth(relayUrl, ev.toString());
                    });
                } else if (!bridged) {
                    Log.w(TAG, "No bridge (WebView down) and no shared signer — can't AUTH " + relayUrl);
                }
                // The Concord STREAM auths, signed natively from the same
                // group-key memo the quick reply signs wraps with — so an
                // auth-gating relay's kind-1059 subscription survives a
                // reconnect with the WebView asleep, instead of waiting for it
                // to wake and answer the bridge (which still signs too; a
                // duplicate AUTH just re-authenticates).
                Set<String> streamPks = relayToPks2.get(relayUrl);
                if (streamPks != null && !streamPks.isEmpty()) {
                    Map<String, String> secrets =
                            ServiceStore.streamSecrets(this, new ArrayList<>(streamPks));
                    long nowSecs = System.currentTimeMillis() / 1000;
                    for (Map.Entry<String, String> entry : secrets.entrySet()) {
                        byte[] sk = ConcordCrypto.hexToBytes(entry.getValue());
                        if (sk == null || sk.length != 32) continue;
                        try {
                            if (!entry.getKey().equals(NostrCrypto.pubkeyOf(sk))) continue;
                            JSONArray streamTags = new JSONArray()
                                    .put(new JSONArray().put("relay").put(relayUrl))
                                    .put(new JSONArray().put("challenge").put(challenge));
                            deliverAuth(relayUrl, NostrCrypto.finalizeEvent(
                                    22242, "", streamTags, nowSecs, sk).toString());
                        } catch (Exception ignored) {
                            // A stream that can't sign simply isn't authed.
                        }
                    }
                }
                return;
            }
            if ("EOSE".equals(type)) {
                String sub = msg.optString(1);
                if (BuildConfig.DEBUG) Log.d(TAG, "EOSE from " + relayUrl + " sub=" + sub);
                // A profile lookup that returned no kind-0: resolve waiters with
                // null so the notification fires name-less rather than hanging —
                // and negative-cache it so this author isn't re-broadcast on
                // every subsequent message.
                String pk = profilePubkeyForSub(sub);
                if (pk != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveProfileMiss(pk);
                    return;
                }
                // A group-name lookup with no kind-39000: resolve waiters null.
                String gid = groupIdForSub(sub);
                if (gid != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveGroupName(gid, null);
                    return;
                }
                // A DM-inbox lookup with no kind-10050 here: just close it —
                // the reply's own timeout resolves with the best across relays.
                if (inboxPubkeyForSub(sub) != null) {
                    closeInboxSub(relayUrl, sub);
                }
                return;
            }
            if ("CLOSED".equals(type)) {
                String sub = msg.optString(1);
                String reason = msg.optString(2);
                Log.w(TAG, "CLOSED from " + relayUrl + " sub=" + sub + " reason=" + reason);
                // A one-shot profile/group lookup the relay rejected (bad sub
                // id, auth wall, filter policy): resolve its waiters like an
                // empty EOSE so the notification fires name-less instead of
                // hanging on the timeout.
                String pk = profilePubkeyForSub(sub);
                if (pk != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveProfile(pk, bestProfile.get(pk));
                    return;
                }
                String gid = groupIdForSub(sub);
                if (gid != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveGroupName(gid, (String) null);
                    return;
                }
                if (inboxPubkeyForSub(sub) != null) {
                    closeInboxSub(relayUrl, sub);
                    return;
                }
                // A standing subscription the relay dropped. `auth-required`
                // is NOT retried from here — the AUTH → OK path re-sends every
                // REQ once authentication lands, and without an auth path a
                // blind re-REQ is an unwinnable retry storm (#49). Everything
                // else (relay restart, transient error, rate limit) earns a
                // DELAYED resubscribe with per-connection exponential backoff.
                if (reason.startsWith("auth-required:")) return;
                for (RelayConnection rc : connections) {
                    if (rc.relayUrl.equals(relayUrl)) {
                        rc.scheduleResubscribe();
                        break;
                    }
                }
                return;
            }
            if ("OK".equals(type)) {
                // AUTH ack (["OK", <event-id>, true/false, msg]). On success,
                // and only when the id matches a kind-22242 we sent (the user's
                // or a Concord stream key's), the matching connection
                // re-sends its REQs — coalesced into one round after the OK
                // burst settles (see scheduleAuthResend).
                String okId = msg.optString(1);
                boolean ok = msg.optBoolean(2, false);
                if (BuildConfig.DEBUG) Log.d(TAG, "OK from " + relayUrl + " ok=" + ok + " " + msg.optString(3));
                for (RelayConnection rc : connections) {
                    if (!rc.relayUrl.equals(relayUrl) || rc.ws == null) continue;
                    if (ok && rc.pendingAuthIds.remove(okId)) {
                        rc.scheduleAuthResend();
                        continue;
                    }
                    // A reply publish's OK. `auth-required` earns ONE delayed
                    // re-send (the AUTH this service signs on challenge usually
                    // completes in the gap); anything else resolves the waiter.
                    PendingPublish p = rc.pendingPublishes.get(okId);
                    if (p == null) continue;
                    if (!ok && msg.optString(3, "").startsWith("auth-required:") && !p.authRetried) {
                        p.authRetried = true;
                        handler.postDelayed(() -> {
                            if (rc.ws != null && rc.pendingPublishes.containsKey(okId)) {
                                rc.ws.send(p.frame);
                            }
                        }, 3_000);
                        continue;
                    }
                    rc.pendingPublishes.remove(okId);
                    p.cb.done(ok);
                }
                return;
            }
            if (!"EVENT".equals(type)) return;
            String sub = msg.optString(1);
            JSONObject event = msg.optJSONObject(2);
            if (event == null) return;
            // A kind-0 from a profile lookup: keep the newest across relays and
            // resolve waiters with the best we have.
            String pk = profilePubkeyForSub(sub);
            if (pk != null) {
                closeProfileSub(relayUrl, sub);
                // The relay could answer our one-shot kind-0 lookup with a
                // forged or unrelated profile (poisoning a sender's name/avatar
                // and the shared store). Require the reply to actually match the
                // filter — kind 0 authored by the pubkey we asked for — and to
                // carry a valid signature; otherwise resolve name-less.
                if (event.optInt("kind", -1) != 0
                        || !pk.equals(event.optString("pubkey"))
                        || !NostrCrypto.verifyEvent(event)) {
                    resolveProfile(pk, bestProfile.get(pk));
                    return;
                }
                // Store the raw kind-0 in ArmadaDB's `main` tenant (supersession
                // keeps the newest), so the WebView's useAuthor reads it from
                // the cache instead of re-fetching what we just fetched. Not
                // queued for ingest: there is nothing to route, only to cache.
                ServiceStore.cache(this, event);
                Profile parsed = parseProfile(event);
                Profile prev = bestProfile.get(pk);
                if (prev == null || parsed.ts >= prev.ts) {
                    bestProfile.put(pk, parsed);
                }
                resolveProfile(pk, bestProfile.get(pk));
                return;
            }
            // A kind-39000 from a group-name lookup: cache the name + resolve.
            String gid = groupIdForSub(sub);
            if (gid != null) {
                closeProfileSub(relayUrl, sub);
                // Same untrusted-relay gate as profiles: the reply must be the
                // kind-39000 metadata for the group id we asked for, with a
                // valid signature, or we resolve name-less rather than trust a
                // forged room title.
                if (event.optInt("kind", -1) != 39000
                        || !gid.equals(tagValue(event, "d"))
                        || !NostrCrypto.verifyEvent(event)) {
                    resolveGroupName(gid, (String) null);
                    return;
                }
                // Cache the group's picture (kind-39000 `picture` tag) alongside
                // its name — the NIP-29 conversation's avatar. Plain public
                // URL, no decrypt.
                String pic = tagValue(event, "picture");
                if (pic != null && !pic.isEmpty()) {
                    groupPictureCache.put(gid, pic);
                }
                // Cached so the WebView reads the group's metadata rather than
                // refetching what we just fetched — in THIS relay's tenant,
                // which is where the channel list looks for it (a group id names
                // nothing without its relay, and relay identities can be shared
                // between servers, so metadata is stored per relay).
                ServiceStore.cache(this, event, relayUrl);
                resolveGroupName(gid, parseGroupName(event));
                return;
            }
            // A kind-10050 from a DM-inbox lookup: keep the newest VERIFIED
            // list seen across relays; the reply's timeout reads it out. The
            // same untrusted-relay gate as profiles — a forged inbox would
            // redirect the reply's ciphertext to relays the peer never reads.
            String inboxPk = inboxPubkeyForSub(sub);
            if (inboxPk != null) {
                closeInboxSub(relayUrl, sub);
                if (event.optInt("kind", -1) == 10050
                        && inboxPk.equals(event.optString("pubkey"))
                        && NostrCrypto.verifyEvent(event)) {
                    JSONObject prev = bestInbox.get(inboxPk);
                    if (prev == null
                            || event.optLong("created_at", 0) >= prev.optLong("created_at", 0)) {
                        bestInbox.put(inboxPk, event);
                    }
                }
                return;
            }
            handleEvent(event, relayUrl);
        } catch (Exception e) {
            // Ignore non-JSON / unexpected frames.
        }
    }

    // ── Profile (kind 0) resolution ───────────────────────────────────────────

    /**
     * If {@code sub} is one of our one-shot profile lookups, return the pubkey
     * it was issued for; otherwise null. Recovered from each connection's
     * lookup map (the sub id itself only carries a truncated key, #50).
     */
    private String profilePubkeyForSub(String sub) {
        if (sub == null || sub.isEmpty()) return null;
        for (RelayConnection rc : connections) {
            String pk = rc.profileLookups.get(sub);
            if (pk != null) return pk;
        }
        return null;
    }

    private void closeProfileSub(String relayUrl, String sub) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl)) {
                rc.profileLookups.remove(sub);
                rc.groupLookups.remove(sub);
                rc.closeSub(sub);
                return;
            }
        }
    }

    /**
     * Resolve {@code pubkey} to a profile, then invoke {@code cb} (always on the
     * main handler). Serves from the DURABLE store when present (refreshing in
     * the background once stale), and serves a recent NEGATIVE entry without
     * touching the network. On a genuine miss, issues a kind-0 REQ on EVERY
     * open relay (a user's kind-0 usually lives on their general / outbox
     * relays, not the NIP-29 group relay the message came from, so a
     * single-relay lookup misses it — that was why many senders showed no name
     * or avatar). Waits up to {@link #PROFILE_TIMEOUT_MS}, keeping the newest
     * kind-0 seen across relays.
     */
    private void resolveAuthor(String pubkey, String relayUrl, ProfileCallback cb) {
        long now = System.currentTimeMillis();
        ProfileStore.Entry held = profileStore.get(pubkey);
        if (held != null) {
            cb.onProfile(new Profile(held.name, held.picture, held.nip05, held.ts));
            // Stale-while-revalidate: refresh in the background so names stay
            // current without delaying this notification — but only when no
            // fetch is in flight, since piggybacking would hold the
            // notification behind the in-flight timeout for no benefit.
            if (profileStore.isStale(pubkey, now, PROFILE_STALE_MS)
                    && !pendingProfiles.containsKey(pubkey)) {
                startProfileFetch(pubkey, profile -> { /* silent refresh */ });
            }
            return;
        }
        // The shared database next: the WebView may already hold this author's
        // kind-0 (its own fetches land in the same store — literally the same
        // store now, not a mirror of it). Checked BEFORE the negative cache so a
        // profile the webview fetched after our miss still resolves. A hit seeds
        // the profile store, so subsequent lookups (and stale-while-revalidate
        // bookkeeping) work as usual.
        try {
            String raw = ServiceStore.profileRaw(this, pubkey);
            if (raw != null) {
                Profile fromDb = parseProfile(new JSONObject(raw));
                profileStore.put(pubkey, fromDb.name, fromDb.picture, fromDb.nip05,
                        fromDb.ts, now);
                markProfilesDirty();
                cb.onProfile(fromDb);
                return;
            }
        } catch (Exception e) {
            // Unreadable row — fall through to the network path.
        }
        if (profileStore.isFreshMiss(pubkey, now, PROFILE_MISS_TTL_MS)) {
            // A recent fetch found no kind-0 for this author — fire name-less
            // instead of re-broadcasting to every relay on every message.
            cb.onProfile(null);
            return;
        }
        startProfileFetch(pubkey, cb);
    }

    /**
     * Broadcast a one-shot kind-0 fetch for {@code pubkey} to every open relay
     * (originating relay first), coalescing concurrent callers onto one in-
     * flight fetch, with a {@link #PROFILE_TIMEOUT_MS} fallback resolution.
     */
    private void startProfileFetch(String pubkey, ProfileCallback cb) {
        List<ProfileCallback> waiters = pendingProfiles.get(pubkey);
        if (waiters != null) {
            waiters.add(cb); // a fetch is already in flight; piggyback on it
            return;
        }
        waiters = new ArrayList<>();
        waiters.add(cb);
        pendingProfiles.put(pubkey, waiters);

        // Broadcast to every connected relay (originating relay first), not just
        // the one the message arrived on.
        boolean sentAny = false;
        for (RelayConnection rc : connections) {
            if (rc.ws != null && !rc.closed) {
                rc.fetchProfile(pubkey);
                sentAny = true;
            }
        }
        if (!sentAny) {
            // Nothing was actually asked (no connections) — NOT a genuine
            // miss, so don't negative-cache it; just fire name-less.
            resolveProfile(pubkey, null);
            return;
        }
        // Fallback if no relay answers in time (no kind-0 / slow): resolve with
        // the best profile gathered so far. A genuine nothing-found is
        // negative-cached so this author's next message doesn't re-broadcast.
        handler.postDelayed(() -> {
            if (pendingProfiles.containsKey(pubkey)) {
                Profile best = bestProfile.get(pubkey);
                if (best == null) resolveProfileMiss(pubkey);
                else resolveProfile(pubkey, best);
            }
        }, PROFILE_TIMEOUT_MS);
    }

    /** Cache the result (if any) and flush all pending waiters for this pubkey. */
    private void resolveProfile(String pubkey, Profile profile) {
        if (profile != null) {
            profileStore.put(pubkey, profile.name, profile.picture, profile.nip05,
                    profile.ts, System.currentTimeMillis());
            markProfilesDirty();
        }
        bestProfile.remove(pubkey);
        // Close any profile subs still open for this pubkey on the other relays
        // we broadcast to, so they don't linger.
        for (RelayConnection rc : connections) {
            String subId = rc.profilePrefix + shortKey(pubkey);
            rc.profileLookups.remove(subId);
            rc.closeSub(subId);
        }
        List<ProfileCallback> waiters = pendingProfiles.remove(pubkey);
        if (waiters == null) return;
        for (ProfileCallback cb : waiters) {
            cb.onProfile(profile);
        }
    }

    /**
     * A fetch that genuinely found no kind-0 (an empty EOSE, or the timeout
     * with nothing gathered): negative-cache it so this author's messages
     * don't re-broadcast to every relay for {@link #PROFILE_MISS_TTL_MS}.
     */
    private void resolveProfileMiss(String pubkey) {
        profileStore.putMiss(pubkey, System.currentTimeMillis());
        markProfilesDirty();
        resolveProfile(pubkey, null);
    }

    /** Schedule a debounced persist of the profile store (bursts write once). */
    private void markProfilesDirty() {
        if (profilePersistScheduled) return;
        profilePersistScheduled = true;
        handler.postDelayed(() -> {
            profilePersistScheduled = false;
            persistProfiles();
        }, PROFILE_PERSIST_DEBOUNCE_MS);
    }

    private void persistProfiles() {
        profileStore.evictOldest(PROFILE_STORE_MAX);
        getSharedPreferences(PROFILES_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(PROFILES_KEY, profileStore.serialize())
                .apply();
    }

    /**
     * If {@code sub} is one of our one-shot DM-inbox lookups, return the
     * pubkey it was issued for; otherwise null.
     */
    private String inboxPubkeyForSub(String sub) {
        if (sub == null || sub.isEmpty()) return null;
        for (RelayConnection rc : connections) {
            String pk = rc.inboxLookups.get(sub);
            if (pk != null) return pk;
        }
        return null;
    }

    private void closeInboxSub(String relayUrl, String sub) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl)) {
                rc.inboxLookups.remove(sub);
                rc.closeSub(sub);
                return;
            }
        }
    }

    private interface InboxCallback {
        void onRelays(List<String> relays);
    }

    /**
     * Resolve {@code pubkey}'s published NIP-17 inbox relays (kind-10050
     * `relay` tags): the shared store first (the WebView caches peers' lists
     * there), else a one-shot broadcast REQ to every open relay, gathering the
     * newest list for {@link #DM_INBOX_TIMEOUT_MS}. Resolves with an EMPTY
     * list when the peer has published none — DM sends are gated on a
     * published inbox (matching the WebView), so an empty resolve fails the
     * reply rather than publishing ciphertext somewhere the peer never reads.
     */
    private void resolveDmInbox(String pubkey, InboxCallback cb) {
        List<String> cached = ServiceStore.dmInboxRelays(this, pubkey);
        if (cached != null && !cached.isEmpty()) {
            cb.onRelays(cached);
            return;
        }
        boolean sentAny = false;
        for (RelayConnection rc : connections) {
            if (rc.ws != null && !rc.closed) {
                rc.fetchDmInbox(pubkey);
                sentAny = true;
            }
        }
        if (!sentAny) {
            cb.onRelays(new ArrayList<>());
            return;
        }
        handler.postDelayed(() -> {
            JSONObject best = bestInbox.remove(pubkey);
            List<String> relays = new ArrayList<>();
            if (best != null) {
                // Cache the list (main tenant, replaceable) so the next reply
                // to this peer skips the wait.
                ServiceStore.cache(this, best);
                JSONArray tags = best.optJSONArray("tags");
                if (tags != null) {
                    for (int i = 0; i < tags.length(); i++) {
                        JSONArray tag = tags.optJSONArray(i);
                        if (tag != null && "relay".equals(tag.optString(0)) && tag.length() > 1) {
                            String u = tag.optString(1);
                            if (!u.isEmpty() && !relays.contains(u)) relays.add(u);
                        }
                    }
                }
            }
            cb.onRelays(relays);
        }, DM_INBOX_TIMEOUT_MS);
    }

    private RelayConnection connectionFor(String relayUrl) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl) && rc.ws != null) return rc;
        }
        return null;
    }

    /** Parse a kind-0 event's content into a {@link Profile}. */
    private static Profile parseProfile(JSONObject event) {
        long ts = event.optLong("created_at", 0);
        try {
            JSONObject meta = new JSONObject(event.optString("content", "{}"));
            String name = meta.optString("display_name", null);
            if (name == null || name.isEmpty()) {
                name = meta.optString("name", null);
            }
            if (name != null && name.isEmpty()) name = null;
            String picture = meta.optString("picture", null);
            if (picture != null && picture.isEmpty()) picture = null;
            String nip05 = meta.optString("nip05", null);
            if (nip05 != null && nip05.isEmpty()) nip05 = null;
            return new Profile(name, picture, nip05, ts);
        } catch (JSONException e) {
            return new Profile(null, null, null, ts);
        }
    }

    // ── Group name (kind 39000) resolution ────────────────────────────────────

    /**
     * If {@code sub} is one of our one-shot group-name lookups, return the group
     * id it was issued for; otherwise null. Recovered from each connection's
     * lookup map (the sub id itself only carries a truncated id, #50).
     */
    private String groupIdForSub(String sub) {
        if (sub == null || sub.isEmpty()) return null;
        for (RelayConnection rc : connections) {
            String gid = rc.groupLookups.get(sub);
            if (gid != null) return gid;
        }
        return null;
    }

    /** Parse a kind-39000 group-metadata event's name (the `name` tag). */
    private static String parseGroupName(JSONObject event) {
        return tagValue(event, "name");
    }

    /**
     * Resolve {@code groupId} to a display name, then invoke {@code cb} (always
     * on the main handler). Serves from cache, else issues a kind-39000 REQ on
     * {@code relayUrl} and waits up to {@link #PROFILE_TIMEOUT_MS}.
     */
    private void resolveGroupName(String groupId, String relayUrl, GroupNameCallback cb) {
        String cached = groupNameCache.get(groupId);
        if (cached != null) {
            cb.onName(cached);
            return;
        }
        List<GroupNameCallback> waiters = pendingGroupNames.get(groupId);
        if (waiters != null) {
            waiters.add(cb);
            return;
        }
        waiters = new ArrayList<>();
        waiters.add(cb);
        pendingGroupNames.put(groupId, waiters);

        RelayConnection rc = connectionFor(relayUrl);
        if (rc == null) {
            resolveGroupName(groupId, (String) null);
            return;
        }
        rc.fetchGroupName(groupId);
        handler.postDelayed(() -> {
            if (pendingGroupNames.containsKey(groupId)) {
                resolveGroupName(groupId, (String) null);
            }
        }, PROFILE_TIMEOUT_MS);
    }

    /** Cache the name (if any) and flush all pending waiters for this group. */
    private void resolveGroupName(String groupId, String name) {
        if (name != null && !name.isEmpty()) {
            groupNameCache.put(groupId, name);
        }
        List<GroupNameCallback> waiters = pendingGroupNames.remove(groupId);
        if (waiters == null) return;
        for (GroupNameCallback cb : waiters) {
            cb.onName(name);
        }
    }

    // ── Event → notification ──────────────────────────────────────────────────

    /**
     * Open a Concord stream wrap with the supplied conversation key:
     * NIP-44-decrypt the wrap's {@code content} → the seal (kind 20013
     * encrypted / 20014 plaintext), recover the rumor (decrypting again for
     * 20013), and return it ({@code pubkey} = real author, {@code content} =
     * message). Best-effort: returns {@code null} on decrypt/parse failure or
     * if the seal signature is bad or the rumor's author/channel/epoch binding
     * doesn't match (a spliced/foreign payload).
     */
    private static ConcordOpen openConcord(JSONObject wrap, ConcordStream st) {
        try {
            String payload = wrap.optString("content", "");
            if (payload.isEmpty()) return null;
            String sealJson = ConcordCrypto.decrypt(st.convKey, payload);
            if (sealJson == null) return null;
            JSONObject seal = new JSONObject(sealJson);
            int sealKind = seal.optInt("kind", -1);
            if (sealKind != 20013 && sealKind != 20014) return null;
            // The seal is a signed event authored by the sender (the rumor
            // inside is unsigned and bound to it by pubkey equality below);
            // verify the seal's Schnorr signature, mirroring the WebView's
            // openWrap. The kind-1059 wrap's outer signature is a group-derived
            // stream key and proves no individual identity.
            if (!NostrCrypto.verifyEvent(seal)) return null;
            String rumorJson;
            if (sealKind == 20013) {
                rumorJson = ConcordCrypto.decrypt(st.convKey, seal.optString("content", ""));
            } else if (sealKind == 20014) {
                rumorJson = seal.optString("content", null);
            } else {
                return null;
            }
            if (rumorJson == null) return null;
            JSONObject rumor = new JSONObject(rumorJson);
            // The rumor's author must equal the seal's signer (or a keyholder
            // could re-seal another member's rumor under their own name), and
            // the channel/epoch binding must match the stream that decrypted
            // the wrap (a spliced/foreign payload).
            String author = rumor.optString("pubkey");
            if (author.isEmpty() || !author.equals(seal.optString("pubkey"))) return null;
            // Absent binding fails CLOSED, matching the WebView's
            // checkChannelBinding: every chat rumor it will accept carries both
            // tags, so requiring them here can only drop what it drops too —
            // and keeps the notification from naming a channel the payload
            // never committed to.
            String ch = tagValue(rumor, "channel");
            String ep = tagValue(rumor, "epoch");
            if (ch == null || !st.channelId.equals(ch)) return null;
            if (ep == null || (!st.epoch.isEmpty() && !st.epoch.equals(ep))) return null;
            return new ConcordOpen(rumor, sealKind);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * A recovered Concord rumor and the kind of the seal it arrived in. The
     * seal kind is provenance the opened-event store records alongside the
     * rumor (the fold and the dissolution check branch on it per row), so it has
     * to survive the open.
     */
    private static final class ConcordOpen {
        final JSONObject rumor;
        final int sealKind;
        ConcordOpen(JSONObject rumor, int sealKind) {
            this.rumor = rumor;
            this.sealKind = sealKind;
        }
    }

    /**
     * Notify for a NIP-17 gift wrap (kind 1059) addressed to the user. With a
     * shared signer credential (NativeSigner: nsec key, Amber grant, or NIP-46
     * session) the wrap is opened wrap → seal → rumor exactly like the
     * WebView's openDmWrap, for a full "<sender>: <preview>" notification;
     * non-DM rumor kinds (Concord invites, reactions, deletes) and our own
     * sent copies stay silent. Only when the signer is absent or UNREACHABLE
     * (Amber grant missing, bunker offline) does it degrade to a generic
     * "New direct message".
     *
     * Dedupe is {@code storedBefore} (the shared event DB): a wrap either
     * side EVER stored — a previous service incarnation, the WebView's inbox
     * sync, or our own just-published self-copy — never re-notifies. That
     * floor survives service restarts, unlike notifiedIds, and covers relays
     * that ignore the filter's {@code limit: 0} and replay the rewound
     * `since` window on reconnect.
     */
    private void handleDm17Wrap(JSONObject wrap, String id, String relayUrl, boolean storedBefore) {
        // Only wraps addressed to me are DMs — the Concord authors-scoped
        // subscription also delivers kind 1059, with no `p` tag at us.
        if (!isMentioned(wrap, userPubkey)) return;
        notifiedIds.add(id);
        if (storedBefore) return;
        // NIP-40: a disappearing message whose deadline has already passed is
        // not delivered at all — neither notified nor stored. Mirrors
        // openDmWrap, which refuses an expired envelope before it decrypts
        // anything.
        if (ServiceStore.isExpired(wrap)) return;

        NativeSigner signer = nativeSigner;
        if (signer == null) {
            if (prefBool("directMessages", true)) notifyOpaqueDm17();
            return;
        }
        // Open the wrap with the user's signer (async — Amber/bunker are RPC).
        // Mirrors openDmWrap's checks: seal kind 13, rumor author == seal
        // signer (NIP-59 anti-spoof; the NIP-44 AEAD already authenticated the
        // seal against us).
        signer.decrypt44(wrap.optString("pubkey"), wrap.optString("content"), (sealJson, unavailable) -> {
            if (sealJson == null) {
                // Crypto says no → not a readable DM (foreign protocol,
                // garbage): silent. Signer unreachable → still tell the user
                // SOMETHING arrived.
                if (unavailable && prefBool("directMessages", true)) notifyOpaqueDm17();
                return;
            }
            try {
                JSONObject seal = new JSONObject(sealJson);
                if (seal.optInt("kind", -1) != 13) return;
                // The seal is signed by the sender's identity key (NIP-17);
                // verify it so a relay-supplied forgery can't misattribute a DM.
                if (!NostrCrypto.verifyEvent(seal)) return;
                // The seal carries the rumor's deadline too, so a reader learns
                // it without having to trust the relay-visible wrap.
                if (ServiceStore.isExpired(seal)) return;
                final String peer = seal.optString("pubkey", "");
                if (peer.length() != 64) return;
                if (peer.equals(userPubkey)) return; // our own sent copy
                signer.decrypt44(peer, seal.optString("content", ""), (rumorJson, unavailable2) -> {
                    if (rumorJson == null) {
                        if (unavailable2 && prefBool("directMessages", true)) notifyOpaqueDm17();
                        return;
                    }
                    try {
                        JSONObject rumor = new JSONObject(rumorJson);
                        if (!peer.equals(rumor.optString("pubkey"))) return;
                        // Recompute the id before anything is filed under it:
                        // it is what the store keys the rumor by and what a
                        // NIP-09 delete matches, so a sender-chosen one is
                        // never taken on trust.
                        if (!stampRumorId(rumor)) return;
                        // Store EVERY DM-plane kind, not just the ones that
                        // notify: reactions, deletes and timer changes are part
                        // of the conversation the app reads back. The store
                        // applies the rest of the rules (kind, expiry, peer).
                        ServiceStore.storeDm17Rumor(this, userPubkey, rumor);
                        // Everything above is the STORE's business and happens
                        // whatever the notification prefs say — the wrap was
                        // subscribed for, received and opened, and dropping the
                        // plaintext would only make the app decrypt it again.
                        // The pref decides one thing: whether to interrupt.
                        if (!prefBool("directMessages", true)) return;
                        // Chat/file messages only — reactions (7), deletes (5)
                        // and foreign rumor kinds (Concord invites) stay
                        // silent, matching the WebView's DM rumor kinds.
                        final int rumorKind = rumor.optInt("kind", -1);
                        if (rumorKind != 14 && rumorKind != 15) return;
                        // Unknown sender — not followed, accepted, or pinned. A
                        // NIP-17 wrap can come from anyone, and a stranger picks
                        // the message text, the display name AND the avatar that a
                        // full DM notification would put on the lock screen.
                        // `dmRequests` decides how much of that reaches it; the
                        // rumor is already stored, so a request is still there
                        // in-app (the DM requests tier) on open regardless.
                        if (!dmKnownPeers.contains(peer)) {
                            if ("off".equals(dmRequests)) return;
                            if (!"full".equals(dmRequests)) { // "generic" / unset
                                long reqTs = rumor.optLong("created_at", 0);
                                notifyDmRequest(reqTs > 0 ? reqTs * 1000L
                                        : System.currentTimeMillis());
                                return;
                            }
                            // "full" falls through and notifies like a friend.
                        }
                        final String preview =
                                rumorKind == 15 ? "Sent a file" : messagePreview(rumor);
                        final long rts = rumor.optLong("created_at", 0);
                        final long fTs = (rts > 0 ? rts * 1000L : System.currentTimeMillis());
                        resolveAuthor(peer, relayUrl, profile -> {
                            String name = displayName(profile);
                            String picture = profile != null ? profile.picture : null;
                            String line = preview.isEmpty() ? "Sent you a direct message" : preview;
                            if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY dm17 (signer) from=" + name);
                            // mention=false: a DM is suppressed while its own
                            // thread is on screen (the peer isn't known until
                            // decrypt, so enqueueRoomMessage's active-room gate
                            // does it here rather than a synchronous pre-check).
                            enqueueRoomMessage(/*community=*/null, "dm:" + peer, name,
                                    appendMessageSegment("/dm/" + peer, rumor.optString("id", "")),
                                    peer, name, picture, line, fTs, /*mention=*/false);
                        });
                    } catch (Exception ignored) {
                        // Malformed rumor JSON — silent.
                    }
                });
            } catch (Exception ignored) {
                // Malformed seal JSON — silent.
            }
        });
    }

    /** Reject rumors claiming to be from further in the future than this. */
    private static final long MAX_FUTURE_SKEW_SECS = 3600;

    /**
     * Verify a decrypted rumor's NIP-01 id — filling it in when the payload
     * omitted one — and reject a rumor dated too far ahead. Mirrors the checks
     * openDmWrap makes before it hands a rumor to the store.
     *
     * The id matters more here than it looks: it is the key the store holds the
     * rumor under and the thing a NIP-09 delete names, so a sender who could
     * choose it could make their message collide with — or delete — something
     * else in the conversation.
     */
    private static boolean stampRumorId(JSONObject rumor) {
        String pubkey = rumor.optString("pubkey", "");
        JSONArray tags = rumor.optJSONArray("tags");
        if (pubkey.isEmpty() || tags == null) return false;
        if (!(rumor.opt("kind") instanceof Number)) return false;
        if (!(rumor.opt("created_at") instanceof Number)) return false;
        if (!(rumor.opt("content") instanceof String)) return false;

        int kind = rumor.optInt("kind", -1);
        long createdAt = rumor.optLong("created_at", -1);
        if (kind < 0 || createdAt < 0) return false;
        if (createdAt > System.currentTimeMillis() / 1000 + MAX_FUTURE_SKEW_SECS) return false;

        String computed = NostrCrypto.eventId(pubkey, createdAt, kind, tags, rumor.optString("content"));
        String claimed = rumor.optString("id", "");
        if (!claimed.isEmpty() && !claimed.equals(computed)) return false;

        try {
            rumor.put("id", computed);
        } catch (JSONException e) {
            return false;
        }
        return true;
    }

    /**
     * The unattributed fallback: an inbox wrap we could not open (no signer, or
     * the signer was unreachable). Better a generic ping than silence — the
     * WebView attributes it on open.
     */
    private void notifyOpaqueDm17() {
        // Viewing ANY DM thread suppresses: the live feed already paints the
        // message there (or it's our own just-sent copy echoing back), and
        // the wrap hides which peer it belongs to, so per-thread suppression
        // is impossible.
        for (String roomKey : activeRoomKeys) {
            if (roomKey.startsWith("dm:")) return;
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY dm17 (opaque)");
        enqueueRoomMessage(/*community=*/null, "dm17:opaque", "Direct messages", "/dm",
                /*senderPubkey=*/null, "Someone", /*picture=*/null,
                "New direct message", System.currentTimeMillis(), /*mention=*/true);
    }

    /**
     * The content-blind ping for a DM from an unknown sender when `dmRequests`
     * is "generic". Deliberately carries NOTHING the sender controls — no
     * display name, no avatar, no message preview — so a stranger can't push
     * slurs (in the text OR their profile) onto the lock screen. All pending
     * requests collapse into one "Message requests" conversation; the WebView's
     * DM requests tier shows who they actually are on open.
     */
    private void notifyDmRequest(long timestampMs) {
        // Viewing any DM thread suppresses, as for the opaque ping: the request
        // tier is a DM surface, and the peer isn't tied to a single thread here.
        for (String roomKey : activeRoomKeys) {
            if (roomKey.startsWith("dm:")) return;
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY dm17 (request)");
        enqueueRoomMessage(/*community=*/null, "dm:requests", "Message requests", "/dm",
                /*senderPubkey=*/null, "Message requests", /*picture=*/null,
                "You have a new message request", timestampMs, /*mention=*/true);
    }

    /**
     * Per-room cache key for the plugin's rolling event cache (see
     * ArmadaNotificationPlugin.getRoomEvents): NIP-29 events key by their group
     * (`h` tag), Concord wraps by the channel their stream author maps to,
     * DMs share one bucket (the WebView splits threads by counterparty
     * itself). Null when the event carries no usable room scope.
     */
    private String roomKeyFor(JSONObject event, int kind) {
        if (kind == 4) return "dm";
        if (kind == 1059) {
            ConcordStream st = pkToStream2.get(event.optString("pubkey"));
            if (st != null) return "c2:" + st.channelId;
            // A NIP-17 DM wrap — any wrap p-tagged at the user (the WebView
            // holds the identity key and splits threads by counterparty itself,
            // like kind-4). One shared "dm" cache bucket.
            if (isMentioned(event, userPubkey)) return "dm";
            return null;
        }
        String h = tagValue(event, "h");
        return h != null ? "h:" + h : null;
    }

    /** Validate and route public NIP-34/NIP-22 activity without ever leaking
     * private C2 metadata to a relay. Accepted raw events use the same bridge as
     * normal plaintext wire events, where IndexedDB de-dupes by event id. */
    private void handleGitActivity(JSONObject event, String relayUrl, String id, int kind) {
        String address = null, ticketId = null, title = null, action = null;
        GitRoot root = null;
        if (kind == 1618 || kind == 1621) {
            address = tagValue(event, "a");
            GitRepository repository = gitRepositories.get(address);
            if (repository == null || !validTicketRoot(event, repository, kind)) return;
            root = new GitRoot(id, event.optString("pubkey"), kind);
            if (!repository.roots.containsKey(id)) {
                repository.roots.put(id, root);
                // Persisting the root reconnects through the config listener,
                // the same path every other subscription change takes, so the
                // new root's child filters go live without a WebView.
                persistGitRoot(address, root);
            }
            title = tagValue(event, "subject"); action = kind == 1618 ? "opened a pull request" : "opened an issue";
            ticketId = id;
        } else {
            ticketId = kind == 1111 ? rootTag(event, "E") : rootTag(event, "e");
            if (!validHex(ticketId)) return;
            for (GitRepository candidate : gitRepositories.values()) {
                root = candidate.roots.get(ticketId);
                if (root != null) { address = candidate.address; break; }
            }
            if (root == null || address == null) return;
            if (kind == 1111) {
                if (!validNip22Root(event, root)) return;
                action = "commented on a ticket";
            } else {
                GitRepository repository = gitRepositories.get(address);
                String author = event.optString("pubkey", "");
                if (repository == null || !(author.equals(root.author) || author.equals(repository.owner) || repository.maintainers.contains(author))) return;
                action = "changed a ticket status";
            }
        }
        GitRepository repository = gitRepositories.get(address);
        if (repository == null || !repository.live()) return;
        long timestamp = event.optLong("created_at", 0);
        if (timestamp <= 0 || notifiedIds.contains(id)) return;
        notifiedIds.add(id);
        ArmadaNotificationPlugin.feedRelayEvent("git:" + address, event.toString(), relayUrl);
        for (GitAttachment attachment : repository.attachments) {
            if (!attachment.activeAt(timestamp)) continue;
            String url = "/c/" + uriEncode(attachment.communityId) + "/" + uriEncode(attachment.channelId)
                    + "?ticket=" + uriEncode(ticketId);
            String line = action + (title != null && !title.trim().isEmpty() ? ": " + truncate(title) : "");
            // Share the channel's own room, community and title with chat, so
            // git activity appends to that conversation instead of opening a
            // second notification with a conflicting name.
            ConcordStream stream = streamForChannel(attachment.channelId);
            enqueueRoomMessage(
                    stream != null ? stream.community : null, "c2:" + attachment.channelId,
                    stream != null ? stream.name : "Git activity", url,
                    event.optString("pubkey", null), "Git activity", /*picture=*/null,
                    line, timestamp * 1000L, /*mention=*/false);
        }
    }

    /** The subscribed stream for a channel, if any; git activity borrows its
     * community and display name. Streams are per (channel, epoch), so the
     * first match is enough — every epoch carries the same two. */
    private ConcordStream streamForChannel(String channelId) {
        for (ConcordStream stream : pkToStream2.values()) if (stream.channelId.equals(channelId)) return stream;
        return null;
    }

    /** NIP-22 encodes the root in uppercase tags, where — unlike NIP-10's
     * lowercase `e` — the fourth value is the root author's pubkey rather than a
     * "root" marker. Mirrors the TypeScript parser: an uppercase root counts
     * only when it is unambiguous. */
    private static String rootTag(JSONObject event, String name) {
        boolean nip22 = "E".equals(name);
        String found = null;
        try { JSONArray tags = event.optJSONArray("tags"); if (tags == null) return null;
            for (int i = 0; i < tags.length(); i++) { JSONArray tag = tags.optJSONArray(i);
                if (tag == null || !name.equals(tag.optString(0))) continue;
                if (!nip22) { if ("root".equals(tag.optString(3))) return tag.optString(1); continue; }
                if (found != null) return null;
                found = tag.optString(1);
            }
        } catch (Exception ignored) {} return found;
    }
    private static boolean validTicketRoot(JSONObject event, GitRepository repository, int kind) {
        return validHex(event.optString("id", "")) && validHex(event.optString("pubkey", ""))
                && repository.address.equals(tagValue(event, "a")) && (kind == 1618 || kind == 1621);
    }
    private static boolean validNip22Root(JSONObject event, GitRoot root) {
        String kind = tagValue(event, "K");
        return root.id.equals(rootTag(event, "E")) && Integer.toString(root.kind).equals(kind);
    }
    private void persistGitRoot(String address, GitRoot root) {
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        try {
            JSONArray repositories = new JSONArray(sp.getString("gitSubs", "[]"));
            for (int i = 0; i < repositories.length(); i++) { JSONObject repository = repositories.optJSONObject(i);
                if (repository == null || !address.equals(repository.optString("address"))) continue;
                JSONArray roots = repository.optJSONArray("ticketRoots"); if (roots == null) repository.put("ticketRoots", roots = new JSONArray());
                boolean exists = false; for (int j = 0; j < roots.length(); j++) if (root.id.equals(roots.optJSONObject(j).optString("id"))) exists = true;
                if (!exists) roots.put(new JSONObject().put("id", root.id).put("author", root.author).put("kind", root.kind));
                sp.edit().putString("gitSubs", repositories.toString()).putLong("rev", System.currentTimeMillis()).apply(); return;
            }
        } catch (JSONException e) { Log.w(TAG, "Failed to persist Git root", e); }
    }

    private void handleEvent(JSONObject event, String relayUrl) {
        String id = event.optString("id");
        if (id.isEmpty() || notifiedIds.contains(id)) {
            return;
        }

        int kind = event.optInt("kind");

        // Security gate — the relay is untrusted. (1) Drop anything that
        // doesn't satisfy a filter we actually sent, so a relay can't inject
        // notifications or poison the shared store with a group we never
        // joined, a DM from a non-follow, or a wrap not addressed to us.
        // (2) Require a valid author signature on every non-wrap event. Gift
        // wraps (kind 1059/21059) carry only an ephemeral / group-derived
        // outer key whose signature proves no sender identity (matching the
        // WebView's verifyEventSkippingWraps), so the outer sig is skipped
        // here and the INNER seal is Schnorr-verified at decrypt time instead
        // (see openConcord/handleDm17Wrap). Everything else — NIP-29
        // chat/reactions/replies and kind-4 DMs — must be verified before it
        // is stored, fed to the WebView, or turned into a notification.
        if (!passesFilter(event, kind, relayUrl)) {
            return;
        }
        if (kind != 1059 && kind != 21059 && !NostrCrypto.verifyEvent(event)) {
            if (BuildConfig.DEBUG) Log.d(TAG, "DROP bad signature kind=" + kind + " id=" + id);
            return;
        }

        // Git-exclusive NIP-34 kinds stop here; the switch below has no case
        // for them. 1111 is deliberately excluded: it doubles as an ordinary
        // NIP-22 reply, and handleGitActivity drops non-git comments silently.
        // After the security gate, so a git event is filter-checked and
        // signature-verified before it is acted on.
        if (kind == 1618 || kind == 1621 || (kind >= 1630 && kind <= 1633)) {
            // Cached like any other relay event so the repository views read it
            // from the store rather than refetching it; the service handles the
            // notification itself, so there is nothing for wire ingest to route.
            ServiceStore.cache(this, event);
            handleGitActivity(event, relayUrl, id, kind);
            return;
        }

        // The user's own replaceable documents. Signature-verified above, so
        // what lands in `main` is the same bytes the WebView would have stored
        // had it fetched this itself — and the rail, mutes and settings are
        // simply current the next time the app opens, with no relay read in the
        // critical path. Nothing here notifies: none of it is a message.
        if (SelfState.isSelfKind(kind)) {
            if (userPubkey != null) ServiceStore.cacheSelfState(this, event, userPubkey);
            return;
        }

        // Write the raw outer event into ArmadaDB — the SAME database the
        // WebView reads, not a mirror of it — and queue it for wire ingest, so
        // the WebView still gets to route it (park undecryptable wraps, ring the
        // scopes that repaint a timeline, raise unread counts) on open/resume.
        // Also feed it live over the bridge when the WebView is up, so a message
        // the service already received renders with no relay round-trip and no
        // "wait for the chat to catch up".
        //
        // Covers the timeline kinds the WebView renders: NIP-29 chat/polls/
        // reactions/replies/deletes, Concord wraps (kind 1059, decrypted
        // below or in the WebView) and DMs
        // (kind 4 — ciphertext; the WebView holds the NIP-04 keys). Each is also
        // recorded in the plugin's per-room rolling cache (see getRoomEvents) so
        // opening a room can pull its natively-received history directly.
        //
        // Whether the store held a kind-1059 wrap BEFORE this write is the
        // durable dedupe floor for DM wraps (their outer timestamps are
        // backdated, so time-based gating can't apply): a wrap either side ever
        // stored (a previous service incarnation, the WebView, or our own
        // published self-copy) must not re-notify.
        boolean storedBefore = false;
        switch (kind) {
            case 9: case 1068: case 7: case 1111: case 5: case 1059: case 4:
                // The relay is passed through because it decides the tenant for
                // NIP-29 kinds (see RelayScope) and which handoff queue carries
                // the event, so the WebView's ingest can route it to the same
                // place. Without it a group-scoped event would have nowhere
                // honest to go and would be dropped.
                storedBefore = ServiceStore.ingest(this, event, relayUrl);
                ArmadaNotificationPlugin.feedRelayEvent(roomKeyFor(event, kind), event.toString(), relayUrl);
                break;
            default:
                break;
        }

        // Concord (E2E): the outer event is a kind-1059 wrap SIGNED BY a
        // derived stream key with NIP-44-encrypted content. Open wrap → seal →
        // rumor with the stream's conversation key (derived in the WebView,
        // where membership lives) to recover the real author + plaintext, then
        // notify just like a group message. If decryption fails (e.g. a rekey
        // epoch we don't hold yet) fall back to a keyless room notification.
        if (kind == 1059) {
            ConcordStream st = pkToStream2.get(event.optString("pubkey"));
            if (st == null) {
                // Not a Concord wrap — a NIP-17 DM wrap. Handle + return.
                handleDm17Wrap(event, id, relayUrl, storedBefore);
                return;
            }
            long cts = event.optLong("created_at", 0);
            if (cts + 1 > sinceSec) sinceSec = cts + 1;
            notifiedIds.add(id);

            // CORD-08: a disappearing message's wrap carries the rumor's NIP-40
            // deadline, so an already-expired one is refused before anything is
            // decrypted — not stored, not parked, not notified (the DM path
            // above applies the same rule to its envelope).
            if (ServiceStore.isExpired(event)) return;

            ConcordOpen opened = openConcord(event, st);
            if (opened == null) {
                // Couldn't decrypt — a rekey epoch whose key we don't hold, or
                // a foreign payload. PARK the wrap for the WebView, which holds
                // the community's full key history: peek+ack there means a
                // notified message is never locally destroyed, and this is the
                // one path by which a wrap we can't read still reaches its
                // channel. Then still tell the user something arrived, and
                // where. (Generic body, but a real room title.)
                ServiceStore.parkConcordWrap(this, event);
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord (opaque): " + st.name);
                // A mention lives on the rumor we just failed to open, so a
                // "mentions only" channel has no signal to notify on and stays
                // silent — the wrap is parked either way, so the WebView (which
                // holds the full key history) still surfaces it on open.
                if (st.mentionOnly) return;
                if (!prefBool("allGroupMessages", true)) return;
                enqueueRoomMessage(
                        st.community, "c2:" + st.channelId, st.name, st.url,
                        /*senderPubkey=*/null, "Someone", /*picture=*/null,
                        "New message", System.currentTimeMillis(), /*mention=*/false);
                return;
            }

            JSONObject rumor = opened.rumor;

            // File the decrypted rumor in its community's opened-event tenant —
            // the same row, byte for byte, that the WebView writes (the rumor
            // as its author wrote it, nothing added). This is what makes a
            // notified Concord message
            // present in the channel on open rather than something the WebView
            // has to decrypt again from a parked wrap. openConcord has already
            // proved the seal's signature, that the rumor's author IS the seal's
            // signer, and that the channel/epoch binding matches the stream key
            // that opened the wrap — the checks the WebView's write path makes
            // before it will file a rumor under a channel.
            ServiceStore.storeConcordRumor(this, st.communityId, opened.sealKind, rumor);

            // Every chat-plane kind rides an identical wrap. Messages (kind 9),
            // thread replies (kind 1111), and reactions (kind 7) to YOUR own
            // message notify — a reaction only when its `p` tag names you
            // (NIP-25, carried on the encrypted rumor). Edits (5/3302), deletes
            // (5), reactions to others' messages, and other chat-plane kinds
            // stay silent — the subscription covers ALL kind-1059 wraps,
            // including non-message chat-plane traffic the WebView handles
            // silently.
            int rumorKind = rumor.optInt("kind", -1);
            final String author2 = rumor.optString("pubkey");
            if (author2.equals(userPubkey)) {
                return; // our own message / reaction echoed back
            }

            // Reaction to your own message: mirror the NIP-29 path with a
            // "Reacted 👍 to your message" line, gated on the reactions pref.
            if (rumorKind == 7) {
                if (!isMentioned(rumor, userPubkey)) {
                    return; // a reaction to someone else's message — silent
                }
                if (!prefBool("reactions", true)) {
                    return;
                }
                final ConcordStream fStR = st;
                final String reactionLine = "Reacted " + reactionEmoji(rumor) + " to your message";
                final long rtsR = rumor.optLong("created_at", 0);
                final long fTsR = (rtsR > 0 ? rtsR * 1000L : System.currentTimeMillis());
                // Land on YOUR message the reaction points at (its `e` tag).
                final String reactTarget = tagValue(rumor, "e");
                // A reaction is always directed at you (mention=true), so it
                // breaks through active-room suppression like a mention.
                if (isActivelyViewed("c2:" + fStR.channelId, null, /*mention=*/true)) {
                    return;
                }
                resolveAuthor(author2, relayUrl, profile -> {
                    String name = displayName(profile);
                    String picture = profile != null ? profile.picture : null;
                    if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord reaction: " + fStR.name + " / " + name);
                    enqueueRoomMessage(
                            fStR.community, "c2:" + fStR.channelId, fStR.name,
                            appendMessageSegment(fStR.url, reactTarget),
                            author2, name, picture, reactionLine, fTsR, /*mention=*/true);
                });
                return;
            }

            if (rumorKind != 9 && rumorKind != 1111) {
                return;
            }
            boolean mentionsMe2 = isMentioned(rumor, userPubkey);
            // Concord rooms reuse the group-message prefs: always notify on a
            // mention; otherwise honour the all-messages toggle — unless the
            // channel is "mentions only", which drops everything else first.
            if (st.mentionOnly && !mentionsMe2) {
                return;
            }
            if (!(mentionsMe2 ? prefBool("mentions", true) : prefBool("allGroupMessages", true))) {
                return;
            }
            final ConcordStream fSt = st;
            final boolean fMention2 = mentionsMe2;
            final String preview2 = messagePreview(rumor);
            final long rts = rumor.optLong("created_at", 0);
            final long fTs2 = (rts > 0 ? rts * 1000L : System.currentTimeMillis());
            // A kind-1111 comment (threaded reply) carries its thread root in the
            // uppercase `E` tag. Append it to the deep-link so the WebView can
            // open the thread panel on tap instead of just the channel.
            final String threadRoot2 = innerKindCommentRoot(rumor);
            // Top-level messages deep-link to the message row itself; thread
            // replies keep the thread param (the panel is the destination —
            // the reply isn't a timeline row the permalink jump can land on).
            final String msgId2 = threadRoot2 == null ? rumor.optString("id", "") : null;
            // SYNCHRONOUS active-room suppression: check before the async profile
            // fetch so the decision is immediate (no race with the Capacitor
            // bridge). A mention always breaks through.
            if (isActivelyViewed("c2:" + fSt.channelId, threadRoot2, fMention2)) {
                return;
            }
            resolveAuthor(author2, relayUrl, profile -> {
                String name = displayName(profile);
                String picture = profile != null ? profile.picture : null;
                String text = buildMessageText(preview2, fMention2, threadRoot2 != null);
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord: " + fSt.name + " / " + name);
                enqueueRoomMessage(
                        fSt.community, "c2:" + fSt.channelId, fSt.name,
                        appendMessageSegment(appendThreadSegment(fSt.url, threadRoot2), msgId2),
                        author2, name, picture, text, fTs2, fMention2);
            });
            return;
        }

        String author = event.optString("pubkey");
        if (author.equals(userPubkey)) {
            return;
        }

        boolean mentionsMe = pTags(event).contains(userPubkey);

        // The group this event belongs to, needed before the gate below so a
        // "mentions only" room can drop it. Recomputed into nip29GroupId after
        // the claim for the deep link.
        if (!wantsNotification(kind, mentionsMe,
                isMentionOnlyGroup(relayUrl, tagValue(event, "h")))) {
            return;
        }

        // Claim the event now so the async profile fetch can't double-fire, and
        // advance `since` so reconnects don't replay it.
        notifiedIds.add(id);
        long ts = event.optLong("created_at", 0);
        if (ts + 1 > sinceSec) sinceSec = ts + 1;

        final boolean mention = mentionsMe;
        final long fTs = (ts > 0 ? ts * 1000L : System.currentTimeMillis());
        // For NIP-29 kind-1111 thread replies, the thread root lives in the
        // uppercase `E` tag (NIP-22). We append it to the deep-link so the
        // WebView can auto-open the thread panel on tap.
        final String nip29ThreadRoot = kind == 1111 ? tagValue(event, "E") : null;
        // Pre-compute the NIP-29 room key for the synchronous active-room check
        // below (so we don't need to re-extract the group id inside the callback).
        final String nip29GroupId = tagValue(event, "h");
        final String nip29RoomKey = nip29GroupId != null
                ? "h:" + relayUrl + "|" + nip29GroupId : null;
        // SYNCHRONOUS active-room suppression: check before the async profile
        // fetch so the decision is immediate (no race with the Capacitor
        // bridge). A mention always breaks through.
        if (isActivelyViewed(nip29RoomKey, nip29ThreadRoot, mention)) {
            return;
        }
        // Resolve the author's name + avatar, then feed a per-room message line.
        // MessagingStyle shows WHO via the sender Person, so the line is just the
        // message/verb; the room name is the conversation title.
        resolveAuthor(author, relayUrl, profile -> {
            String name = displayName(profile);
            final String picture = profile != null ? profile.picture : null;
            String line;
            String url;
            switch (kind) {
                case 9: {
                    line = messagePreview(event);
                    if (line.isEmpty()) line = "Sent a message";
                    if (mention) line = "@you " + line;
                    url = nip29GroupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(nip29GroupId)
                            : "/";
                    // Land on the message itself, not just its channel.
                    url = appendMessageSegment(url, id);
                    break;
                }
                case 7: {
                    line = "Reacted " + reactionEmoji(event) + " to your message";
                    url = nip29GroupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(nip29GroupId)
                            : "/";
                    // Land on YOUR message the reaction points at (its `e` tag).
                    url = appendMessageSegment(url, tagValue(event, "e"));
                    break;
                }
                case 1111: {
                    line = buildMessageText(messagePreview(event), mention, true);
                    url = nip29GroupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(nip29GroupId)
                            : "/";
                    // Deep-link to the reply inside its thread (uppercase `E`
                    // root id): a tap opens the thread panel and lands on the
                    // reply. The id is only appended alongside the thread —
                    // a reply is never in the channel timeline, so `/m/` on
                    // its own would name a message the timeline can't find.
                    if (nip29ThreadRoot != null && !nip29ThreadRoot.isEmpty()) {
                        url = appendMessageSegment(appendThreadSegment(url, nip29ThreadRoot), id);
                    }
                    break;
                }
                case 4:
                    // kind-4 DMs are NIP-04 encrypted; the service has no key.
                    line = "Sent you a direct message";
                    url = appendMessageSegment("/dm/" + author, id);
                    break;
                default:
                    return;
            }
            final String fName = name;
            final String fLine = line;
            final String fUrl = url;
            if (nip29GroupId == null) {
                // DM: the conversation is 1:1 with the sender, so the sender's
                // name is the room title and it's not a "group" conversation.
                // mention=false so it's suppressed while this peer's thread is on
                // screen — a DM's `p` tag naming us isn't a break-through @-ping.
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY dm from=" + fName);
                // DM: null community ⇒ a per-peer notification with no
                // conversation title.
                enqueueRoomMessage(
                        /*community=*/null, "dm:" + author, fName, fUrl,
                        author, fName, picture, fLine, fTs, /*mention=*/false);
                return;
            }
            // Resolve the group's display name; it becomes the conversation
            // title. The picture — cached by the same kind-39000 fetch — is the
            // conversation's avatar. A NIP-29 group is its own community (one
            // channel), so no per-message channel label is needed.
            resolveGroupName(nip29GroupId, relayUrl, groupName -> {
                String roomTitle = (groupName != null && !groupName.isEmpty()) ? groupName : "Group";
                CommunityRef community = new CommunityRef(
                        GROUP_PREFIX + "h:" + relayUrl + "|" + nip29GroupId,
                        roomTitle,
                        "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(nip29GroupId),
                        groupPictureCache.get(nip29GroupId), null, null, null);
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY kind=" + kind + " room=" + roomTitle);
                enqueueRoomMessage(
                        community, nip29RoomKey, roomTitle, fUrl,
                        author, fName, picture, fLine, fTs, mention);
            });
        });
    }

    /**
     * Synchronous active-room check: returns true if the user is currently
     * viewing this room (channel-level suppression) or this specific thread
     * (thread-level suppression), so the caller can skip the notification
     * before any async work (profile fetch, group-name resolve). A mention
     * always returns false — a deliberate @-ping deserves attention even on
     * the visible channel.
     *
     * @param roomKey    the channel-level roomKey (e.g. "c2:<id>", "z:<z>", "h:<relay>|<group>")
     * @param threadRoot the thread root id (uppercase `E` tag), or null for a top-level message
     * @param mention    whether this message @-mentions the user
     */
    private boolean isActivelyViewed(String roomKey, String threadRoot, boolean mention) {
        if (mention) return false;
        if (roomKey == null) return false;
        Set<String> active = activeRoomKeys;
        if (active.contains(roomKey)) {
            if (BuildConfig.DEBUG) Log.d(TAG, "SUPPRESS (channel active): " + roomKey);
            return true;
        }
        if (threadRoot != null) {
            String threadKey = roomKey + ":t:" + threadRoot;
            if (active.contains(threadKey)) {
                if (BuildConfig.DEBUG) Log.d(TAG, "SUPPRESS (thread active): " + threadKey);
                return true;
            }
        }
        return false;
    }

    /**
     * Build the notification line text for a message. Thread replies get a
     * Signal-style "Replied in thread: <preview>" prefix instead of the bare
     * content, so the notification makes sense without the parent message's
     * context.
     */
    private static String buildMessageText(String preview, boolean mention, boolean isThreadReply) {
        String text = !preview.isEmpty() ? preview : (isThreadReply ? "Replied in thread" : "Sent a message");
        if (isThreadReply && !preview.isEmpty()) text = "Replied in thread: " + text;
        return text;
    }

    /**
     * Prepare an event's content for a notification body, mirroring the web
     * client's on-screen preview: resolve NIP-27 {@code nostr:} mentions to
     * {@code @name} and strip inline media URLs (images/video/audio) that would
     * otherwise show as a raw blob URL. See {@link NotificationContent}.
     */
    private String cleanContent(String content) {
        return NotificationContent.clean(content, this::mentionName);
    }

    /**
     * Notification body for a message event/rumor: the cleaned content, or —
     * when stripping media URLs left nothing — a "Sent an image"-style line
     * naming the media kind. The kind comes from the imeta {@code m} MIME
     * first (an encrypted attachment's blob URL has no media extension, and
     * the URL of a Concord/DM attachment lives ONLY in the imeta), falling
     * back to the first media URL's extension. Empty only when the message
     * has neither text nor recognizable media.
     */
    private String messagePreview(JSONObject event) {
        String content = event.optString("content");
        String preview = truncate(cleanContent(content));
        if (!preview.isEmpty()) return preview;
        String label = NotificationContent.mediaLabel(firstImetaMime(event), content);
        return label != null ? "Sent " + label : "";
    }

    /** The {@code m <mime>} field of the event's first imeta tag carrying one, or null. */
    private static String firstImetaMime(JSONObject event) {
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return null;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag == null || tag.length() < 2 || !"imeta".equals(tag.optString(0))) continue;
            for (int j = 1; j < tag.length(); j++) {
                String field = tag.optString(j, "");
                if (field.startsWith("m ")) {
                    String mime = field.substring(2).trim();
                    if (!mime.isEmpty()) return mime;
                }
            }
        }
        return null;
    }

    /**
     * Display name for a MENTIONED pubkey, resolved best-effort from what we
     * already hold (memory store, then the shared DB) — never the network, so a
     * mention can't delay or block the notification. An unknown mention falls
     * back to "Anonymous" via {@link #displayName}, never a wrong name.
     */
    private String mentionName(String pubkeyHex) {
        return displayName(cachedProfile(pubkeyHex));
    }

    /** Synchronous profile lookup from cache/DB only; null when not held. */
    private Profile cachedProfile(String pubkey) {
        ProfileStore.Entry held = profileStore.get(pubkey);
        if (held != null) return new Profile(held.name, held.picture, held.nip05, held.ts);
        try {
            String raw = ServiceStore.profileRaw(this, pubkey);
            if (raw != null) return parseProfile(new JSONObject(raw));
        } catch (Exception ignored) {
            // Unreadable row — treat as unknown ("Anonymous" fallback).
        }
        return null;
    }

    /** Display name from a resolved profile, falling back to "Anonymous". */
    private static String displayName(Profile profile) {
        if (profile != null && profile.name != null && !profile.name.isEmpty()) {
            return profile.name;
        }
        // Fall back to the NIP-05 identifier (its local-part, dropping a leading
        // "_@" which conventionally means "the domain itself") before giving up,
        // so a user with only a nip05 still gets a readable name.
        if (profile != null && profile.nip05 != null && !profile.nip05.isEmpty()) {
            String n = profile.nip05;
            int at = n.indexOf('@');
            if (at == 0) {
                n = n.substring(1);
            } else if (at > 0) {
                String local = n.substring(0, at);
                n = local.equals("_") ? n.substring(at + 1) : local;
            }
            if (!n.isEmpty()) return n;
        }
        return "Anonymous";
    }

    /**
     * Map a kind-7 reaction's content to a display emoji, mirroring the web
     * client (useReactions.ts): "+"/empty → 👍, "-" → 👎, ":shortcode:" → the
     * bare shortcode, otherwise the content verbatim.
     */
    private static String reactionEmoji(JSONObject event) {
        String c = event.optString("content", "").trim();
        if (c.isEmpty() || c.equals("+")) return "👍";
        if (c.equals("-")) return "👎";
        if (c.length() >= 2 && c.startsWith(":") && c.endsWith(":")) {
            return c.substring(1, c.length() - 1);
        }
        return c;
    }

    /**
     * Filter-match gate: an event the relay streams us is only acted on if it
     * actually satisfies one of the REQ filters this connection sent (see
     * {@link RelayConnection#sendReqs}). Mirrors those filters' exact
     * kind/author/tag predicates — scoped to the same relay role — so a
     * malicious or buggy relay can't smuggle in traffic we never asked for
     * (a kind-9 for a group we haven't joined, a DM from a non-follow, a
     * Concord wrap for a channel/stream we hold no key for, a gift wrap not
     * addressed to us). {@code since} gating is handled separately
     * (notifiedIds + sinceSec); this is purely the kind/author/tag match. Any
     * kind no filter requests (e.g. 5 deletes, 1068 polls) falls through to
     * false and is dropped.
     */
    private boolean passesFilter(JSONObject event, int kind, String relayUrl) {
        switch (kind) {
            case 9: {
                // {kinds:[9], "#h":ids} — only the groups THIS relay hosts.
                Set<String> gids = relayToGroupIds.get(relayUrl);
                return gids != null && gids.contains(tagValue(event, "h"));
            }
            case 7:
            case 1111: {
                // {kinds:[7,1111], "#h":ids, "#p":[me]} on the group's host relay.
                Set<String> gids = relayToGroupIds.get(relayUrl);
                return gids != null
                        && gids.contains(tagValue(event, "h"))
                        && pTags(event).contains(userPubkey);
            }
            case 4:
                // {kinds:[4], authors:dmFollows, "#p":[me]} on the DM relays.
                return dmRelays.contains(relayUrl)
                        && dmFollows.contains(event.optString("pubkey"))
                        && pTags(event).contains(userPubkey);
            case 1059: {
                // Two filters carry kind 1059: the Concord wrap sub is
                // authors-scoped to this relay's stream keys; the NIP-17 DM
                // wrap sub is the broad "#p":[me] inbox on the DM relays.
                Set<String> pks = relayToPks2.get(relayUrl);
                if (pks != null && pks.contains(event.optString("pubkey"))) return true;
                return dmRelays.contains(relayUrl) && pTags(event).contains(userPubkey);
            }
            default:
                // The user's own replaceable documents: authored by us, and
                // only on the relays we actually asked. SelfState.storable
                // re-checks authorship against the parsed rumor at write time;
                // this is the same refusal at the filter boundary, so a relay
                // volunteering somebody else's 10009 is dropped before it is
                // verified, stored, or counted.
                if (SelfState.isSelfKind(kind)
                        && userPubkey != null
                        && userPubkey.equals(event.optString("pubkey"))) {
                    return selfRelays.contains(relayUrl) || relayUrls.contains(relayUrl);
                }
                return false;
        }
    }

    /**
     * @param mentionOnly the event's room is set to "mentions only", so
     *     anything that doesn't name the user is suppressed regardless of the
     *     per-kind prefs. Reactions and thread replies survive it on their own
     *     merit: both only reach here having `p`-tagged the user.
     */
    private boolean wantsNotification(int kind, boolean mentionsMe, boolean mentionOnly) {
        return wantsNotification(kind, mentionsMe, mentionOnly, prefs);
    }

    /** Static so the decision is unit-testable without an Android runtime. */
    static boolean wantsNotification(int kind, boolean mentionsMe, boolean mentionOnly, JSONObject prefs) {
        if (mentionOnly && !mentionsMe) return false;
        switch (kind) {
            case 9:
                if (mentionsMe) return prefs.optBoolean("mentions", true);
                return prefs.optBoolean("allGroupMessages", true);
            case 7:
                return prefs.optBoolean("reactions", true);
            case 1111:
                return prefs.optBoolean("replies", true);
            case 4:
                return prefs.optBoolean("directMessages", true);
        }
        return false;
    }

    private boolean prefBool(String key, boolean dflt) {
        return prefs.optBoolean(key, dflt);
    }

    // ── Notifications ───────────────────────────────────────────────────────

    /**
     * Append a message to its room's accumulating MessagingStyle notification
     * and (re)post it. This is the single entry point for all message-like
     * notifications (groups, Concord channels, DMs). Each channel and each DM
     * peer gets its own standalone conversation notification, so a tap and the
     * Mark read action act on that one conversation only.
     *
     * @param community the community this room belongs to — its image/name
     *                  brand the notification. {@code null} for 1:1 DMs, which
     *                  render without a conversation title.
     * @param roomKey   stable conversation id (groupId / Concord channel / "dm:<peer>"),
     *                  used for active-room suppression and Mark-read markers
     * @param roomTitle conversation display name ("Community / #channel", or
     *                  peer name for DMs)
     * @param url       in-app deep-link opened on tap
     * @param senderPubkey  message author (for the MessagingStyle Person key)
     * @param senderName    author display name
     * @param senderPicture author avatar URL (resolved async; optional)
      * @param text          the message line (already truncated/verb-substituted)
      * @param timestampMs   message time in ms (for ordering in the expansion)
     * @param mention       true if this message @-mentioned the user (bypasses
     *                      the active-room suppression — a mention is a deliberate
     *                      ping even on the channel the user is currently viewing)
     */
    private void enqueueRoomMessage(
            CommunityRef community, String roomKey, String roomTitle, String url,
            String senderPubkey, String senderName, String senderPicture,
            String text, long timestampMs, boolean mention) {
        // Suppress the notification entirely when the user is already looking at
        // this room — the live `relayEvent` feed already
        // painted the message in the timeline, so a tray entry would be
        // redundant. A mention still fires: it's an explicit @-ping that
        // deserves attention even on the visible channel. The active-room keys
        // are volatile (live only on the running service instance), so killing
        // the app or the service immediately resumes notifications.
        if (!mention && roomKey != null && activeRoomKeys.contains(roomKey)) {
            return;
        }
        // Past the room's alert budget the notification is still posted and
        // still accumulates — it just stops making noise. See ALERT_BURST_MAX.
        boolean alert = alertAllowed(roomKey, mention);
        // Post immediately without the avatar, then re-post with it once loaded
        // so image I/O never delays the notification.
        Bitmap cachedAvatar = senderPicture != null ? avatarCache.get(senderPicture) : null;
        postRoomMessage(community, roomKey, roomTitle, url, senderPubkey, senderName,
                cachedAvatar, text, timestampMs, /*avatarRefresh=*/false, alert);

        if (senderPicture != null && !senderPicture.isEmpty() && cachedAvatar == null) {
            fetchAvatar(senderPicture, bmp -> {
                if (bmp != null) {
                    // Attach the avatar to the just-added message line, then
                    // re-post the same room id. This is a silent refresh — the
                    // initial post already alerted, so don't vibrate/sound again
                    // just because the avatar finished loading.
                    postRoomMessage(community, roomKey, roomTitle, url, senderPubkey, senderName,
                            bmp, text, timestampMs, /*avatarRefresh=*/true, /*alert=*/false);
                }
            });
        }
    }

    /**
     * Whether this room may make NOISE for one more message, spending from the
     * per-room budget described at {@link #ALERT_BURST_MAX}. Messages and
     * mentions draw on separate budgets.
     *
     * Called once per notified message on the relay thread (the same thread
     * that owns every other field here), so the maps need no synchronization.
     */
    private boolean alertAllowed(String roomKey, boolean mention) {
        if (roomKey == null) return true;
        java.util.Map<String, java.util.ArrayDeque<Long>> budget = mention ? mentionBurst : alertBurst;
        java.util.ArrayDeque<Long> times = budget.get(roomKey);
        if (times == null) {
            times = new java.util.ArrayDeque<>();
            budget.put(roomKey, times);
        }
        long now = System.currentTimeMillis();
        while (!times.isEmpty() && now - times.peekFirst() > ALERT_BURST_WINDOW_MS) {
            times.pollFirst();
        }
        boolean allow = times.size() < (mention ? ALERT_BURST_MAX_MENTION : ALERT_BURST_MAX);
        // Recorded whether or not it alerted — that is what keeps a sustained
        // flood's window full, and quiet, until the flood actually stops.
        times.addLast(now);
        while (times.size() > ALERT_BURST_MAX_TRACKED) times.pollFirst();
        return allow;
    }

    /**
     * Core builder: accumulate a message into its {@link RoomNotif} and post
     * the room's MessagingStyle notification. When {@code avatarRefresh} is
     * set, no new line is added; instead the matching already-added line gets
     * its sender avatar attached (used to re-post once the avatar resolves).
     * {@code alert} false posts silently (no vibration/sound) for such
     * in-place refreshes.
     */
    private void postRoomMessage(
            CommunityRef community, String roomKey, String roomTitle, String url,
            String senderPubkey, String senderName, Bitmap avatar,
            String text, long timestampMs, boolean avatarRefresh, boolean alert) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        RoomNotif room = roomNotifs.get(roomKey);
        if (room == null) {
            room = new RoomNotif(roomKey, hashId(roomKey));
            roomNotifs.put(roomKey, room);
        }
        room.community = community;
        // If the room's notification was dismissed (swiped / tapped away) since
        // its last message, start a FRESH notification rather than appending to
        // the dismissed message history — otherwise a new message in a room the
        // user already cleared would resurrect the old lines they dismissed.
        // Only checked on a genuine new line; an in-place avatar refresh
        // re-uses the just-added line.
        if (!avatarRefresh && !room.messages.isEmpty() && !isNotifActive(manager, room.notifId)) {
            room.messages.clear();
            room.lastTimestampMs = timestampMs;
        }

        String sKey = senderPubkey != null ? senderPubkey : roomKey;
        String sName = senderName != null ? senderName : "Someone";
        if (avatarRefresh) {
            // Attach the avatar to the line this refresh belongs to. Matched by
            // sender + timestamp + text (not "the last line") so a message that
            // arrived meanwhile can't get the wrong face.
            boolean found = false;
            for (int i = room.messages.size() - 1; i >= 0; i--) {
                MsgEntry e = room.messages.get(i);
                if (e.tsMs == timestampMs && e.senderKey.equals(sKey) && e.text.equals(text != null ? text : "")) {
                    e.avatar = avatar;
                    found = true;
                    break;
                }
            }
            if (!found) return; // line already rotated out / dismissed
        } else {
            room.messages.add(new MsgEntry(sKey, sName, avatar,
                    text != null ? text : "", timestampMs, /*fromSelf=*/false));
            // Bound the retained history so a chatty room can't grow unbounded.
            while (room.messages.size() > MAX_MESSAGES_PER_ROOM) {
                room.messages.remove(0);
            }
            room.title = roomTitle;
            room.url = url;
        }
        room.lastTimestampMs = Math.max(room.lastTimestampMs, timestampMs);
        if (avatar != null) {
            // Remember it for the collapsed-view large icon fallback.
            room.lastAvatar = avatar;
        }

        // Conversation shortcut (the key to the Signal-style left avatar on
        // Android 11+, see pushConversationShortcut): every room gets one. A DM
        // uses the sender's avatar; a community room uses the COMMUNITY image
        // (like a Signal group chat's group avatar) — if it isn't cached yet,
        // the shortcut goes up icon-less and the async fetch below re-pushes it
        // (and silently re-posts the room) once resolved.
        // The shortcut names the CONVERSATION, so its person is the last
        // INCOMING sender — a reply we sent must not repoint a DM's shortcut
        // (and its avatar) at ourselves.
        MsgEntry lastEntry = room.messages.get(room.messages.size() - 1);
        for (int i = room.messages.size() - 1; i >= 0; i--) {
            if (!room.messages.get(i).fromSelf) {
                lastEntry = room.messages.get(i);
                break;
            }
        }
        Person lastSender = personFor(lastEntry);
        Bitmap communityIcon = community != null ? groupImageCache.get(community.imageCacheKey()) : null;
        if (community == null) {
            pushConversationShortcut(room, lastSender,
                    avatar != null ? avatar : room.lastAvatar);
        } else {
            pushConversationShortcut(room, lastSender, communityIcon);
        }

        // Drop rooms the user already dismissed from the tray so a later message
        // starts a fresh notification instead of resurrecting cleared lines.
        pruneDismissedRooms(manager, room.notifId);

        manager.notify(room.notifId, buildRoomNotification(room, alert));

        // Kick off the community-icon fetch if we don't have it yet; once
        // resolved, re-push the shortcut and silently re-post so the left
        // avatar updates from the app icon to the community image.
        if (community != null && communityIcon == null && community.hasImage()) {
            fetchCommunityImage(community, bmp -> {
                if (bmp == null) return;
                groupImageCache.put(community.imageCacheKey(), bmp);
                RoomNotif r = roomNotifs.get(roomKey);
                if (r == null || r.messages.isEmpty()) return;
                NotificationManager m2 =
                        (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (m2 == null || !isNotifActive(m2, r.notifId)) return;
                MsgEntry le = r.messages.get(r.messages.size() - 1);
                pushConversationShortcut(r, personFor(le), bmp);
                m2.notify(r.notifId, buildRoomNotification(r, /*alert=*/false));
            });
        }
    }

    /**
     * Remove from {@link #roomNotifs} any room whose notification is no longer in
     * the status bar (the user tapped/swiped it away), except {@code keepNotifId}
     * (the one we're about to (re)post). API 23+; a no-op on older devices.
     */
    private void pruneDismissedRooms(NotificationManager manager, int keepNotifId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            Set<Integer> active = new HashSet<>();
            for (android.service.notification.StatusBarNotification sbn : manager.getActiveNotifications()) {
                active.add(sbn.getId());
            }
            java.util.Iterator<Map.Entry<String, RoomNotif>> it = roomNotifs.entrySet().iterator();
            while (it.hasNext()) {
                RoomNotif r = it.next().getValue();
                if (r.notifId != keepNotifId && !active.contains(r.notifId)) {
                    it.remove();
                }
            }
        } catch (Exception ignored) {
            // getActiveNotifications can throw on some OEM builds — best-effort.
        }
    }

    /**
     * Whether the notification id is still in the status bar (i.e. has NOT been
     * dismissed by the user). API 23+; returns true (assume active) on older
     * devices or when getActiveNotifications throws on an OEM build, so we never
     * spuriously clear a room's history on a device that can't actually tell us.
     */
    private boolean isNotifActive(NotificationManager manager, int notifId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        try {
            for (android.service.notification.StatusBarNotification sbn : manager.getActiveNotifications()) {
                if (sbn.getId() == notifId) return true;
            }
            return false;
        } catch (Exception ignored) {
            return true;
        }
    }

    /** Build a room's MessagingStyle notification from its accumulated messages. */
    private Notification buildRoomNotification(RoomNotif room, boolean alert) {
        // Every room is a conversation notification: paired with the
        // conversation shortcut pushed in postRoomMessage (setShortcutId
        // below), Android 11+ renders the shortcut's avatar as the LEFT icon
        // in place of the app icon — the peer's avatar for a 1:1 DM, the
        // community image for a channel (like a Signal group chat).
        boolean isDm = room.community == null;

        // The local user, who a sent quick reply is attributed to: their own
        // kind-0 name + avatar when we hold one, "You" when we don't.
        Person self = selfPerson();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(self);
        if (isDm) {
            // 1:1: no conversation title — the system titles it with the
            // sender Person's name (a title would make it render as a group).
            style.setGroupConversation(false);
        } else {
            style.setConversationTitle(conversationTitle(room));
            style.setGroupConversation(true);
        }
        for (MsgEntry e : room.messages) {
            // A null sender means "the current user" (the style's self person)
            // — how a line sent from the Reply action renders as outgoing.
            style.addMessage(new NotificationCompat.MessagingStyle.Message(
                    e.text, e.tsMs, e.fromSelf ? null : personFor(e)));
        }

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
                .setStyle(style)
                .setSmallIcon(R.drawable.ic_stat_armada)
                // Sender avatar fallback for surfaces that don't do the
                // conversation layout (pre-Android-11, some OEM skins). On the
                // conversation layout the system ignores this and uses the
                // shortcut/Person avatar on the left instead.
                .setLargeIcon(room.lastAvatar)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(roomPendingIntent(room))
                .setAutoCancel(true)
                .setWhen(room.lastTimestampMs)
                // A silent refresh (e.g. late avatar) must not re-buzz; only a
                // genuine new message alerts.
                .setOnlyAlertOnce(!alert)
                // Ties the notification to the conversation shortcut pushed in
                // postRoomMessage — the key that promotes it into the
                // conversation space where the shortcut's avatar (sender for
                // DMs, community image for channels) replaces the app icon.
                .setShortcutId(shortcutIdFor(room));
        // Each conversation gets its OWN unique group key: it shows
        // standalone (a group of one, no summary), but the explicit key opts
        // it out of Android's auto-bundling — which otherwise sweeps 4+
        // group-less notifications into one system pile under the app icon,
        // collapsing separate conversations together. Deliberately NOT the
        // community's shared key: a per-community group summary can't carry
        // the community's branding (Android renders the app name/icon), so
        // channels stand alone instead of stacking.
        b.setGroup(GROUP_PREFIX + "room:" + room.roomKey);
        // "Reply": a RemoteInput the service publishes back into the
        // conversation natively (see handleReply). Only on rooms with a real
        // send path — no shared signer, or a room the config can't route a
        // send for, leaves Mark read alone.
        if (canReply(room)) {
            RemoteInput input = new RemoteInput.Builder(KEY_TEXT_REPLY)
                    .setLabel("Reply")
                    .build();
            b.addAction(new NotificationCompat.Action.Builder(
                    R.drawable.ic_stat_armada, "Reply", replyIntent(room))
                    .addRemoteInput(input)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .setShowsUserInterface(false)
                    .setAllowGeneratedReplies(true)
                    .build());
        }
        // "Mark read": dismiss this notification and advance the in-app read
        // state (applied by the WebView on its next open). Shown on every room.
        b.addAction(new NotificationCompat.Action.Builder(
                R.drawable.ic_stat_armada, "Mark read", markReadIntent(room)).build());
        if (alert) {
            b.setVibrate(MSG_VIBRATION_PATTERN)
                    .setDefaults(NotificationCompat.DEFAULT_LIGHTS | NotificationCompat.DEFAULT_SOUND);
        }
        return b.build();
    }

    /** The conversation title shown for a room (and its shortcut label). */
    private static String conversationTitle(RoomNotif room) {
        return room.title != null && !room.title.isEmpty() ? room.title : "Chat";
    }

    /**
     * The MessagingStyle self Person — who a sent quick reply shows as. Uses
     * the user's own kind-0 (name + avatar) once {@link #warmSelfProfile} has
     * resolved it, falling back to a bare "You". Synchronous by construction:
     * it reads only the warmed fields, so building a notification never waits
     * on a profile fetch or an avatar decode.
     *
     * The fallback is "You", not {@link #displayName}'s "Anonymous" — an
     * unnamed profile should read as the user, not as a stranger.
     */
    private Person selfPerson() {
        String name = "You";
        if (selfProfile != null) {
            String resolved = displayName(selfProfile);
            if (!"Anonymous".equals(resolved)) name = resolved;
        }
        Person.Builder pb = new Person.Builder()
                .setName(name)
                .setKey(userPubkey != null ? userPubkey : "self");
        if (selfAvatar != null) pb.setIcon(IconCompat.createWithBitmap(selfAvatar));
        return pb.build();
    }

    /**
     * Resolve the user's own profile + avatar for {@link #selfPerson}, through
     * the same path every other author takes (memory store → shared DB →
     * one-shot relay fetch). Usually a synchronous hit: the WebView writes
     * every kind-0 it reads into the shared store, the user's own included.
     * A late resolve re-posts the rooms already showing a reply, so the line
     * gains its name/avatar in place rather than only on the next message.
     */
    private void warmSelfProfile() {
        if (userPubkey == null || selfProfilePending) return;
        boolean haveName = selfProfile != null;
        boolean needAvatar = selfAvatar == null && selfProfile != null
                && selfProfile.picture != null && !selfProfile.picture.isEmpty();
        if (haveName && !needAvatar) return;
        selfProfilePending = true;
        resolveAuthor(userPubkey, null, profile -> {
            selfProfilePending = false;
            if (profile != null) {
                boolean gainedName = selfProfile == null;
                selfProfile = profile;
                if (gainedName) repostRoomsWithReplies();
            }
            String picture = selfProfile != null ? selfProfile.picture : null;
            if (picture == null || picture.isEmpty() || selfAvatar != null) return;
            Bitmap cached = avatarCache.get(picture);
            if (cached != null) {
                selfAvatar = cached;
                repostRoomsWithReplies();
                return;
            }
            fetchAvatar(picture, bmp -> {
                if (bmp == null) return;
                selfAvatar = bmp;
                repostRoomsWithReplies();
            });
        });
    }

    /**
     * Silently re-post every still-posted room that shows a sent reply, so a
     * self name/avatar that resolved after the fact lands on the line already
     * in the tray.
     */
    private void repostRoomsWithReplies() {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        for (RoomNotif room : roomNotifs.values()) {
            boolean hasReply = false;
            for (MsgEntry e : room.messages) {
                if (e.fromSelf) {
                    hasReply = true;
                    break;
                }
            }
            if (hasReply && isNotifActive(manager, room.notifId)) {
                manager.notify(room.notifId, buildRoomNotification(room, /*alert=*/false));
            }
        }
    }

    /** Build a message line's sender Person (avatar attached once resolved). */
    private static Person personFor(MsgEntry e) {
        Person.Builder pb = new Person.Builder()
                .setName(e.senderName)
                .setKey(e.senderKey);
        if (e.avatar != null) {
            pb.setIcon(IconCompat.createWithBitmap(e.avatar));
        }
        return pb.build();
    }

    /**
     * PendingIntent for a room's "Mark read" action — delivered to the service
     * with {@link #ACTION_MARK_READ} + the room key and its latest message
     * timestamp (carried as one-element arrays so the marker survives a
     * service cold start with the right ts). A per-room data URI keeps each
     * room's PendingIntent distinct (extras alone don't affect PendingIntent
     * identity, so without it two rooms could share one cached intent);
     * FLAG_UPDATE_CURRENT refreshes the extras on every re-post so the
     * timestamp tracks the latest message.
     */
    private PendingIntent markReadIntent(RoomNotif room) {
        Intent intent = new Intent(this, NotificationRelayService.class);
        intent.setAction(ACTION_MARK_READ);
        intent.setData(Uri.parse("armada-markread:" + room.notifId));
        intent.putExtra(EXTRA_ROOM_KEY, room.roomKey);
        intent.putExtra(EXTRA_CHANNEL_KEYS, new String[] { room.roomKey });
        intent.putExtra(EXTRA_CHANNEL_TS, new long[] { room.lastTimestampMs });
        return PendingIntent.getService(
                this, room.notifId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Handle a "Mark read" tap: cancel the room's notification, drop its
     * accumulated history, and enqueue a durable read-marker the WebView
     * applies on its next open/resume to advance the in-app read state.
     * Robust to a cold start (no in-memory room): the room key + timestamp
     * ride on the intent and the notif id is re-derivable from the room key.
     */
    private void handleMarkRead(Intent intent) {
        String roomKey = intent.getStringExtra(EXTRA_ROOM_KEY);
        if (roomKey == null || roomKey.isEmpty()) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        RoomNotif room = roomNotifs.remove(roomKey);
        int notifId = room != null ? room.notifId : hashId(roomKey);
        if (manager != null) {
            manager.cancel(notifId);
        }
        String[] channelKeys = intent.getStringArrayExtra(EXTRA_CHANNEL_KEYS);
        long[] channelTs = intent.getLongArrayExtra(EXTRA_CHANNEL_TS);
        if (channelKeys == null || channelTs == null || channelKeys.length != channelTs.length) {
            // Fallback: treat the room key itself as the one conversation.
            channelKeys = new String[] { roomKey };
            channelTs = new long[] { room != null && room.lastTimestampMs > 0
                    ? room.lastTimestampMs : System.currentTimeMillis() };
        }
        for (int i = 0; i < channelKeys.length; i++) {
            String key = channelKeys[i];
            if (key == null || key.isEmpty()) continue;
            long tsMs = channelTs[i] > 0 ? channelTs[i] : System.currentTimeMillis();
            ArmadaNotificationPlugin.enqueueReadMarker(this, key, tsMs / 1000L);
            if (BuildConfig.DEBUG) Log.d(TAG, "MARK READ " + key);
        }
    }

    // ── Quick reply ──────────────────────────────────────────────────────────

    /**
     * Whether a native send path exists for this room: a shared signer, plus a
     * protocol the service can build end-to-end. DMs go out as NIP-17 (rumor →
     * seal → wrap; the signer covers the seal's encrypt + sign for every login
     * type), NIP-29 rooms as a plain kind 9 to the group's host relay, and
     * Concord rooms as a CORD-02 rumor → seal →
     * wrap — the seal signed through the shared signer, the wrap by the stream
     * secret read from the group-key memo the WebView persists in the shared
     * ArmadaDB (no key crosses the plugin bridge; see streamSecretFor).
     */
    private boolean canReply(RoomNotif room) {
        if (nativeSigner == null || userPubkey == null || room.roomKey == null) return false;
        String key = room.roomKey;
        if (key.startsWith("dm:")) return key.length() == 3 + 64;
        if (key.startsWith("h:")) return key.substring(2).lastIndexOf('|') > 0;
        // Config-only check (no DB read on every post); the stream secret is
        // resolved from the store at send time and fails the reply visibly if
        // the memo lacks it (possible only if the WebView never derived it —
        // which would also mean it could never have configured the stream).
        if (key.startsWith("c2:")) return c2ReplyStream(key.substring(3)) != null;
        return false;
    }

    /**
     * PendingIntent for a room's "Reply" action. MUTABLE — unlike every other
     * PendingIntent here — because the system must attach the RemoteInput
     * results bundle to it; an immutable one delivers a null reply on
     * Android 12+.
     */
    private PendingIntent replyIntent(RoomNotif room) {
        Intent intent = new Intent(this, NotificationRelayService.class);
        intent.setAction(ACTION_REPLY);
        intent.setData(Uri.parse("armada-reply:" + room.notifId));
        intent.putExtra(EXTRA_ROOM_KEY, room.roomKey);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        return PendingIntent.getService(this, room.notifId, intent, flags);
    }

    /**
     * Handle a "Reply" action tap: append the text to the room's notification
     * as an outgoing line at once (which is also what clears the action's
     * spinner), enqueue a read marker (replying implies the room was read),
     * then build and publish the reply natively. On failure the line is
     * rewritten in place and the notification re-alerts, so a reply typed on
     * the lockscreen never silently vanishes.
     */
    private void handleReply(Intent intent) {
        String roomKey = intent.getStringExtra(EXTRA_ROOM_KEY);
        if (roomKey == null || roomKey.isEmpty()) return;
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence raw = results != null ? results.getCharSequence(KEY_TEXT_REPLY) : null;
        String text = raw != null ? raw.toString().trim() : "";
        if (text.isEmpty()) {
            // Nothing to send; re-post as-is so the action's spinner clears.
            RoomNotif existing = roomNotifs.get(roomKey);
            if (existing != null) repostRoom(existing, false);
            return;
        }

        MsgEntry sent = appendOutgoing(roomKey, text);
        markRepliedRead(roomKey);
        // The reply renders as the user: resolve their own kind-0 if this is
        // the first one since the service started (usually a store hit, and a
        // late one re-posts the line in place).
        warmSelfProfile();

        NativeSigner signer = nativeSigner;
        if (signer == null) {
            finishReply(roomKey, sent, false);
        } else if (roomKey.startsWith("dm:")) {
            sendDmReply(signer, roomKey.substring(3), text, roomKey, sent);
        } else if (roomKey.startsWith("h:")) {
            sendNip29Reply(signer, roomKey, text, sent);
        } else if (roomKey.startsWith("c2:")) {
            sendConcordReply(signer, roomKey, text, sent);
        } else {
            finishReply(roomKey, sent, false);
        }
    }

    /**
     * Append the reply as an outgoing line and re-post the room silently.
     * Survives a service cold start (the in-memory room is gone but the
     * notification is still in the tray): a minimal room is rebuilt so the
     * post lands on the same stable id and the spinner still clears — with a
     * generic title, since the accumulated history died with the process.
     */
    private MsgEntry appendOutgoing(String roomKey, String text) {
        RoomNotif room = roomNotifs.get(roomKey);
        if (room == null) {
            room = new RoomNotif(roomKey, hashId(roomKey));
            roomNotifs.put(roomKey, room);
        }
        MsgEntry entry = new MsgEntry(userPubkey != null ? userPubkey : "self", "You",
                /*avatar=*/null, text, System.currentTimeMillis(), /*fromSelf=*/true);
        room.messages.add(entry);
        while (room.messages.size() > MAX_MESSAGES_PER_ROOM) room.messages.remove(0);
        room.lastTimestampMs = Math.max(room.lastTimestampMs, entry.tsMs);
        repostRoom(room, false);
        return entry;
    }

    /** Re-post a room's notification ({@code alert} false ⇒ silent refresh). */
    private void repostRoom(RoomNotif room, boolean alert) {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(room.notifId, buildRoomNotification(room, alert));
    }

    /**
     * Replying implies the user read the room: enqueue the same durable marker
     * a "Mark read" tap would, WITHOUT cancelling the notification (the thread
     * stays up, now showing their reply).
     */
    private void markRepliedRead(String roomKey) {
        RoomNotif room = roomNotifs.get(roomKey);
        long tsMs = room != null && room.lastTimestampMs > 0
                ? room.lastTimestampMs : System.currentTimeMillis();
        ArmadaNotificationPlugin.enqueueReadMarker(this, roomKey, tsMs / 1000L);
    }

    /**
     * Resolve a reply: on success the optimistic line already reads right; on
     * failure rewrite it in place and re-alert, so the user knows to open the
     * app and send again.
     */
    private void finishReply(String roomKey, MsgEntry sent, boolean ok) {
        if (ok || sent == null) return;
        sent.text = "⚠️ Not sent: " + sent.text;
        RoomNotif room = roomNotifs.get(roomKey);
        if (room != null && room.messages.contains(sent)) repostRoom(room, true);
    }

    /** NIP-29: a plain kind 9 with the group's `h` tag, sent to its host relay. */
    private void sendNip29Reply(NativeSigner signer, String roomKey, String text, MsgEntry sent) {
        String rest = roomKey.substring(2);
        int i = rest.lastIndexOf('|');
        if (i <= 0) {
            finishReply(roomKey, sent, false);
            return;
        }
        final String relayUrl = rest.substring(0, i);
        final String groupId = rest.substring(i + 1);
        JSONArray tags = new JSONArray().put(new JSONArray().put("h").put(groupId));
        signer.signEvent(9, text, tags, System.currentTimeMillis() / 1000, ev ->
                handler.post(() -> {
                    if (ev == null) {
                        finishReply(roomKey, sent, false);
                        return;
                    }
                    publishEvent(ev, java.util.Collections.singletonList(relayUrl), ok -> {
                        if (ok) {
                            // The same write path a received kind 9 takes, so
                            // the message is in the group's tenant on next open.
                            notifiedIds.add(ev.optString("id"));
                            ServiceStore.ingest(this, ev, relayUrl);
                        }
                        finishReply(roomKey, sent, ok);
                    });
                }));
    }

    private static long parseEpoch(String epoch) {
        try {
            return Long.parseLong(epoch);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * Concord (CORD-02): rumor (kind 9, channel/epoch/ms binding tags,
     * mirroring useChannel2's send) → seal (kind 20013, the rumor NIP-44'd
     * under the STREAM conversation key, signed by the user through the shared
     * signer) → wrap (kind 1059, random ephemeral `p`, real timestamp, signed
     * by the stream key — NIP-59 reversed, CORD-01). Both encrypt layers ride
     * the stream conversation key the config already ships; the wrap's
     * signature needs the stream SECRET, which is resolved from the group-key
     * memo in the shared store. Replies target the newest epoch held for the
     * channel. While the community's CORD-08 timer is set (shipped as the
     * sub's `timerSecs`), the rumor commits its NIP-40 deadline and the wrap
     * repeats it, exactly like a WebView send — kind 9 is never an exempt
     * kind, so the reply disappears like any other message.
     */
    private void sendConcordReply(NativeSigner signer, String roomKey, String text, MsgEntry sent) {
        final C2Stream target = c2ReplyStream(roomKey.substring(3));
        final byte[] streamSk = target != null ? streamSecretFor(target.pk) : null;
        if (target == null || streamSk == null) {
            finishReply(roomKey, sent, false);
            return;
        }
        final long nowMs = System.currentTimeMillis();
        final long createdAt = nowMs / 1000;
        final long expiresAt =
                target.stream.timerSecs > 0 ? createdAt + target.stream.timerSecs : 0;
        JSONArray rumorTags = new JSONArray()
                .put(new JSONArray().put("channel").put(target.stream.channelId))
                .put(new JSONArray().put("epoch").put(target.stream.epoch))
                .put(new JSONArray().put("ms").put(String.valueOf(nowMs % 1000)));
        if (expiresAt > 0) {
            rumorTags.put(new JSONArray().put("expiration").put(String.valueOf(expiresAt)));
        }
        final JSONObject rumor = new JSONObject();
        try {
            rumor.put("id", NostrCrypto.eventId(userPubkey, createdAt, 9, rumorTags, text));
            rumor.put("pubkey", userPubkey);
            rumor.put("created_at", createdAt);
            rumor.put("kind", 9);
            rumor.put("tags", rumorTags);
            rumor.put("content", text);
        } catch (JSONException e) {
            finishReply(roomKey, sent, false);
            return;
        }
        String sealContent = ConcordCrypto.encrypt(target.stream.convKey, rumor.toString());
        if (sealContent == null) {
            finishReply(roomKey, sent, false);
            return;
        }
        // The seal is what the author signs; its created_at matches the
        // rumor's (stream.ts sealRumor), and it carries no tags.
        signer.signEvent(20013, sealContent, new JSONArray(), createdAt, seal ->
                handler.post(() -> {
                    JSONObject built = null;
                    if (seal != null) {
                        String wrapContent =
                                ConcordCrypto.encrypt(target.stream.convKey, seal.toString());
                        if (wrapContent != null) {
                            try {
                                JSONArray wrapTags = new JSONArray().put(new JSONArray()
                                        .put("p").put(NostrCrypto.pubkeyOf(randomSecretKey())));
                                // CORD-08 §2: the wrap repeats the rumor's own
                                // deadline so relays purge the ciphertext too.
                                if (expiresAt > 0) {
                                    wrapTags.put(new JSONArray()
                                            .put("expiration").put(String.valueOf(expiresAt)));
                                }
                                built = NostrCrypto.finalizeEvent(
                                        1059, wrapContent, wrapTags,
                                        System.currentTimeMillis() / 1000, streamSk);
                            } catch (Exception ignored) {
                                // Falls through to the failure resolve below.
                            }
                        }
                    }
                    if (built == null) {
                        finishReply(roomKey, sent, false);
                        return;
                    }
                    final JSONObject wrap = built;
                    publishEvent(wrap, target.relays, ok -> {
                        if (ok) {
                            notifiedIds.add(wrap.optString("id"));
                            // The same write path a received wrap's rumor takes
                            // (kind + seal-form rules enforced there), so the
                            // reply is in the channel on next open.
                            ServiceStore.storeConcordRumor(
                                    this, target.stream.communityId, 20013, rumor);
                        }
                        finishReply(roomKey, sent, ok);
                    });
                }));
    }

    /** A Concord reply's destination: the newest-epoch stream, its address,
     * and the relays that host it. */
    private static final class C2Stream {
        final String pk;
        final ConcordStream stream;
        final List<String> relays;

        C2Stream(String pk, ConcordStream stream, List<String> relays) {
            this.pk = pk;
            this.stream = stream;
            this.relays = relays;
        }
    }

    /**
     * The V2 send target for a channel: the newest epoch the config holds a
     * stream for (a room can be notified on an old epoch's stream after a
     * rekey, but members read the current one). Null when no epoch binding or
     * no relay hosts the stream — no Reply action then.
     */
    private C2Stream c2ReplyStream(String channelId) {
        if (channelId.isEmpty()) return null;
        String bestPk = null;
        ConcordStream best = null;
        for (Map.Entry<String, ConcordStream> e : pkToStream2.entrySet()) {
            ConcordStream cand = e.getValue();
            if (!cand.channelId.equals(channelId) || cand.epoch.isEmpty()) continue;
            if (best == null || parseEpoch(cand.epoch) > parseEpoch(best.epoch)) {
                best = cand;
                bestPk = e.getKey();
            }
        }
        if (best == null) return null;
        List<String> relays = new ArrayList<>();
        for (Map.Entry<String, Set<String>> e : relayToPks2.entrySet()) {
            if (e.getValue().contains(bestPk)) relays.add(e.getKey());
        }
        return relays.isEmpty() ? null : new C2Stream(bestPk, best, relays);
    }

    /**
     * The stream SECRET for a stream address, from the group-key memo the
     * WebView persists in the shared ArmadaDB (KV `c2gkmemo`, see
     * groupKeyPersist.ts) — the derived keys are already at rest in this same
     * database, so reading them here grants the service nothing the device
     * didn't hold, and no key crosses the plugin bridge. Verified sk → pk so a
     * corrupted or foreign row can never sign as the wrong stream.
     */
    private byte[] streamSecretFor(String pk) {
        byte[] sk = ConcordCrypto.hexToBytes(ServiceStore.streamSecret(this, pk));
        if (sk == null || sk.length != 32) return null;
        try {
            return pk.equals(NostrCrypto.pubkeyOf(sk)) ? sk : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * NIP-17: rumor (kind 14) → seal (kind 13, nip44 to the recipient, signed
     * by the user, backdated) → wrap (kind 1059, single-use key, backdated) —
     * mirroring nip17/protocol.ts. Two envelopes: the peer's copy to their
     * published kind-10050 inbox (sends are GATED on one existing, like the
     * WebView's), and the self copy to the user's own DM relays. Success is
     * the peer's copy landing; the self copy and the store write ride along.
     */
    private void sendDmReply(NativeSigner signer, String peer, String text, String roomKey, MsgEntry sent) {
        if (peer.length() != 64 || userPubkey == null) {
            finishReply(roomKey, sent, false);
            return;
        }
        resolveDmInbox(peer, inboxRelays -> {
            if (inboxRelays.isEmpty()) {
                finishReply(roomKey, sent, false);
                return;
            }
            long nowSecs = System.currentTimeMillis() / 1000;
            // Disappearing messages: while the conversation's timer is set
            // (the newest kind-1740 in the stored thread), the rumor commits
            // its NIP-40 deadline; the seal and both wraps repeat it below —
            // all three levels, matching nip17/protocol.ts.
            long timerSecs = ServiceStore.dm17TimerSecs(this, userPubkey, peer);
            final long expiresAt = timerSecs > 0 ? nowSecs + timerSecs : 0;
            JSONArray rumorTags = new JSONArray().put(new JSONArray().put("p").put(peer));
            if (expiresAt > 0) {
                rumorTags.put(new JSONArray().put("expiration").put(String.valueOf(expiresAt)));
            }
            final JSONObject rumor = new JSONObject();
            try {
                rumor.put("id", NostrCrypto.eventId(userPubkey, nowSecs, 14, rumorTags, text));
                rumor.put("pubkey", userPubkey);
                rumor.put("created_at", nowSecs);
                rumor.put("kind", 14);
                rumor.put("tags", rumorTags);
                rumor.put("content", text);
            } catch (JSONException e) {
                finishReply(roomKey, sent, false);
                return;
            }
            final String rumorJson = rumor.toString();
            buildDmEnvelope(signer, rumorJson, peer, expiresAt, peerWrap -> {
                if (peerWrap == null) {
                    finishReply(roomKey, sent, false);
                    return;
                }
                publishEvent(peerWrap, inboxRelays, ok -> {
                    if (ok) {
                        // The thread shows the reply on next open, exactly as
                        // if the WebView had sent it.
                        ServiceStore.storeDm17Rumor(this, userPubkey, rumor);
                    }
                    finishReply(roomKey, sent, ok);
                });
                // The self copy, sealed + wrapped to ourselves, to our own DM
                // relays. Best-effort: the peer copy above decides success, and
                // the store write above is what our own thread reads anyway.
                buildDmEnvelope(signer, rumorJson, userPubkey, expiresAt, selfWrap -> {
                    if (selfWrap != null && !dmRelays.isEmpty()) {
                        publishEvent(selfWrap, new ArrayList<>(dmRelays), selfOk -> { });
                    }
                });
            });
        });
    }

    private interface EnvelopeCallback {
        void onWrap(JSONObject wrap);
    }

    /**
     * Seal + wrap a DM rumor to one recipient (both outer layers backdated).
     * A non-zero {@code expiresAt} is repeated on the seal and the wrap — the
     * outer tag is the only expiry a relay can act on, and the seal's copy is
     * what a reader trusts without the wrap (nip17/protocol.ts).
     */
    private void buildDmEnvelope(NativeSigner signer, String rumorJson, String recipient,
                                 long expiresAt, EnvelopeCallback cb) {
        signer.encrypt44(recipient, rumorJson, (sealContent, unavailable) -> {
            if (sealContent == null) {
                handler.post(() -> cb.onWrap(null));
                return;
            }
            JSONArray sealTags = new JSONArray();
            if (expiresAt > 0) {
                sealTags.put(new JSONArray().put("expiration").put(String.valueOf(expiresAt)));
            }
            signer.signEvent(13, sealContent, sealTags, tweakedPast(), seal ->
                    handler.post(() -> {
                        JSONObject wrap = null;
                        if (seal != null) {
                            try {
                                byte[] wrapSk = randomSecretKey();
                                byte[] convKey = NostrCrypto.conversationKey(wrapSk, recipient);
                                String ct = convKey != null
                                        ? ConcordCrypto.encrypt(convKey, seal.toString()) : null;
                                if (ct != null) {
                                    JSONArray tags = new JSONArray()
                                            .put(new JSONArray().put("p").put(recipient));
                                    if (expiresAt > 0) {
                                        tags.put(new JSONArray()
                                                .put("expiration").put(String.valueOf(expiresAt)));
                                    }
                                    wrap = NostrCrypto.finalizeEvent(
                                            1059, ct, tags, tweakedPast(), wrapSk);
                                }
                            } catch (Exception ignored) {
                                // Resolves null below.
                            }
                        }
                        cb.onWrap(wrap);
                    }));
        });
    }

    /** NIP-59: a random timestamp within the past two days. */
    private static long tweakedPast() {
        return System.currentTimeMillis() / 1000
                - (long) (Math.random() * MAX_WRAP_BACKDATE_SECS);
    }

    /** A fresh valid secp256k1 secret key (rejection-sampled, like generateSecretKey). */
    private static byte[] randomSecretKey() {
        java.security.SecureRandom random = new java.security.SecureRandom();
        while (true) {
            byte[] sk = new byte[32];
            random.nextBytes(sk);
            try {
                NostrCrypto.pubkeyOf(sk);
                return sk;
            } catch (Exception ignored) {
                // Out-of-range scalar (probability ~2⁻¹²⁸) — draw again.
            }
        }
    }

    /**
     * Publish an event to a set of relays: the live connection (or its outbox)
     * for relays the service already holds, a one-shot socket for foreign ones
     * (a DM peer's inbox). Resolves true on the FIRST accepting OK, false when
     * every relay refused or {@link #PUBLISH_TIMEOUT_MS} passes first.
     */
    private void publishEvent(JSONObject event, List<String> relayUrls, PublishCallback cb) {
        final String eventId = event.optString("id", "");
        final List<String> targets = new ArrayList<>(new LinkedHashSet<>(relayUrls));
        if (targets.isEmpty() || eventId.isEmpty()) {
            cb.done(false);
            return;
        }
        final boolean[] resolved = { false };
        final int[] pending = { targets.size() };
        PublishCallback tally = ok -> {
            if (resolved[0]) return;
            if (ok) {
                resolved[0] = true;
                cb.done(true);
            } else if (--pending[0] == 0) {
                resolved[0] = true;
                cb.done(false);
            }
        };
        for (String url : targets) {
            RelayConnection held = null;
            for (RelayConnection rc : connections) {
                if (rc.relayUrl.equals(url)) {
                    held = rc;
                    break;
                }
            }
            if (held != null && !held.closed) {
                held.publish(event, tally);
            } else {
                publishOneShot(url, event, tally);
            }
        }
        handler.postDelayed(() -> {
            if (resolved[0]) return;
            resolved[0] = true;
            for (RelayConnection rc : connections) {
                rc.pendingPublishes.remove(eventId);
                rc.outbox.removeIf(p -> p.eventId.equals(eventId));
            }
            cb.done(false);
        }, PUBLISH_TIMEOUT_MS);
    }

    /**
     * Publish over a socket opened just for this event — for a relay the
     * service holds no connection to (a DM peer's inbox relay). Sends the
     * frame on open, resolves on the matching OK, closes either way. No AUTH
     * handling: an auth-walled foreign relay counts as a refusal, and the
     * publish succeeds through any other target that accepts.
     */
    private void publishOneShot(String url, JSONObject event, PublishCallback cb) {
        final String eventId = event.optString("id", "");
        final boolean[] done = { false };
        try {
            Request req = new Request.Builder().url(url).build();
            final WebSocket ws = httpClient.newWebSocket(req, new WebSocketListener() {
                @Override
                public void onOpen(WebSocket socket, Response response) {
                    try {
                        socket.send(new JSONArray().put("EVENT").put(event).toString());
                    } catch (Exception ignored) {
                        // The failure callback fires when the socket dies.
                    }
                }

                @Override
                public void onMessage(WebSocket socket, String text) {
                    try {
                        JSONArray m = new JSONArray(text);
                        if (!"OK".equals(m.optString(0)) || !eventId.equals(m.optString(1))) return;
                        final boolean ok = m.optBoolean(2, false);
                        handler.post(() -> {
                            if (!done[0]) {
                                done[0] = true;
                                cb.done(ok);
                            }
                        });
                        socket.close(1000, "done");
                    } catch (Exception ignored) {
                        // Non-JSON frame — keep waiting for the OK.
                    }
                }

                @Override
                public void onFailure(WebSocket socket, Throwable t, Response response) {
                    handler.post(() -> {
                        if (!done[0]) {
                            done[0] = true;
                            cb.done(false);
                        }
                    });
                }
            });
            handler.postDelayed(() -> {
                if (!done[0]) {
                    done[0] = true;
                    try {
                        ws.close(1000, "timeout");
                    } catch (Exception ignored) {
                    }
                    cb.done(false);
                }
            }, PUBLISH_TIMEOUT_MS - 2_000);
        } catch (Exception e) {
            if (!done[0]) {
                done[0] = true;
                cb.done(false);
            }
        }
    }

    /**
     * Cancel any notification left in the retired per-community summary id
     * band by an older build (which posted InboxStyle group summaries there);
     * without this an upgrade would leave orphaned summaries in the tray with
     * nothing to ever cancel them. API 23+; best-effort.
     */
    private void cancelStaleSummaries() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        try {
            for (android.service.notification.StatusBarNotification sbn : manager.getActiveNotifications()) {
                int id = sbn.getId();
                if (id >= SUMMARY_ID_BASE && id < SUMMARY_ID_BASE + SUMMARY_ID_MODULUS) {
                    manager.cancel(id);
                }
            }
        } catch (Exception ignored) {
            // getActiveNotifications can throw on some OEM builds — best-effort.
        }
    }

    /**
     * Fetch a community's conversation icon and deliver it circle-cropped on the main
     * handler (best-effort: null on any failure). Plain https URLs are fetched
     * directly; an encrypted-blob pointer ({@code imgKey}/{@code imgNonce}) is
     * AES-256-GCM decrypted and the plaintext SHA-256 verified against
     * {@code imgHash} before decode. Reuses the avatar disk cache, keyed by the
     * ref's stable {@link CommunityRef#imageCacheKey()}.
     */
    private void fetchCommunityImage(CommunityRef ref, BitmapCallback cb) {
        if (!ref.hasImage()) {
            cb.onBitmap(null);
            return;
        }
        final String cacheKey = ref.imageCacheKey();
        if (!groupImageInFlight.add(cacheKey)) {
            // Already being fetched — the in-flight call's callback will
            // refresh the shortcut and re-post the notification.
            cb.onBitmap(null);
            return;
        }
        avatarClient.dispatcher().executorService().execute(() -> {
            Bitmap disk = loadAvatarFromDisk(cacheKey);
            if (disk != null) {
                handler.post(() -> {
                    groupImageInFlight.remove(cacheKey);
                    cb.onBitmap(disk);
                });
                return;
            }
            Request request = new Request.Builder().url(ref.imageUrl).build();
            avatarClient.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "community icon fetch failed: " + e.getMessage());
                    handler.post(() -> {
                        groupImageInFlight.remove(cacheKey);
                        cb.onBitmap(null);
                    });
                }

                @Override
                public void onResponse(Call call, Response response) {
                    Bitmap circle = null;
                    try {
                        if (response.isSuccessful() && response.body() != null) {
                            byte[] bytes = response.body().bytes();
                            if (ref.imgKey != null && ref.imgNonce != null) {
                                bytes = decryptGcm(bytes, ref.imgKey, ref.imgNonce, ref.imgHash);
                            }
                            Bitmap raw = decodeSampled(bytes);
                            circle = circleCrop(raw);
                        }
                    } catch (Exception e) {
                        if (BuildConfig.DEBUG) Log.d(TAG, "community icon decode failed: " + e.getMessage());
                    } finally {
                        response.close();
                    }
                    final Bitmap result = circle;
                    if (result != null) saveAvatarToDisk(cacheKey, result);
                    handler.post(() -> {
                        groupImageInFlight.remove(cacheKey);
                        cb.onBitmap(result);
                    });
                }
            });
        });
    }

    /**
     * AES-256-GCM decrypt an encrypted community-image blob and verify its
     * plaintext SHA-256 (128-bit tag, matching the encrypt side in
     * concord/lib/image.ts). Returns
     * null on any crypto failure or a hash mismatch (a swapped blob fails
     * closed), so the icon simply doesn't render rather than showing a forgery.
     */
    private static byte[] decryptGcm(byte[] ciphertext, byte[] key, byte[] nonce, String expectHashHex) {
        if (ciphertext == null || key == null || nonce == null) return null;
        try {
            javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                    javax.crypto.Cipher.DECRYPT_MODE,
                    new javax.crypto.spec.SecretKeySpec(key, "AES"),
                    new javax.crypto.spec.GCMParameterSpec(128, nonce));
            byte[] plaintext = cipher.doFinal(ciphertext);
            if (expectHashHex != null && !expectHashHex.isEmpty()) {
                byte[] h = MessageDigest.getInstance("SHA-256").digest(plaintext);
                if (!NostrCrypto.bytesToHex(h).equalsIgnoreCase(expectHashHex)) return null;
            }
            return plaintext;
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.d(TAG, "community icon decrypt failed: " + e.getMessage());
            return null;
        }
    }

    /**
     * Deep-link intent into {@link MainActivity} for an in-app path (null ⇒ "/").
     * ACTION_VIEW is REQUIRED: Capacitor's @capacitor/app plugin only surfaces
     * the launch URL (getLaunchUrl / appUrlOpen) for an intent whose action is
     * ACTION_VIEW. Without it the data URI is present but ignored, so a
     * notification tap delivers the intent yet the web layer never navigates.
     */
    private Intent deepLinkIntent(String url) {
        Intent intent = new Intent(this, MainActivity.class);
        String path = url != null ? url : "/";
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("armada://open" + path));
        intent.putExtra("armada_path", path);
        return intent;
    }

    /** Deep-link tap intent for a room, keyed by the room's stable notif id. */
    private PendingIntent roomPendingIntent(RoomNotif room) {
        Intent intent = deepLinkIntent(room.url);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                this, room.notifId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Publish/refresh the long-lived conversation shortcut a room notification
     * references via {@code setShortcutId}. On Android 11+ a MessagingStyle
     * notification whose shortcutId resolves to a long-lived conversation
     * shortcut is promoted into the conversation space, where the SYSTEM draws
     * the shortcut's icon as the left icon in place of the app icon (the app's
     * small icon becomes a corner badge) — the Signal look. The icon is the
     * sender's avatar for a DM, or the community image for a channel (like a
     * Signal group chat's group avatar). Best-effort: a failed push (rate
     * limit, OEM quirks) just means the notification renders the ordinary way.
     */
    private void pushConversationShortcut(RoomNotif room, Person sender, Bitmap avatar) {
        try {
            String label = conversationTitle(room);
            // The shortcut id is the conversation's stable in-app ROUTE, not
            // the roomKey: it doubles as the Direct Share target id
            // (EXTRA_SHORTCUT_ID on an incoming share), and a route is the one
            // spelling the web layer can navigate without service state.
            // Must match ShareTargetPlugin.publishShortcuts, the other writer
            // of these shortcuts.
            String id = shortcutIdFor(room);
            ShortcutInfoCompat.Builder sb = new ShortcutInfoCompat.Builder(this, id)
                    .setShortLabel(label)
                    .setPerson(sender)
                    .setLongLived(true)
                    // The base route, not room.url: a launcher/share tap should
                    // open the room, not scroll to whatever message last
                    // notified.
                    .setIntent(deepLinkIntent(conversationRoute(room.url)))
                    .setCategories(new java.util.HashSet<>(java.util.Arrays.asList(
                            ShareTargetPlugin.CATEGORY_CONVERSATION,
                            ShareTargetPlugin.CATEGORY_SHARE_TARGET)));
            // The shortcut icon is what the conversation layout paints on the
            // left; without it (avatar not fetched yet) the app icon shows until
            // the silent avatar re-post refreshes the shortcut.
            if (avatar != null) sb.setIcon(IconCompat.createWithBitmap(avatar));
            ShortcutManagerCompat.pushDynamicShortcut(this, sb.build());
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.w(TAG, "pushConversationShortcut failed", e);
        }
    }

    /**
     * The conversation shortcut id for a room: its stable in-app route when
     * one can be derived from the room's deep link, the roomKey otherwise
     * (never expected, but a shortcut beats no shortcut).
     */
    private static String shortcutIdFor(RoomNotif room) {
        String route = conversationRoute(room.url);
        return route != null && !route.isEmpty() && !route.equals("/") ? route : room.roomKey;
    }

    /**
     * Strip a deep-link url down to its stable conversation route: room.url
     * points at the LATEST message (it may carry /t/<root> and /m/<id> focus
     * segments, see appendFocusSegment), but a shortcut identifies and opens
     * the CONVERSATION. Keeps the fixed segment count of each route shape —
     * /dm/<peer> and /c1/<id> are 2 segments, /c/<community>/<channel> and
     * /s/<relay>/<group> are 3 — rather than scanning for "/t/", which a
     * 1-char route param could fake.
     */
    private static String conversationRoute(String url) {
        if (url == null || url.isEmpty() || url.equals("/")) return url;
        String[] seg = url.split("/"); // leading "/" makes seg[0] empty
        if (seg.length < 2) return url;
        int keep;
        switch (seg[1]) {
            case "c":
            case "s":
                keep = 3;
                break;
            case "dm":
            case "c1":
                keep = 2;
                break;
            default:
                return url;
        }
        keep = Math.min(keep, seg.length - 1);
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i <= keep; i++) sb.append('/').append(seg[i]);
        return sb.toString();
    }

    private interface BitmapCallback {
        void onBitmap(Bitmap bitmap);
    }

    /**
     * Fetch an avatar URL, downscale + circle-crop it to {@link #AVATAR_PX}, and
     * deliver the bitmap on the main handler. Best-effort: null on any failure.
     * Results are cached by URL for the service lifetime.
     */
    private void fetchAvatar(String url, BitmapCallback cb) {
        // Disk read + decode off the main thread (the dispatcher is shared with
        // httpClient; a quick task here is fine). A warm disk hit skips both the
        // network AND the decode, so the "same user messages again" case resolves
        // instantly — the whole point of persisting across restarts.
        avatarClient.dispatcher().executorService().execute(() -> {
            Bitmap disk = loadAvatarFromDisk(url);
            if (disk != null) {
                handler.post(() -> {
                    avatarCache.put(url, disk);
                    cb.onBitmap(disk);
                });
                return;
            }
            Request request = new Request.Builder().url(url).build();
            avatarClient.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "avatar fetch failed: " + e.getMessage());
                    handler.post(() -> cb.onBitmap(null));
                }

                @Override
                public void onResponse(Call call, Response response) {
                    Bitmap circle = null;
                    try {
                        if (response.isSuccessful() && response.body() != null) {
                            byte[] bytes = response.body().bytes();
                            Bitmap raw = decodeSampled(bytes);
                            circle = circleCrop(raw);
                        }
                    } catch (Exception e) {
                        if (BuildConfig.DEBUG) Log.d(TAG, "avatar decode failed: " + e.getMessage());
                    } finally {
                        response.close();
                    }
                    final Bitmap result = circle;
                    if (result != null) saveAvatarToDisk(url, result); // persist (bg thread)
                    handler.post(() -> {
                        if (result != null) avatarCache.put(url, result);
                        cb.onBitmap(result);
                    });
                }
            });
        });
    }

    /**
     * Decode image bytes downsampled to roughly {@link #AVATAR_PX}. A two-pass
     * decode (bounds first) keeps a large source image from OOM-ing the decode —
     * a silent OOM previously returned null and dropped the avatar.
     */
    private static Bitmap decodeSampled(byte[] bytes) {
        if (bytes == null || bytes.length == 0) return null;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
        int sample = 1;
        int halfW = opts.outWidth / 2;
        int halfH = opts.outHeight / 2;
        while (halfW / sample >= AVATAR_PX && halfH / sample >= AVATAR_PX) {
            sample *= 2;
        }
        opts.inSampleSize = sample;
        opts.inJustDecodeBounds = false;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
    }

    /** The on-disk file for an avatar URL (SHA-256 of the URL, PNG). */
    private File avatarFile(String url) {
        return new File(avatarDir, sha256Hex(url) + ".png");
    }

    /** Load a previously-decoded avatar from disk (and LRU-touch it), or null. */
    private Bitmap loadAvatarFromDisk(String url) {
        try {
            File f = avatarFile(url);
            if (!f.exists()) return null;
            Bitmap bmp = BitmapFactory.decodeFile(f.getAbsolutePath());
            if (bmp != null) f.setLastModified(System.currentTimeMillis());
            return bmp;
        } catch (Exception e) {
            return null;
        }
    }

    /** Persist a decoded, circle-cropped avatar; prune the dir if oversized. */
    private void saveAvatarToDisk(String url, Bitmap bmp) {
        try {
            if (!avatarDir.exists() && !avatarDir.mkdirs()) return;
            try (FileOutputStream fos = new FileOutputStream(avatarFile(url))) {
                bmp.compress(Bitmap.CompressFormat.PNG, 100, fos);
            }
            pruneAvatarDir();
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.d(TAG, "avatar disk save failed: " + e.getMessage());
        }
    }

    /** Keep the avatar dir under {@link #AVATAR_DISK_MAX}, evicting oldest. */
    private void pruneAvatarDir() {
        File[] files = avatarDir.listFiles();
        if (files == null || files.length <= AVATAR_DISK_MAX) return;
        Arrays.sort(files, (a, c) -> Long.compare(a.lastModified(), c.lastModified()));
        for (int i = 0; i < files.length - AVATAR_DISK_MAX; i++) {
            files[i].delete();
        }
    }

    private static String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    /** Center-crop a bitmap to a square, scale to AVATAR_PX, and mask to a circle. */
    private static Bitmap circleCrop(Bitmap src) {
        if (src == null) return null;
        int size = Math.min(src.getWidth(), src.getHeight());
        if (size <= 0) return null;
        int left = (src.getWidth() - size) / 2;
        int top = (src.getHeight() - size) / 2;

        Bitmap output = Bitmap.createBitmap(AVATAR_PX, AVATAR_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(output);
        Paint paint = new Paint();
        paint.setAntiAlias(true);
        float r = AVATAR_PX / 2f;
        canvas.drawCircle(r, r, r, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        Rect srcRect = new Rect(left, top, left + size, top + size);
        RectF dstRect = new RectF(0, 0, AVATAR_PX, AVATAR_PX);
        canvas.drawBitmap(src, srcRect, dstRect, paint);
        return output;
    }

    private Notification buildForegroundNotification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, SVC_CHANNEL_ID)
                .setContentTitle("Armada")
                .setContentText("Connected for instant notifications")
                .setSmallIcon(R.drawable.ic_stat_armada)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setSilent(true)
                .build();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager m = getSystemService(NotificationManager.class);
        if (m == null) return;

        NotificationChannel svc = new NotificationChannel(
                SVC_CHANNEL_ID, "Background connection", NotificationManager.IMPORTANCE_LOW);
        svc.setDescription("Keeps Armada connected for instant notifications");
        svc.setShowBadge(false);
        m.createNotificationChannel(svc);

        // Retire the old message channel so the stronger vibration + HIGH
        // importance below apply on upgrades (channel settings can't be edited
        // in place — only a fresh channel id picks up the new config).
        try {
            m.deleteNotificationChannel(MSG_CHANNEL_ID_LEGACY);
        } catch (Exception ignored) {
            // Channel may not exist (fresh install) — nothing to retire.
        }

        NotificationChannel msg = new NotificationChannel(
                MSG_CHANNEL_ID, "Notifications", NotificationManager.IMPORTANCE_HIGH);
        msg.setDescription("Mentions, replies, reactions and direct messages");
        msg.enableVibration(true);
        msg.setVibrationPattern(MSG_VIBRATION_PATTERN);
        m.createNotificationChannel(msg);
    }

    // ── Network monitoring ────────────────────────────────────────────────────

    private void registerNetworkCallback() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        NetworkRequest req = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handler.post(() -> {
                    for (RelayConnection rc : connections) rc.resetAndConnectNow();
                });
            }
        };
        try { cm.registerNetworkCallback(req, networkCallback); } catch (Exception ignored) {}
    }

    private void unregisterNetworkCallback() {
        if (networkCallback == null) return;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            try { cm.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) {}
        }
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        Network n = cm.getActiveNetwork();
        if (n == null) return false;
        NetworkCapabilities c = cm.getNetworkCapabilities(n);
        return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    // ── Config change listener ──────────────────────────────────────────────

    private void registerConfigListener() {
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        configListener = (sharedPreferences, key) -> handler.post(this::loadConfigAndReconnect);
        sp.registerOnSharedPreferenceChangeListener(configListener);
    }

    private void unregisterConfigListener() {
        if (configListener == null) return;
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        sp.unregisterOnSharedPreferenceChangeListener(configListener);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void closeAllConnections() {
        for (RelayConnection rc : connections) rc.close();
        connections.clear();
    }

    private static List<String> parseStringArray(String json) {
        List<String> out = new ArrayList<>();
        if (json == null) return out;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) out.add(arr.getString(i));
        } catch (JSONException ignored) {}
        return out;
    }

    private static Set<String> pTags(JSONObject event) {
        Set<String> out = new HashSet<>();
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return out;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag != null && "p".equals(tag.optString(0)) && tag.length() > 1) {
                out.add(tag.optString(1));
            }
        }
        return out;
    }

    /**
     * Whether the user is genuinely @-mentioned in this event. A kind-1111
     * NIP-22 comment carries structural `p` tags for the thread root author
     * and immediate parent author — these are thread pointers, NOT mentions,
     * so a reply in the user's own thread would otherwise always look like a
     * mention. We strip the uppercase `P` (root author) and the lowercase `p`
     * tags that duplicate the `e`/`E` parent author pubkeys before checking.
     */
    private boolean isMentioned(JSONObject event, String userPubkey) {
        if (userPubkey == null) return false;
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return false;

        // For kind-1111 comments, collect the structural pubkeys to exclude.
        Set<String> structural = null;
        if (event.optInt("kind", -1) == 1111) {
            structural = new HashSet<>();
            for (int i = 0; i < tags.length(); i++) {
                JSONArray tag = tags.optJSONArray(i);
                if (tag == null || tag.length() < 2) continue;
                String name = tag.optString(0);
                // Uppercase P = thread root author (structural).
                if ("P".equals(name)) structural.add(tag.optString(1));
                // Lowercase e/E parent pointer: 4th element is the author pubkey.
                if ("e".equals(name) || "E".equals(name)) {
                    if (tag.length() > 3) structural.add(tag.optString(3));
                }
            }
        }

        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag == null || tag.length() < 2) continue;
            if (!"p".equals(tag.optString(0))) continue;
            String pk = tag.optString(1);
            if (!userPubkey.equals(pk)) continue;
            if (structural != null && structural.contains(pk)) continue;
            return true;
        }
        return false;
    }

    private static String tagValue(JSONObject event, String name) {
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return null;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag != null && name.equals(tag.optString(0)) && tag.length() > 1) {
                return tag.optString(1);
            }
        }
        return null;
    }

    /**
     * For a decrypted Concord inner, return the thread-root id when
     * the inner is a NIP-22 kind-1111 comment (uppercase `E` tag), else null.
     * Used to deep-link a thread-reply notification to its thread panel.
     */
    private static String innerKindCommentRoot(JSONObject inner) {
        if (inner == null) return null;
        if (inner.optInt("kind", -1) != 1111) return null;
        return tagValue(inner, "E");
    }

    /**
     * Append {@code /t/<rootId>} to a deep-link url when {@code rootId} is
     * non-empty, so the WebView opens the thread panel on tap. No-op (returns
     * the url unchanged) when there's no thread root (a top-level message, an
     * opaque/undecryptable event, or a malformed inner) or no room to hang it
     * on — a focus segment is only meaningful under a room.
     *
     * <p>Must be applied BEFORE {@link #appendMessageSegment}: the route is
     * {@code …/t/<root>/m/<id>}, and the two markers are what tell a reply
     * inside a thread from a message in the timeline.
     */
    private static String appendThreadSegment(String url, String rootId) {
        return appendFocusSegment(url, "t", rootId);
    }

    /**
     * Append {@code /m/<eventId>} — the message the notification is about — to
     * a deep-link url, so a tap lands ON that message: the web client's
     * useMessagePermalink scrolls to it and marks it. No-op when there's no id
     * to point at.
     */
    private static String appendMessageSegment(String url, String eventId) {
        return appendFocusSegment(url, "m", eventId);
    }

    /**
     * Mirror of the web client's route builder (`src/lib/routes.ts`) for the
     * `/t/` + `/m/` suffix. The client also still accepts the pre-path
     * `?thread=`/`?m=` query form, which is what an already-posted tray
     * notification carries — this only governs newly built links.
     */
    private static String appendFocusSegment(String url, String marker, String value) {
        if (url == null) return null;
        if (value == null || value.isEmpty()) return url;
        if (url.isEmpty() || url.equals("/")) return url;
        return url + "/" + marker + "/" + uriEncode(value);
    }

    private static String truncate(String s) {
        if (s == null) return "";
        s = s.trim();
        return s.length() <= CONTENT_CAP ? s : s.substring(0, CONTENT_CAP) + "…";
    }

    /**
     * Mirror of the web client's relayToRouteParam (platform.ts): drop a wss://
     * scheme, keep ws: as a marker, then URL-encode for the /s/:server segment.
     */
    private static String relayToRouteParam(String relayUrl) {
        String s = relayUrl;
        if (s.regionMatches(true, 0, "wss://", 0, 6)) {
            s = s.substring(6);
        } else if (s.regionMatches(true, 0, "ws://", 0, 5)) {
            s = "ws:" + s.substring(5);
        }
        return uriEncode(s);
    }

    private static String uriEncode(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return s;
        }
    }

    /**
     * Stable, collision-resistant notification id for a key (a room key or event
     * id). Hashes the WHOLE string (not a prefix) so distinct rooms sharing a
     * common prefix — e.g. two groups on the same relay ("h:wss://r|a" vs
     * "h:wss://r|b") — never collapse into one notification. Kept below the
     * retired summary-id band.
     */
    private static int hashId(String id) {
        if (id == null) return 2;
        return (Math.abs(stringHash(id)) % ROOM_ID_MODULUS) + 2;
    }

    /** 31x string hash over the WHOLE string (String.hashCode semantics, spelled out for stability). */
    private static int stringHash(String s) {
        int hash = 0;
        for (int i = 0; i < s.length(); i++) {
            hash = ((hash << 5) - hash) + s.charAt(i);
        }
        return hash;
    }
}
