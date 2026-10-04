package buzz.armada.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class SignerLaunchPacerTest {

    @Test
    public void allowsFourFreshLaunchesPerWindowThenWaitsForTheOldestToAge() {
        SignerLaunchPacer pacer = new SignerLaunchPacer();
        for (int i = 0; i < SignerLaunchPacer.MAX_PER_WINDOW; i++) {
            assertEquals(0, pacer.reserve("sign_event:22242", 1_000 + i * 100));
        }
        // The fifth within the window waits until the first is 30 s old.
        assertEquals(SignerLaunchPacer.WINDOW_MS - 2_000, pacer.reserve("sign_event:22242", 3_000));
        assertEquals(0, pacer.reserve("sign_event:22242", 1_000 + SignerLaunchPacer.WINDOW_MS));
    }

    @Test
    public void bucketsAreIndependent() {
        SignerLaunchPacer pacer = new SignerLaunchPacer();
        for (int i = 0; i < SignerLaunchPacer.MAX_PER_WINDOW; i++) pacer.reserve("sign_event:22242", 0);
        assertEquals(0, pacer.reserve("sign_event:1", 0));
        assertEquals(0, pacer.reserve("nip44_decrypt", 0));
    }

    @Test
    public void keysBySignKindAndTypeOtherwise() {
        assertEquals("sign_event:22242", SignerLaunchPacer.keyOf("sign_event", "{\"kind\":22242,\"content\":\"\"}"));
        assertEquals("sign_event", SignerLaunchPacer.keyOf("sign_event", "not json"));
        assertEquals("nip44_decrypt", SignerLaunchPacer.keyOf("nip44_decrypt", "ciphertext"));
    }
}
