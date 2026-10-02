package com.pokeworld.vehicle

import com.pokeworld.core.GameDefinition

enum class AircraftPartType {
    ENGINE,
    WING,
    BODY,
    PROPELLER,
    LANDING_GEAR,
    FUEL_SYSTEM
}

/**
 * Aircraft progression; materials come from mines and ruins.
 * Wooden glider -> small propeller plane -> light aircraft -> seaplane -> explorer.
 */
enum class AircraftTier {
    WOODEN_GLIDER,
    PROPELLER_PLANE,
    LIGHT_AIRCRAFT,
    SEAPLANE,
    EXPLORER_AIRCRAFT
}

data class AircraftPart(

    override val id: String,

    val category: AircraftPartType,

    val weight: Double,

    val durability: Double,

    val performance: Double

) : GameDefinition
