package com.pokeworld.core

/**
 * Anything loaded into a [GameRegistry]. Ids use Minecraft resource-location
 * syntax (`namespace:path`) so datapack content can be addressed directly.
 */
interface GameDefinition {
    val id: String
}

object GameIds {

    private val pattern =
        Regex("^[a-z0-9_.-]+:[a-z0-9_./-]+$")

    fun isValid(id: String): Boolean =
        pattern.matches(id)

    fun requireValid(id: String): String {
        require(isValid(id)) {
            "Invalid id '$id': expected namespace:path using [a-z0-9_.-/]"
        }
        return id
    }
}
