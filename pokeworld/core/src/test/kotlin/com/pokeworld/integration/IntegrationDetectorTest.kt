package com.pokeworld.integration

import com.pokeworld.core.IntegrationSettings
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class IntegrationDetectorTest {

    private class FakeEnvironment(
        private val mods: Map<String, String>
    ) : ModEnvironment {
        override fun isModLoaded(modId: String) = modId in mods
        override fun modVersion(modId: String) = mods[modId]
        override val configDir: Path = Path.of("config")
        override val isDedicatedServer = true
    }

    private fun detect(mods: Map<String, String>, megaShowdown: Boolean = true) =
        IntegrationDetector.detect(FakeEnvironment(mods), IntegrationSettings(megaShowdown))

    @Test
    fun `cobblemon missing, old, unparseable and current`() {
        assertEquals(IntegrationState.MISSING, detect(emptyMap()).cobblemon.state)
        assertEquals(IntegrationState.INCOMPATIBLE, detect(mapOf("cobblemon" to "1.7.3+1.21.1")).cobblemon.state)
        assertEquals(IntegrationState.INCOMPATIBLE, detect(mapOf("cobblemon" to "nightly")).cobblemon.state)
        assertEquals(IntegrationState.ACTIVE, detect(mapOf("cobblemon" to "1.8.1+1.21.1")).cobblemon.state)
        assertEquals(IntegrationState.ACTIVE, detect(mapOf("cobblemon" to "1.9.0")).cobblemon.state)
    }

    @Test
    fun `mega showdown is optional`() {
        val cobblemon = "cobblemon" to "1.8.1+1.21.1"

        val absent = detect(mapOf(cobblemon)).megaShowdown
        assertEquals(IntegrationState.MISSING, absent.state)
        assertNull(absent.version)

        assertTrue(detect(mapOf(cobblemon, "mega_showdown" to "1.4.0")).megaShowdown.isActive)

        assertEquals(
            IntegrationState.DISABLED,
            detect(mapOf(cobblemon, "mega_showdown" to "1.4.0"), megaShowdown = false).megaShowdown.state
        )

        assertEquals(
            IntegrationState.INCOMPATIBLE,
            detect(mapOf("mega_showdown" to "1.4.0")).megaShowdown.state
        )
    }

    @Test
    fun `version ordering`() {
        fun v(raw: String) = ModVersion.parse(raw)!!

        assertTrue(v("1.8.1") > v("1.8.0"))
        assertTrue(v("1.10.0") > v("1.9.9"))
        assertEquals(0, v("1.8.1+1.21.1").compareTo(v("1.8.1")))
        assertEquals(0, v("1.8").compareTo(v("1.8.0")))
        assertTrue(v("1.8.1-beta.2") < v("1.8.1"))
        assertNull(ModVersion.parse(""))
        assertNull(ModVersion.parse("1.x"))
    }
}
