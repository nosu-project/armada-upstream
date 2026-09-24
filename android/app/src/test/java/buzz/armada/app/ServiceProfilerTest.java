package buzz.armada.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class ServiceProfilerTest {
    @Test
    public void frameFamilyNamesTheVerbAndTheSubscriptionPrefix() {
        assertEquals("EVENT as", ServiceProfiler.frameFamily("[\"EVENT\",\"as-18c2f\",{\"kind\":3}]"));
        assertEquals("EOSE a7", ServiceProfiler.frameFamily("[\"EOSE\",\"a7-99\"]"));
        assertEquals("CLOSED a2", ServiceProfiler.frameFamily("[\"CLOSED\",\"a2-1\",\"auth-required: x\"]"));
    }

    @Test
    public void frameFamilyKeepsUnscopedVerbsWhole() {
        assertEquals("AUTH", ServiceProfiler.frameFamily("[\"AUTH\",\"challenge\"]"));
        assertEquals("OK", ServiceProfiler.frameFamily("[\"OK\",\"abcd\",true,\"\"]"));
        assertEquals("NOTICE", ServiceProfiler.frameFamily("[\"NOTICE\",\"hi\"]"));
    }

    @Test
    public void frameFamilyDegradesOnGarbage() {
        assertEquals("?", ServiceProfiler.frameFamily("not json"));
        assertEquals("EVENT", ServiceProfiler.frameFamily("[\"EVENT\""));
    }

    @Test
    public void hostDropsSchemePathAndQuery() {
        assertEquals("relay.example.com", ServiceProfiler.host("wss://relay.example.com/nostr?token=x"));
        assertEquals("relay.example.com:444", ServiceProfiler.host("wss://relay.example.com:444"));
    }

    @Test
    public void everyRecorderIsANoOpInANormalBuild() {
        // BuildConfig.PROFILE is false in the unit-test build; none of these may
        // touch an android.os stub (which throws on the plain JVM).
        ServiceProfiler.count("x");
        ServiceProfiler.units("x", 3);
        ServiceProfiler.end("x", ServiceProfiler.begin("x"));
        ServiceProfiler.elapsed("x", 0);
        ServiceProfiler.peak("x", 5);
    }
}
