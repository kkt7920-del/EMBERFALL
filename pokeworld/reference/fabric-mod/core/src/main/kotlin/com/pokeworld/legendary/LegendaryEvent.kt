package com.pokeworld.legendary

import com.pokeworld.core.GameDefinition
import com.pokeworld.core.GameRegistry
import com.pokeworld.core.PlayerProgress
import com.pokeworld.core.TimePeriod
import com.pokeworld.core.WeatherType

/**
 * A legendary encounter is the end of a story chain (rumor -> ruin -> tablet ->
 * artifacts -> puzzle -> condition -> guardian), never a random spawn.
 * Definitions are data-driven (Phase 13).
 */
data class LegendaryEventDefinition(

    override val id: String,

    val encounterSpeciesId: String,

    val requiredQuestIds: Set<String>,

    val requiredItemIds: Set<String>,

    val requiredRegionId: String,

    val requiredStructureId: String?,

    val requiredWeather: WeatherType?,

    val requiredTime: TimePeriod?,

    val encounterLevel: Int,

    val allowCapture: Boolean = true

) : GameDefinition {

    init {
        require(encounterLevel > 0) { "Legendary event $id: encounterLevel must be > 0" }
    }
}

data class LegendaryContext(

    val regionId: String,

    val structureId: String?,

    val time: TimePeriod,

    val weather: WeatherType
)

class LegendaryEventSystem(

    private val events: GameRegistry<LegendaryEventDefinition>

) {

    fun canStart(
        eventId: String,
        progress: PlayerProgress,
        context: LegendaryContext
    ): Boolean {
        val event = events[eventId] ?: return false
        return canStart(event, progress, context)
    }

    fun canStart(
        event: LegendaryEventDefinition,
        progress: PlayerProgress,
        context: LegendaryContext
    ): Boolean =
        event.id !in progress.completedLegendaryEvents &&
            progress.completedQuests.containsAll(event.requiredQuestIds) &&
            event.requiredItemIds.all(progress::hasItem) &&
            event.requiredRegionId == context.regionId &&
            (event.requiredStructureId == null || event.requiredStructureId == context.structureId) &&
            (event.requiredWeather == null || event.requiredWeather == context.weather) &&
            (event.requiredTime == null || event.requiredTime == context.time)

    /** Every event the player could start right here, right now. */
    fun startable(
        progress: PlayerProgress,
        context: LegendaryContext
    ): List<LegendaryEventDefinition> =
        events.all().filter { canStart(it, progress, context) }
}
