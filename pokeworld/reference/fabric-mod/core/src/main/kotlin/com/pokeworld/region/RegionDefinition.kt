package com.pokeworld.region

import com.pokeworld.core.GameDefinition

enum class RegionClimate {
    TEMPERATE,
    TROPICAL,
    DESERT,
    SNOW,
    VOLCANIC,
    MOUNTAIN,
    COASTAL,
    OCEAN,
    ANCIENT,
    URBAN
}

data class RegionDefinition(

    override val id: String,

    val displayName: String,

    val climates: Set<RegionClimate>,

    val biomeTags: Set<String>,

    val minRecommendedLevel: Int,

    val maxRecommendedLevel: Int,

    val legendaryEventIds: List<String> = emptyList(),

    val structureIds: List<String> = emptyList()

) : GameDefinition {

    init {
        require(minRecommendedLevel > 0) {
            "Region $id: minRecommendedLevel must be > 0"
        }
        require(maxRecommendedLevel >= minRecommendedLevel) {
            "Region $id: maxRecommendedLevel < minRecommendedLevel"
        }
    }
}
