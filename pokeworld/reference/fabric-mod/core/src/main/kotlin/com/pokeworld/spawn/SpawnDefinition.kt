package com.pokeworld.spawn

import com.pokeworld.core.ExplorationLayer
import com.pokeworld.core.GameDefinition
import com.pokeworld.core.TimePeriod
import com.pokeworld.core.WeatherType
import kotlin.random.Random

data class LevelRange(

    val min: Int,

    val max: Int
) {

    init {
        require(min > 0) { "Level min must be > 0, was $min" }
        require(max >= min) { "Level max ($max) < min ($min)" }
    }

    fun random(random: Random = Random.Default): Int =
        random.nextInt(min, max + 1)
}

enum class SpawnRarity {
    COMMON,
    UNCOMMON,
    RARE,
    VERY_RARE,
    EPIC,
    LEGENDARY
}

/**
 * One spawn entry. Species are never hardcoded in Kotlin: these are loaded from
 * datapack JSON (Phase 3), and [speciesId] is resolved through Cobblemon.
 */
data class SpawnDefinition(

    override val id: String,

    val speciesId: String,

    val biomeTags: Set<String>,

    val layers: Set<ExplorationLayer>,

    val times: Set<TimePeriod>,

    val weather: Set<WeatherType>,

    val level: LevelRange,

    val rarity: SpawnRarity,

    val weight: Double,

    val minAltitude: Int? = null,

    val maxAltitude: Int? = null,

    val requiresQuest: String? = null

) : GameDefinition {

    init {
        require(weight > 0.0 && weight.isFinite()) {
            "Spawn $id: weight must be a positive finite number, was $weight"
        }
        if (minAltitude != null && maxAltitude != null) {
            require(maxAltitude >= minAltitude) {
                "Spawn $id: maxAltitude < minAltitude"
            }
        }
    }
}

data class SpawnContext(

    val biomeTags: Set<String>,

    val layer: ExplorationLayer,

    val time: TimePeriod,

    val weather: WeatherType,

    val altitude: Int,

    val completedQuests: Set<String>
)
