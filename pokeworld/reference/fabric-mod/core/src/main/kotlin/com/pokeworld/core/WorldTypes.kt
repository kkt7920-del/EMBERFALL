package com.pokeworld.core

data class Vec3(
    val x: Double,
    val y: Double,
    val z: Double
)

enum class TimePeriod {
    DAWN,
    DAY,
    DUSK,
    NIGHT
}

enum class WeatherType {
    CLEAR,
    RAIN,
    THUNDER,
    SNOW,
    SANDSTORM,
    FOG
}

/**
 * The five world traversal layers. Every travel system (mounts, vehicles,
 * ocean, air, underground) is expressed in terms of these.
 */
enum class ExplorationLayer {
    LAND,
    WATER_SURFACE,
    UNDERWATER,
    UNDERGROUND,
    AIR
}
