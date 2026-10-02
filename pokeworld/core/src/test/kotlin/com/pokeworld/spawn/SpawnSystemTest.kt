package com.pokeworld.spawn

import com.pokeworld.core.ExplorationLayer
import com.pokeworld.core.GameRegistry
import com.pokeworld.core.TimePeriod
import com.pokeworld.core.WeatherType
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class SpawnSystemTest {

    private fun spawn(
        id: String,
        weight: Double = 1.0,
        tags: Set<String> = setOf("open_ocean"),
        minAltitude: Int? = null,
        quest: String? = null
    ) = SpawnDefinition(
        id = id,
        speciesId = "content_pack:species_0130",
        biomeTags = tags,
        layers = setOf(ExplorationLayer.WATER_SURFACE),
        times = setOf(TimePeriod.DAY, TimePeriod.NIGHT),
        weather = setOf(WeatherType.CLEAR),
        level = LevelRange(25, 48),
        rarity = SpawnRarity.RARE,
        weight = weight,
        minAltitude = minAltitude,
        requiresQuest = quest
    )

    private fun context(
        tags: Set<String> = setOf("open_ocean"),
        altitude: Int = 62,
        quests: Set<String> = emptySet()
    ) = SpawnContext(tags, ExplorationLayer.WATER_SURFACE, TimePeriod.DAY, WeatherType.CLEAR, altitude, quests)

    @Test
    fun `filters by tag, altitude and quest`() {
        val registry = GameRegistry<SpawnDefinition>("spawns")
        registry.register(spawn("pokeworld:a"))
        registry.register(spawn("pokeworld:b", tags = setOf("deep_ocean")))
        registry.register(spawn("pokeworld:c", minAltitude = 100))
        registry.register(spawn("pokeworld:d", quest = "pokeworld:dive_license"))

        val system = SpawnSystem(registry)

        assertEquals(listOf("pokeworld:a"), system.available(context()).map { it.id })
        assertEquals(
            setOf("pokeworld:a", "pokeworld:d"),
            system.available(context(quests = setOf("pokeworld:dive_license"))).map { it.id }.toSet()
        )
    }

    @Test
    fun `choose returns null for an empty pool`() {
        assertNull(SpawnSystem(GameRegistry("spawns")).choose(context()))
    }

    @Test
    fun `choose follows weights`() {
        val registry = GameRegistry<SpawnDefinition>("spawns")
        registry.register(spawn("pokeworld:common", weight = 9.0))
        registry.register(spawn("pokeworld:rare", weight = 1.0))

        val system = SpawnSystem(registry, Random(42))
        val picks = (1..10_000).map { system.choose(context())!!.id }
        val rare = picks.count { it == "pokeworld:rare" }

        assert(rare in 800..1200) { "rare picked $rare times out of 10000" }
    }

    @Test
    fun `invalid definitions are rejected`() {
        assertFailsWith<IllegalArgumentException> { spawn("pokeworld:x", weight = 0.0) }
        assertFailsWith<IllegalArgumentException> { spawn("pokeworld:x", weight = Double.NaN) }
        assertFailsWith<IllegalArgumentException> { LevelRange(10, 5) }
    }
}
