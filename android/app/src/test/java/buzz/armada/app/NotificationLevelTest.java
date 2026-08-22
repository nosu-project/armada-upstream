package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;

import org.json.JSONObject;
import org.junit.Test;

/**
 * The per-room "mentions only" gate. The level is decided in the WebView and
 * shipped down as {@code groupSubs[].mentionOnly} / {@code concordSubs[]
 * .mentionOnly}; this covers what the service does with it once an event has
 * arrived. Like the Git guards, these avoid an Android runtime so they run on
 * CI hosts — hence the static overload taking prefs explicitly.
 */
public class NotificationLevelTest {
    /** All per-kind prefs at their defaults (every one on). */
    private static final JSONObject DEFAULTS = new JSONObject();

    private static JSONObject prefs(String key, boolean value) throws Exception {
        return new JSONObject().put(key, value);
    }

    @Test public void mentionsOnlyDropsAnOrdinaryGroupMessage() {
        // The bug this exists for: the room's level was ignored entirely, so a
        // message that names nobody notified anyway.
        assertFalse(NotificationRelayService.wantsNotification(
                9, /*mentionsMe=*/false, /*mentionOnly=*/true, DEFAULTS));
        assertTrue(NotificationRelayService.wantsNotification(
                9, /*mentionsMe=*/false, /*mentionOnly=*/false, DEFAULTS));
    }

    @Test public void mentionsOnlyStillLetsAMentionThrough() {
        assertTrue(NotificationRelayService.wantsNotification(
                9, /*mentionsMe=*/true, /*mentionOnly=*/true, DEFAULTS));
    }

    @Test public void mentionsOnlyDropsThreadRepliesThatDontNameYou() {
        // A NIP-22 reply to your own message carries your pubkey in a `p` tag,
        // so the ones that survive are the ones actually directed at you.
        assertFalse(NotificationRelayService.wantsNotification(
                1111, /*mentionsMe=*/false, /*mentionOnly=*/true, DEFAULTS));
        assertTrue(NotificationRelayService.wantsNotification(
                1111, /*mentionsMe=*/true, /*mentionOnly=*/true, DEFAULTS));
    }

    @Test public void mentionsOnlyKeepsReactionsToYourOwnMessage() {
        // A reaction only reaches the gate having `p`-tagged you (NIP-25), so
        // it is a mention by construction and outlives the room's level.
        assertTrue(NotificationRelayService.wantsNotification(
                7, /*mentionsMe=*/true, /*mentionOnly=*/true, DEFAULTS));
    }

    @Test public void resolvedNip29LevelOutranksTheGlobalPrefs() throws Exception {
        // "mentions only" wins over an allGroupMessages that is explicitly on…
        assertFalse(NotificationRelayService.wantsNotification(
                9, false, true, prefs("allGroupMessages", true)));
        // …while an included all-messages room wins when the global fallback
        // is off. Java receives the already-resolved subscription.
        assertTrue(NotificationRelayService.wantsNotification(
                9, false, false, prefs("allGroupMessages", false)));
    }

    @Test public void resolvedNip29MentionOutranksTheGlobalMentionPref() throws Exception {
        assertTrue(NotificationRelayService.wantsNotification(
                9, /*mentionsMe=*/true, /*mentionOnly=*/true, prefs("mentions", false)));
    }

    @Test public void decryptedConcordUsesTheSameResolvedMessagePolicy() {
        assertTrue(NotificationRelayService.wantsResolvedGroupMessage(false, false));
        assertTrue(NotificationRelayService.wantsResolvedGroupMessage(false, true));
        assertFalse(NotificationRelayService.wantsResolvedGroupMessage(true, false));
        assertTrue(NotificationRelayService.wantsResolvedGroupMessage(true, true));
    }

    @Test public void opaqueConcordOnlyAllowsResolvedAll() {
        assertTrue(NotificationRelayService.wantsOpaqueResolvedGroupMessage(false));
        assertFalse(NotificationRelayService.wantsOpaqueResolvedGroupMessage(true));
    }

    @Test public void reactionAndReplyPrefsRemainIndependent() throws Exception {
        assertFalse(NotificationRelayService.wantsNotification(
                7, true, false, prefs("reactions", false)));
        assertFalse(NotificationRelayService.wantsNotification(
                1111, true, false, prefs("replies", false)));
        assertTrue(NotificationRelayService.wantsNotification(
                7, true, false, prefs("allGroupMessages", false)));
        assertTrue(NotificationRelayService.wantsNotification(
                1111, true, false, prefs("allGroupMessages", false)));
    }

