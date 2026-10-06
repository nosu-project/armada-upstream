package buzz.armada.app

import buzz.armada.app.db.BundledSqlDriver
import buzz.armada.app.db.Rumor
import buzz.armada.app.db.SqliteArmadaDb
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Base64
import java.util.Random

/**
 * What one of the account's own documents costs the service, stage by stage:
 * frame parse, signature check, rumor parse and the store write into `main`.
 *
 * Shaped on the Pixel 8a traces: settings documents of ~40 KB and ~350 KB of
 * NIP-44 base64 ciphertext and 38 KB community-list fragments, each a newer
 * version of a coordinate already on disk, so every write supersedes a row.
 * JVM timings are not ART's; compare runs of this test against each other.
 */
class SelfDocIngestBenchmarkTest {

    private val rng = Random(7)

    private fun ciphertext(bytes: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(bytes * 3 / 4).also(rng::nextBytes))

    private fun doc(sk: ByteArray, kind: Int, d: String, topic: String?, bytes: Int, at: Long): JSONObject {
        val tags = JSONArray().put(JSONArray().put("d").put(d))
        if (topic != null) tags.put(JSONArray().put("t").put(topic))
        return NostrCrypto.finalizeEvent(kind, ciphertext(bytes), tags, at, sk)
    }

    private fun median(ns: LongArray): Double = ns.sorted()[ns.size / 2] / 1e6

    private fun run(label: String, kind: Int, d: String, topic: String?, bytes: Int, search: Boolean) {
        val sk = ByteArray(32).also(rng::nextBytes)
        val file = File.createTempFile("selfdoc", ".db").also { it.delete() }
        val db = SqliteArmadaDb(BundledSqlDriver(file.absolutePath), search = search)
        try {
            val frames = (0 until ROUNDS + WARMUP).map {
                JSONArray().put("EVENT").put("as").put(doc(sk, kind, d, topic, bytes, 1_790_000_000L + it)).toString()
            }
            val stages = Array(4) { LongArray(ROUNDS) }
            for ((i, frame) in frames.withIndex()) {
                val t0 = System.nanoTime()
                val event = JSONArray(frame).getJSONObject(2)
                val t1 = System.nanoTime()
                assertTrue(NostrCrypto.verifyEvent(event))
                val t2 = System.nanoTime()
                val rumor = Rumor.parse(event)!!
                val t3 = System.nanoTime()
                db.event("main", rumor)
                val t4 = System.nanoTime()
                val at = i - WARMUP
                if (at < 0) continue
                stages[0][at] = t1 - t0; stages[1][at] = t2 - t1; stages[2][at] = t3 - t2; stages[3][at] = t4 - t3
            }
            val m = stages.map(::median)
            val kb = (File(file.absolutePath).length() + File(file.absolutePath + "-wal").length()) / 1024.0
            println(String.format("  %-38s %7.2f %7.2f %7.2f %7.2f %8.2f  %6.0f KB",
                label + if (search) "" else " (no FTS)", m[0], m[1], m[2], m[3], m.sum(), kb))
        } finally {
            db.close()
            for (suffix in listOf("", "-wal", "-shm")) File(file.absolutePath + suffix).delete()
        }
    }

    @Test
    fun selfDocumentIngestCostByStage() {
        println("=== one self document through the service, median ms per stage ($ROUNDS rounds) ===")
        println("  document                                 parse  verify   rumor   write    total   db+wal")
        for (search in listOf(true, false)) {
            run("settings 30078, 40 KB", 30078, "armada/settings", null, 40_000, search)
            run("settings 30078, 350 KB", 30078, "armada/settings", null, 350_000, search)
            run("dm-index 30078 topic, 40 KB", 30078, "armada/dm-conversations/x/0", "armada-dm-conversations", 40_000, search)
            run("community list 33302, 38 KB", 33302, "0", null, 38_000, search)
        }
    }

    private companion object {
        const val ROUNDS = 40
        const val WARMUP = 10
    }
}
