package com.pokeworld.biome

import com.pokeworld.core.ExplorationLayer
import com.pokeworld.core.GameDefinition

data class BiomeDefinition(

    override val id: String,

    val displayName: String,

    val regionId: String,

    val layers: Set<ExplorationLayer>,

    val spawnTags: Set<String>,

    val minAltitude: Int = -64,

    val maxAltitude: Int = 512

) : GameDefinition {

    init {
        require(maxAltitude >= minAltitude) {
            "Biome $id: maxAltitude < minAltitude"
        }
    }
}