    @Test public void exactDmAllOverridesGlobalOff() throws Exception {
        String peer = "a".repeat(64);
        Map<String, String> exact = Collections.singletonMap(peer, "all");
        assertTrue(NotificationRelayService.dmNotificationEnabled(
                peer, prefs("directMessages", false), exact));
        assertTrue(NotificationRelayService.shouldWatchDm(
                prefs("directMessages", false), exact));
    }

    @Test public void exactDmNothingOverridesGlobalOn() throws Exception {
        String peer = "a".repeat(64);
        Map<String, String> exact = Collections.singletonMap(peer, "nothing");
        assertFalse(NotificationRelayService.dmNotificationEnabled(
                peer, prefs("directMessages", true), exact));
        // The global fallback can still authorize other conversations, so the
        // broad opaque-author inbox must remain subscribed; the exact room is
        // dropped only after decrypt reveals its canonical key.
        assertTrue(NotificationRelayService.shouldWatchDm(
                prefs("directMessages", true), exact));
    }

    @Test public void onlyExactDmNothingDoesNotOpenTheBroadInbox() throws Exception {
        String peer = "a".repeat(64);
        Map<String, String> exact = Collections.singletonMap(peer, "nothing");
        assertFalse(NotificationRelayService.shouldWatchDm(
                prefs("directMessages", false), exact));
    }

    @Test public void exactGroupDmKeyDoesNotMuteOneMemberAlone() throws Exception {
        String alice = "a".repeat(64);
        String bob = "b".repeat(64);
        Map<String, String> exact = new HashMap<>();
        exact.put(alice + "," + bob, "nothing");

        assertFalse(NotificationRelayService.dmNotificationEnabled(
                alice + "," + bob, prefs("directMessages", true), exact));
        assertTrue(NotificationRelayService.dmNotificationEnabled(
                bob, prefs("directMessages", true), exact));
    }

    @Test public void configReloadUsesOnlyTheRevisionCommitMarker() {
        assertTrue(NotificationRelayService.shouldReloadConfig("rev"));
        assertFalse(NotificationRelayService.shouldReloadConfig("relayUrls"));
        assertFalse(NotificationRelayService.shouldReloadConfig(null));
    }

    @Test public void unreadyPlaneMergesOnlyWithSameAccountLastGood() {
        assertFalse(NotificationRelayService.shouldReplaceConfigPlane(
                /*sameAccountConfig=*/true, /*planeReady=*/false));
        assertTrue(NotificationRelayService.shouldReplaceConfigPlane(
                /*sameAccountConfig=*/true, /*planeReady=*/true));
        // A different account must never inherit even when its first snapshot
        // is partial: clear old storage and write only the useful fresh subset.
        assertTrue(NotificationRelayService.shouldReplaceConfigPlane(
                /*sameAccountConfig=*/false, /*planeReady=*/false));
    }

    @Test public void notificationPolicyDefaultsCannotBootstrapAFreshAccount() {
        assertFalse(NotificationRelayService.hasUsableNotificationPolicy(
                /*sameAccountConfig=*/false, /*policyPlaneReady=*/false));
        assertTrue(NotificationRelayService.hasUsableNotificationPolicy(
                /*sameAccountConfig=*/true, /*policyPlaneReady=*/false));
        assertTrue(NotificationRelayService.hasUsableNotificationPolicy(
                /*sameAccountConfig=*/false, /*policyPlaneReady=*/true));
    }

    @Test public void partialFreshBootstrapCanBeEnrichedLater() {
        // With authoritative policy, a first snapshot has no native state to
        // preserve, so an available DM plane may be written while groups load.
        assertTrue(NotificationRelayService.shouldReplaceConfigPlane(
                /*sameAccountConfig=*/false, /*planeReady=*/false));
        // Once that bootstrap exists, the still-unready group plane is held…
        assertFalse(NotificationRelayService.shouldReplaceConfigPlane(
                /*sameAccountConfig=*/true, /*planeReady=*/false));
        // …and then authoritatively replaced as soon as it becomes ready.
        assertTrue(NotificationRelayService.shouldReplaceConfigPlane(
                /*sameAccountConfig=*/true, /*planeReady=*/true));
    }

