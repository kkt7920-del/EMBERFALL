package com.pokeworld.legendary

import com.pokeworld.core.GameRegistry
import com.pokeworld.core.PlayerProgress
import com.pokeworld.core.TimePeriod
import com.pokeworld.core.WeatherType
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LegendaryEventSystemTest {

    private val event = LegendaryEventDefinition(
        id = "pokeworld:storm_guardian",
        encounterSpeciesId = "content_pack:species_legendary",
        requiredQuestIds = setOf("pokeworld:sky_tablet"),
        requiredItemIds = setOf("pokeworld:storm_orb"),
        requiredRegionId = "pokeworld:highlands",
        requiredStructureId = "pokeworld:sky_temple",
        requiredWeather = WeatherType.THUNDER,
        requiredTime = TimePeriod.NIGHT,
        encounterLevel = 70
    )

    private val system = LegendaryEventSystem(
        GameRegistry<LegendaryEventDefinition>("legendary_events").apply { register(event) }
    )

    private val here = LegendaryContext("pokeworld:highlands", "pokeworld:sky_temple", TimePeriod.NIGHT, WeatherType.THUNDER)

    private fun ready() = PlayerProgress(
        completedQuests = mutableSetOf("pokeworld:sky_tablet"),
        inventory = mutableMapOf("pokeworld:storm_orb" to 1)
    )

    @Test
    fun `starts only when every condition holds`() {
        assertTrue(system.canStart(event.id, ready(), here))

        assertFalse(system.canStart(event.id, PlayerProgress(), here))
        assertFalse(system.canStart(event.id, ready().apply { inventory["pokeworld:storm_orb"] = 0 }, here))
        assertFalse(system.canStart(event.id, ready(), here.copy(weather = WeatherType.CLEAR)))
        assertFalse(system.canStart(event.id, ready(), here.copy(structureId = null)))
        assertFalse(system.canStart("pokeworld:unknown", ready(), here))
    }

    @Test
    fun `completed events never repeat`() {
        val progress = ready().apply { completedLegendaryEvents += event.id }

        assertFalse(system.canStart(event.id, progress, here))
        assertTrue(system.startable(progress, here).isEmpty())
    }
}
