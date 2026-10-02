package com.pokeworld.core

/**
 * Per-player progression. Owned by the server; clients only ever receive
 * copies. Versioned persistence and migration arrive in Phase 15.
 */
data class PlayerProgress(

    val completedQuests: MutableSet<String> =
        mutableSetOf(),

    val discoveredRegions: MutableSet<String> =
        mutableSetOf(),

    val inventory: MutableMap<String, Int> =
        mutableMapOf(),

    val completedLegendaryEvents: MutableSet<String> =
        mutableSetOf(),

    val badges: MutableSet<String> =
        mutableSetOf()
) {

    fun hasItem(itemId: String): Boolean =
        (inventory[itemId] ?: 0) > 0
}
