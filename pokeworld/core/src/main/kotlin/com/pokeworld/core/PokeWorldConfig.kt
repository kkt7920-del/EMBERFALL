package com.pokeworld.core

import com.pokeworld.battle.BattleGimmick
import com.pokeworld.battle.GimmickPolicy
import kotlinx.serialization.Serializable

/**
 * Server feature switches. PokeWorld has no Pokemon hunger, farming, jobs,
 * production, labor, fatigue or bathing, so there are no switches for them.
 */
@Serializable
data class GameFeatures(

    val exploration: Boolean = true,

    val pokemonMounts: Boolean = true,

    val vehicles: Boolean = true,

    val oceanExploration: Boolean = true,

    val airExploration: Boolean = true,

    val mining: Boolean = true,

    val crafting: Boolean = true,

    val ruins: Boolean = true,

    val legendaryEvents: Boolean = true,

    val trainerBattles: Boolean = true,

    val gyms: Boolean = true,

    val raids: Boolean = true,

    val megaEvolution: Boolean = true,

    val zMoves: Boolean = true,

    val dynamax: Boolean = true,

    val gigantamax: Boolean = true,

    val terastal: Boolean = true
) {

    fun enabledGimmicks(): Set<BattleGimmick> =
        buildSet {
            if (megaEvolution) add(BattleGimmick.MEGA)
            if (zMoves) add(BattleGimmick.Z_MOVE)
            if (dynamax) add(BattleGimmick.DYNAMAX)
            if (gigantamax) add(BattleGimmick.GIGANTAMAX)
            if (terastal) add(BattleGimmick.TERASTAL)
        }
}

@Serializable
data class BattleRules(

    /** Standard rule is one major gimmick per player per battle; 0 disables them. */
    val majorGimmicksPerPlayerPerBattle: Int = 1
)

@Serializable
data class IntegrationSettings(

    /** Use Mega Showdown for battle gimmicks when it is installed. */
    val megaShowdown: Boolean = true
)

@Serializable
data class PokeWorldConfig(

    val configVersion: Int = CURRENT_VERSION,

    val features: GameFeatures = GameFeatures(),

    val battle: BattleRules = BattleRules(),

    val integrations: IntegrationSettings = IntegrationSettings()
) {

    fun gimmickPolicy(): GimmickPolicy =
        GimmickPolicy(
            majorGimmicksPerPlayerPerBattle = battle.majorGimmicksPerPlayerPerBattle,
            enabled = features.enabledGimmicks()
        )

    /** Returns a config that is safe to run with, plus a message for each fix applied. */
    fun sanitized(): Pair<PokeWorldConfig, List<String>> {
        val warnings = mutableListOf<String>()
        var battle = battle

        if (battle.majorGimmicksPerPlayerPerBattle < 0) {
            warnings += "battle.majorGimmicksPerPlayerPerBattle was " +
                "${battle.majorGimmicksPerPlayerPerBattle}; using 1"
            battle = battle.copy(majorGimmicksPerPlayerPerBattle = 1)
        }

        return copy(battle = battle) to warnings
    }

    companion object {
        const val CURRENT_VERSION = 1
    }
}
