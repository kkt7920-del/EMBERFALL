package com.pokeworld.battle

/**
 * Server-side policy for major battle gimmicks.
 *
 * @property majorGimmicksPerPlayerPerBattle how many gimmick activations each
 *   player gets in one battle. 1 is the standard rule; 0 turns gimmicks off.
 * @property enabled gimmicks allowed by the server's feature switches.
 */
data class GimmickPolicy(

    val majorGimmicksPerPlayerPerBattle: Int = 1,

    val enabled: Set<BattleGimmick> = BattleGimmick.entries.toSet()
) {

    init {
        require(majorGimmicksPerPlayerPerBattle >= 0) {
            "majorGimmicksPerPlayerPerBattle must be >= 0"
        }
    }
}

/**
 * Tracks gimmick use per (battle, player), so concurrent battles on one server
 * never share counters. Call [endBattle] when Cobblemon reports the battle over.
 */
class BattleGimmickManager(

    private val adapter: BattleGimmickAdapter,

    policy: GimmickPolicy = GimmickPolicy()

) {

    private data class UsageKey(
        val battleId: String,
        val playerId: String
    )

    private val usage =
        HashMap<UsageKey, Int>()

    /** Replaced in place when the server config is reloaded. */
    @Volatile
    var policy: GimmickPolicy = policy

    @Synchronized
    fun canUse(
        battleId: String,
        playerId: String,
        pokemonId: String,
        gimmick: BattleGimmick
    ): Boolean {
        val current = policy

        if (gimmick !in current.enabled)
            return false

        if (!adapter.available(gimmick))
            return false

        val used = usage[UsageKey(battleId, playerId)] ?: 0

        if (used >= current.majorGimmicksPerPlayerPerBattle)
            return false

        return adapter.canActivate(battleId, playerId, pokemonId, gimmick)
    }

    @Synchronized
    fun activate(
        battleId: String,
        playerId: String,
        pokemonId: String,
        gimmick: BattleGimmick
    ): Boolean {
        if (!canUse(battleId, playerId, pokemonId, gimmick))
            return false

        if (!adapter.activate(battleId, playerId, pokemonId, gimmick))
            return false

        usage.merge(UsageKey(battleId, playerId), 1, Int::plus)

        return true
    }

    @Synchronized
    fun usedBy(battleId: String, playerId: String): Int =
        usage[UsageKey(battleId, playerId)] ?: 0

    @Synchronized
    fun endBattle(battleId: String) {
        usage.keys.removeIf { it.battleId == battleId }
    }

    @Synchronized
    fun clear() {
        usage.clear()
    }
}
