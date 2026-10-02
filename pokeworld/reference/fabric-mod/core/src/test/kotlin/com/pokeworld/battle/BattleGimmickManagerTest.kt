package com.pokeworld.battle

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BattleGimmickManagerTest {

    private class AlwaysAdapter : BattleGimmickAdapter {
        var activations = 0

        override fun available(gimmick: BattleGimmick) = true

        override fun canActivate(battleId: String, playerId: String, pokemonId: String, gimmick: BattleGimmick) = true

        override fun activate(battleId: String, playerId: String, pokemonId: String, gimmick: BattleGimmick): Boolean {
            activations++
            return true
        }
    }

    @Test
    fun `standard rule allows one gimmick per player per battle`() {
        val manager = BattleGimmickManager(AlwaysAdapter())

        assertTrue(manager.activate("b1", "p1", "mon1", BattleGimmick.MEGA))
        assertFalse(manager.activate("b1", "p1", "mon2", BattleGimmick.TERASTAL))

        // other player, same battle
        assertTrue(manager.activate("b1", "p2", "mon3", BattleGimmick.DYNAMAX))

        // same player, a different battle running concurrently
        assertTrue(manager.activate("b2", "p1", "mon1", BattleGimmick.Z_MOVE))
    }

    @Test
    fun `ending a battle resets only that battle`() {
        val manager = BattleGimmickManager(AlwaysAdapter())
        manager.activate("b1", "p1", "mon1", BattleGimmick.MEGA)
        manager.activate("b2", "p1", "mon1", BattleGimmick.MEGA)

        manager.endBattle("b1")

        assertEquals(0, manager.usedBy("b1", "p1"))
        assertEquals(1, manager.usedBy("b2", "p1"))
    }

    @Test
    fun `server config can change the limit`() {
        val manager = BattleGimmickManager(AlwaysAdapter(), GimmickPolicy(majorGimmicksPerPlayerPerBattle = 2))

        assertTrue(manager.activate("b", "p", "m1", BattleGimmick.MEGA))
        assertTrue(manager.activate("b", "p", "m2", BattleGimmick.TERASTAL))
        assertFalse(manager.activate("b", "p", "m3", BattleGimmick.DYNAMAX))

        manager.policy = GimmickPolicy(majorGimmicksPerPlayerPerBattle = 0)
        assertFalse(manager.canUse("other", "p", "m1", BattleGimmick.MEGA))
    }

    @Test
    fun `disabled gimmicks and missing integration block activation`() {
        val adapter = AlwaysAdapter()
        val manager = BattleGimmickManager(adapter, GimmickPolicy(enabled = setOf(BattleGimmick.MEGA)))

        assertFalse(manager.activate("b", "p", "m", BattleGimmick.DYNAMAX))
        assertEquals(0, adapter.activations)

        val absent = BattleGimmickManager(UnavailableGimmickAdapter)
        assertFalse(absent.activate("b", "p", "m", BattleGimmick.MEGA))
    }
}