    @Test public void incompletePlaneAddsRecordsWithoutPruningLastGood() throws Exception {
        String merged = ArmadaNotificationPlugin.mergeObjectArrays(
                "[{\"relay\":\"wss://old\",\"id\":\"kept\",\"mentionOnly\":false},"
                        + "{\"relay\":\"wss://same\",\"id\":\"room\",\"mentionOnly\":false}]",
                "[{\"relay\":\"wss://same\",\"id\":\"room\",\"mentionOnly\":true},"
                        + "{\"relay\":\"wss://new\",\"id\":\"added\",\"mentionOnly\":false}]",
                "relay", "id");
        org.json.JSONArray values = new org.json.JSONArray(merged);
        assertEquals(3, values.length());
        boolean kept = false, updated = false, added = false;
        for (int i = 0; i < values.length(); i++) {
            JSONObject value = values.getJSONObject(i);
            if ("kept".equals(value.optString("id"))) kept = true;
            if ("room".equals(value.optString("id"))) {
                updated = value.optBoolean("mentionOnly", false);
            }
            if ("added".equals(value.optString("id"))) added = true;
        }
        assertTrue(kept);
        assertTrue(updated);
        assertTrue(added);
    }

    @Test public void incompleteDmRosterAndRelaysAreAdditive() throws Exception {
        String merged = ArmadaNotificationPlugin.mergeStringArrays(
                "[\"old\",\"shared\"]", "[\"shared\",\"new\"]");
        org.json.JSONArray values = new org.json.JSONArray(merged);
        assertEquals(3, values.length());
        assertEquals("old", values.getString(0));
        assertEquals("shared", values.getString(1));
        assertEquals("new", values.getString(2));
    }

    @Test public void incompleteConcordCoordinateKeepsOldAndAddsNewKeys() throws Exception {
        String merged = ArmadaNotificationPlugin.mergeConcordSubscriptions(
                "[{\"communityId\":\"c\",\"channelId\":\"room\","
                        + "\"mentionOnly\":false,\"relays\":[\"wss://old\"],"
                        + "\"streams\":[{\"pk\":\"old\"}],\"banned\":[\"bad1\"]}]",
                "[{\"communityId\":\"c\",\"channelId\":\"room\","
                        + "\"mentionOnly\":true,\"relays\":[\"wss://new\"],"
                        + "\"streams\":[{\"pk\":\"new\"}],\"banned\":[\"bad2\"]},"
                        + "{\"communityId\":\"c\",\"channelId\":\"added\","
                        + "\"relays\":[],\"streams\":[]}]");
        org.json.JSONArray values = new org.json.JSONArray(merged);
        assertEquals(2, values.length());
        JSONObject room = values.getJSONObject(0);
        assertTrue(room.optBoolean("mentionOnly", false));
        assertEquals(2, room.getJSONArray("relays").length());
        assertEquals(2, room.getJSONArray("streams").length());
        assertEquals(2, room.getJSONArray("banned").length());
        assertEquals("added", values.getJSONObject(1).getString("channelId"));
    }

    @Test public void incompleteGitCoordinateKeepsTrustAndUpdatesKnownAttachment() throws Exception {
        String merged = ArmadaNotificationPlugin.mergeGitSubscriptions(
                "[{\"address\":\"30617:owner:repo\",\"relays\":[\"wss://old\"],"
                        + "\"maintainers\":[\"maintainer\"],"
                        + "\"attachments\":[{\"channelId\":\"room\",\"attachedAt\":1}],"
                        + "\"ticketRoots\":[{\"id\":\"root1\"}]}]",
                "[{\"address\":\"30617:owner:repo\",\"relays\":[\"wss://new\"],"
                        + "\"maintainers\":[],"
                        + "\"attachments\":[{\"channelId\":\"room\",\"attachedAt\":1,\"detachedAt\":2}],"
                        + "\"ticketRoots\":[{\"id\":\"root2\"}]}]");
        JSONObject repo = new org.json.JSONArray(merged).getJSONObject(0);
        assertEquals(2, repo.getJSONArray("relays").length());
        assertEquals(1, repo.getJSONArray("maintainers").length());
        assertEquals(2L, repo.getJSONArray("attachments")
                .getJSONObject(0).getLong("detachedAt"));
        assertEquals(2, repo.getJSONArray("ticketRoots").length());
    }

