package com.pokeworld.core

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PokeWorldConfigLoaderTest {

    private val dir: Path = createTempDirectory("pokeworld-config")

    private val file: Path = dir.resolve("pokeworld").resolve("server.json")

    @AfterTest
    fun cleanup() {
        dir.toFile().deleteRecursively()
    }

    @Test
    fun `writes defaults when missing and reads them back`() {
        val first = PokeWorldConfigLoader(file).load()

        assertTrue(first.createdDefault)
        assertTrue(Files.exists(file))
        assertEquals(PokeWorldConfig(), first.config)

        val second = PokeWorldConfigLoader(file).load()

        assertFalse(second.createdDefault)
        assertEquals(PokeWorldConfig(), second.config)
        assertTrue(second.warnings.isEmpty())
    }

    @Test
    fun `partial file keeps defaults for missing keys and ignores unknown ones`() {
        Files.createDirectories(file.parent)
        Files.writeString(
            file,
            """{ "battle": { "majorGimmicksPerPlayerPerBattle": 2 }, "pokemonHunger": true }"""
        )

        val result = PokeWorldConfigLoader(file).load()

        assertEquals(2, result.config.battle.majorGimmicksPerPlayerPerBattle)
        assertEquals(GameFeatures(), result.config.features)
    }

    @Test
    fun `negative gimmick limit falls back to the standard rule`() {
        Files.createDirectories(file.parent)
        Files.writeString(file, """{ "battle": { "majorGimmicksPerPlayerPerBattle": -3 } }""")

        val result = PokeWorldConfigLoader(file).load()

        assertEquals(1, result.config.battle.majorGimmicksPerPlayerPerBattle)
        assertEquals(1, result.warnings.size)
    }

    @Test
    fun `broken file is left untouched and defaults are used`() {
        Files.createDirectories(file.parent)
        Files.writeString(file, "{ not json")

        val result = PokeWorldConfigLoader(file).load()

        assertEquals(PokeWorldConfig(), result.config)
        assertEquals(1, result.warnings.size)
        assertEquals("{ not json", Files.readString(file))
    }

    @Test
    fun `wrong value type is reported, not thrown`() {
        Files.createDirectories(file.parent)
        Files.writeString(file, """{ "features": { "gyms": "yes please" } }""")

        val result = PokeWorldConfigLoader(file).load()

        assertEquals(PokeWorldConfig(), result.config)
        assertEquals(1, result.warnings.size)
    }

    @Test
    fun `feature switches drive the gimmick policy`() {
        val config = PokeWorldConfig(
            features = GameFeatures(zMoves = false, dynamax = false),
            battle = BattleRules(majorGimmicksPerPlayerPerBattle = 2)
        )

        val policy = config.gimmickPolicy()

        assertEquals(2, policy.majorGimmicksPerPlayerPerBattle)
        assertEquals(
            setOf(
                com.pokeworld.battle.BattleGimmick.MEGA,
                com.pokeworld.battle.BattleGimmick.GIGANTAMAX,
                com.pokeworld.battle.BattleGimmick.TERASTAL
            ),
            policy.enabled
        )
    }
}
