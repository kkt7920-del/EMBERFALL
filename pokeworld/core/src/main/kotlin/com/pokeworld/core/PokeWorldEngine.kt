package com.pokeworld.core

import com.pokeworld.battle.BattleGimmickAdapter
import com.pokeworld.battle.BattleGimmickManager
import com.pokeworld.legendary.LegendaryEventSystem
import com.pokeworld.pokemon.PokemonAdapter
import com.pokeworld.spawn.SpawnContext
import com.pokeworld.spawn.SpawnSystem
import kotlin.random.Random

/**
 * Server-side gameplay services. Wired up once the Cobblemon adapter exists
 * (Phase 3); Phase 1 only builds config, registries and integrations.
 */
class PokeWorldEngine(

    val config: PokeWorldConfig,

    val registries: PokeWorldRegistries,

    val pokemonAdapter: PokemonAdapter,

    gimmickAdapter: BattleGimmickAdapter,

    private val random: Random = Random.Default

) {

    val spawnSystem = SpawnSystem(registries.spawns, random)

    val legendarySystem = LegendaryEventSystem(registries.legendaryEvents)

    val battleGimmicks = BattleGimmickManager(gimmickAdapter, config.gimmickPolicy())

    fun spawnWildPokemon(
        context: SpawnContext,
        position: Vec3
    ): String? {
        val spawn = spawnSystem.choose(context) ?: return null

        if (!pokemonAdapter.speciesExists(spawn.speciesId))
            return null

        return pokemonAdapter.spawnPokemon(
            spawn.speciesId,
            spawn.level.random(random),
            position
        )
    }
}
