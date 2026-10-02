package com.pokeworld.pokemon

import com.pokeworld.core.Vec3

/**
 * The only way PokeWorld touches Pokemon. Cobblemon owns species, stats, moves,
 * abilities, evolution, capture, party, PC, battle, entities and the Pokedex;
 * PokeWorld never keeps a second Pokemon model. The Cobblemon-backed
 * implementation lands in Phase 3.
 */
interface PokemonAdapter {

    fun speciesExists(speciesId: String): Boolean

    /** @return the spawned entity's UUID as a string */
    fun spawnPokemon(
        speciesId: String,
        level: Int,
        position: Vec3
    ): String

    fun startWildBattle(
        playerId: String,
        pokemonEntityId: String
    )

    fun startTrainerBattle(
        playerId: String,
        trainerId: String
    )

    fun givePokemon(
        playerId: String,
        speciesId: String,
        level: Int
    )

    fun healParty(playerId: String)
}