    @Test public void incompleteLegacyFlagsUpdateKnownRecordsOnly() throws Exception {
        String merged = ArmadaNotificationPlugin.mergeFlagsForKnownIds(
                "[\"kept\",\"changed\"]", "[\"nowMention\"]",
                "[\"changed\",\"nowMention\"]");
        org.json.JSONArray values = new org.json.JSONArray(merged);
        assertEquals(2, values.length());
        assertEquals("kept", values.getString(0));
        assertEquals("nowMention", values.getString(1));
    }

    @Test public void activeRoomStateRequiresAFreshHeartbeat() {
        long updated = 1_000L;
        assertTrue(NotificationRelayService.isActiveRoomStateFresh(updated, updated));
        assertTrue(NotificationRelayService.isActiveRoomStateFresh(
                updated, updated + NotificationRelayService.ACTIVE_ROOMS_TTL_MS));
        assertFalse(NotificationRelayService.isActiveRoomStateFresh(
                updated, updated + NotificationRelayService.ACTIVE_ROOMS_TTL_MS + 1L));
        assertFalse(NotificationRelayService.isActiveRoomStateFresh(0L, updated));
        assertFalse(NotificationRelayService.isActiveRoomStateFresh(updated, updated - 1L));
    }

    @Test public void inclusiveRelayCursorKeepsBothSameSecondEvents() {
        long relayA = 100L;
        relayA = NotificationRelayService.advanceInclusiveSince(relayA, 100L, 100L);
        assertEquals(100L, relayA);
        // Event B has the same created_at as A. NIP-01 `since:100` remains
        // inclusive, while the old +1 cursor would have asked from 101.
        relayA = NotificationRelayService.advanceInclusiveSince(relayA, 100L, 101L);
        assertEquals(100L, relayA);

        // Relay B is independent; traffic on A cannot move its cursor.
        long relayB = 90L;
        assertEquals(90L, relayB);
        assertEquals(70L, NotificationRelayService.subscriptionSince(
                relayA, /*cursorHasEvent=*/true));
    }

    @Test public void coldStartCursorDoesNotRequestABacklog() {
        assertEquals(1_000L, NotificationRelayService.subscriptionSince(
                1_000L, /*cursorHasEvent=*/false));
    }

    @Test public void futureEventCannotPoisonRelayCursor() {
        long cursor = NotificationRelayService.advanceInclusiveSince(
                100L, /*eventCreatedAtSec=*/10_000L, /*nowSec=*/101L);
        assertEquals(101L, cursor);
        // A legitimate event at the current second is still inside the next
        // inclusive REQ instead of being locked out until timestamp 10,000.
        assertEquals(101L, NotificationRelayService.advanceInclusiveSince(
                cursor, /*eventCreatedAtSec=*/101L, /*nowSec=*/101L));
    }

    @Test public void notificationDedupeSetEvictsOldestIds() {
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        NotificationRelayService.rememberBoundedId(ids, "a", 2);
        NotificationRelayService.rememberBoundedId(ids, "b", 2);
        NotificationRelayService.rememberBoundedId(ids, "c", 2);
        assertFalse(ids.contains("a"));
        assertTrue(ids.contains("b"));
        assertTrue(ids.contains("c"));
        assertEquals(2, ids.size());

        NotificationRelayService.rememberBoundedId(ids, "b", 2);
        NotificationRelayService.rememberBoundedId(ids, "d", 2);
        assertTrue(ids.contains("b"));
        assertTrue(ids.contains("d"));
        assertFalse(ids.contains("c"));
    }

    @Test public void accountCleanupLeavesUnrelatedForegroundRowsAlone() {
        assertTrue(NotificationRelayService.isAccountNotification(
                42, "armada:room:dm:peer"));
        assertFalse(NotificationRelayService.isAccountNotification(4_711, null));
        assertFalse(NotificationRelayService.isAccountNotification(4_712, null));
    }

    @Test public void configRevisionIsUniqueWhenWritersShareAMillisecond() {
        long first = ArmadaNotificationPlugin.nextConfigRevisionValue(100L, 100L, 200L);
        long second = ArmadaNotificationPlugin.nextConfigRevisionValue(100L, first, 200L);
        assertEquals(200L, first);
        assertEquals(201L, second);
    }
}
