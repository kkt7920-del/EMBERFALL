package com.pokeworld.mining

import com.pokeworld.core.GameDefinition

enum class OreTier {
    BASIC,
    COMMON,
    ADVANCED,
    RARE,
    ANCIENT,
    LEGENDARY
}

data class OreDefinition(

    override val id: String,

    val tier: OreTier,

    val minDepth: Int,

    val maxDepth: Int,

    val rarity: Double,

    val requiredMiningLevel: Int,

    val drops: List<String>

) : GameDefinition {

    init {
        require(maxDepth >= minDepth) { "Ore $id: maxDepth < minDepth" }
        require(rarity in 0.0..1.0) { "Ore $id: rarity must be within 0..1" }
    }
}
