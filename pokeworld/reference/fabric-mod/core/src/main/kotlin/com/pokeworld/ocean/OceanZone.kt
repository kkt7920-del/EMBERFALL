package com.pokeworld.ocean

import com.pokeworld.core.GameDefinition

/**
 * Ocean layers in progression order: beach -> coast -> shallow water ->
 * open ocean -> deep ocean -> abyss -> undersea canyon -> underwater cave ->
 * shipwreck -> ancient underwater ruin. Zone gating and travel are Phase 6.
 */
enum class OceanZone {
    BEACH,
    COAST,
    SHALLOW_WATER,
    OPEN_OCEAN,
    DEEP_OCEAN,
    ABYSS,
    UNDERSEA_CANYON,
    UNDERWATER_CAVE,
    SHIPWRECK,
    UNDERWATER_RUIN
}

data class OceanZoneDefinition(

    override val id: String,

    val zone: OceanZone,

    val minDepth: Int,

    val maxDepth: Int,

    val pokemonSpawnTag: String,

    val structureChance: Double

) : GameDefinition {

    init {
        require(maxDepth >= minDepth) { "Ocean zone $id: maxDepth < minDepth" }
        require(structureChance in 0.0..1.0) {
            "Ocean zone $id: structureChance must be within 0..1"
        }
    }
}
