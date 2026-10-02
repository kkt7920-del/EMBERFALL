package com.pokeworld.battle

enum class BattleGimmick {
    MEGA,
    Z_MOVE,
    DYNAMAX,
    GIGANTAMAX,
    TERASTAL
}

/**
 * Bridge to whichever mod actually performs a gimmick. Mega Showdown backs this
 * in Phase 14 through its public API only; without it, [UnavailableGimmickAdapter]
 * is used and PokeWorld runs normally with gimmicks switched off.
 */
interface BattleGimmickAdapter {

    fun available(gimmick: BattleGimmick): Boolean

    fun canActivate(
        battleId: String,
        playerId: String,
        pokemonId: String,
        gimmick: BattleGimmick
    ): Boolean

    fun activate(
        battleId: String,
        playerId: String,
        pokemonId: String,
        gimmick: BattleGimmick
    ): Boolean
}

object UnavailableGimmickAdapter : BattleGimmickAdapter {

    override fun available(gimmick: BattleGimmick): Boolean = false

    override fun canActivate(
        battleId: String,
        playerId: String,
        pokemonId: String,
        gimmick: BattleGimmick
    ): Boolean = false

    override fun activate(
        battleId: String,
        playerId: String,
        pokemonId: String,
        gimmick: BattleGimmick
    ): Boolean = false
}
