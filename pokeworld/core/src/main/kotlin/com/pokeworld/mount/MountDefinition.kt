package com.pokeworld.mount

import com.pokeworld.core.GameDefinition

enum class MountMode {
    LAND,
    SWIM,
    SUBMARINE,
    FLY,
    GLIDE
}

/**
 * Riding stats for one species. Movement itself is delegated to Cobblemon's
 * riding system wherever it exists (Phase 5).
 */
data class MountDefinition(

    override val id: String,

    val speciesId: String,

    val modes: Set<MountMode>,

    val speed: Double,

    val acceleration: Double,

    val handling: Double,

    val jumpHeight: Double = 0.0,

    val swimSpeed: Double = 0.0,

    val diveSpeed: Double = 0.0,

    val maxDiveDepth: Double = 0.0,

    val flightSpeed: Double = 0.0,

    val maxFlightAltitude: Double = 0.0

) : GameDefinition {

    init {
        require(modes.isNotEmpty()) { "Mount $id: no mount modes" }
    }
}
