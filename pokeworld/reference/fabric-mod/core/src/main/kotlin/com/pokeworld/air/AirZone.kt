package com.pokeworld.air

import com.pokeworld.core.GameDefinition

/**
 * The sky as its own world, in progression order from the ground up:
 * low altitude -> cloud layer -> high altitude -> storm layer -> sky ruin ->
 * sky island. Zone gating and flight are Phase 8.
 */
enum class AirZone {
    LOW_ALTITUDE,
    CLOUD_LAYER,
    HIGH_ALTITUDE,
    STORM_LAYER,
    SKY_RUIN,
    SKY_ISLAND
}

data class AirZoneDefinition(

    override val id: String,

    val type: AirZone,

    val minimumAltitude: Int,

    val maximumAltitude: Int,

    val spawnTag: String

) : GameDefinition {

    init {
        require(maximumAltitude >= minimumAltitude) {
            "Air zone $id: maximumAltitude < minimumAltitude"
        }
    }
}
