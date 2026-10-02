package com.pokeworld.crafting

import com.pokeworld.core.GameDefinition

data class Ingredient(

    val itemId: String,

    val count: Int
) {

    init {
        require(count > 0) { "Ingredient $itemId: count must be > 0" }
    }
}

data class RecipeDefinition(

    override val id: String,

    val stationId: String,

    val ingredients: List<Ingredient>,

    val resultItemId: String,

    val resultCount: Int,

    val requiredResearchId: String? = null

) : GameDefinition {

    init {
        require(ingredients.isNotEmpty()) { "Recipe $id: no ingredients" }
        require(resultCount > 0) { "Recipe $id: resultCount must be > 0" }
    }
}
