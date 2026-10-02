package com.pokeworld.structure

import com.pokeworld.core.GameDefinition

enum class StructureType {
    CITY,
    TOWN,
    GYM,
    POKEMON_CENTER,
    SHOP,
    LAB,
    RUIN,
    TEMPLE,
    DUNGEON,
    CAVE,
    MINE,
    TOWER,
    CASTLE,
    UNDERWATER_RUIN,
    SKY_RUIN
}

data class StructureDefinition(

    override val id: String,

    val type: StructureType,

    val regionId: String,

    val minDistanceFromSameType: Int,

    val generationWeight: Double,

    val biomeTags: Set<String>

) : GameDefinition {

    init {
        require(minDistanceFromSameType >= 0) {
            "Structure $id: minDistanceFromSameType must be >= 0"
        }
        require(generationWeight > 0.0) {
            "Structure $id: generationWeight must be > 0"
        }
    }
}
