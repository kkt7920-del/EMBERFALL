package com.pokeworld.spawn

import com.pokeworld.core.GameRegistry
import kotlin.random.Random

class SpawnSystem(

    private val registry: GameRegistry<SpawnDefinition>,

    private val random: Random = Random.Default

) {

    fun available(context: SpawnContext): List<SpawnDefinition> =
        registry
            .all()
            .filter { matches(it, context) }

    fun choose(context: SpawnContext): SpawnDefinition? {
        val pool = available(context)

        if (pool.isEmpty())
            return null

        var roll = random.nextDouble(pool.sumOf { it.weight })

        for (spawn in pool) {
            roll -= spawn.weight

            if (roll < 0.0)
                return spawn
        }

        return pool.last()
    }

    private fun matches(
        spawn: SpawnDefinition,
        context: SpawnContext
    ): Boolean =
        spawn.biomeTags.any(context.biomeTags::contains) &&
            context.layer in spawn.layers &&
            context.time in spawn.times &&
            context.weather in spawn.weather &&
            (spawn.minAltitude == null || context.altitude >= spawn.minAltitude) &&
            (spawn.maxAltitude == null || context.altitude <= spawn.maxAltitude) &&
            (spawn.requiresQuest == null || spawn.requiresQuest in context.completedQuests)
}
