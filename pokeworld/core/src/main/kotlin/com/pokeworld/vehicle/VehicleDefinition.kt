package com.pokeworld.vehicle

import com.pokeworld.core.ExplorationLayer
import com.pokeworld.core.GameDefinition

enum class VehicleType {
    BOAT,
    SPEED_BOAT,
    SUBMARINE,
    GLIDER,
    AIRPLANE,
    SEAPLANE
}

data class VehicleDefinition(

    override val id: String,

    val type: VehicleType,

    val maxSpeed: Double,

    val durability: Double,

    val allowedLayers: Set<ExplorationLayer>,

    val recipeId: String

) : GameDefinition
