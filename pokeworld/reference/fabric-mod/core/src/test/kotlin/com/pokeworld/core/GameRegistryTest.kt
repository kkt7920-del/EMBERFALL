package com.pokeworld.core

import com.pokeworld.quest.QuestDefinition
import com.pokeworld.quest.QuestType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GameRegistryTest {

    private fun quest(id: String) =
        QuestDefinition(id, QuestType.SIDE, "t", emptyList(), emptyList())

    @Test
    fun `registers and looks up by id`() {
        val registry = GameRegistry<QuestDefinition>("quests")
        registry.register(quest("pokeworld:first"))

        assertEquals("pokeworld:first", registry.getOrThrow("pokeworld:first").id)
        assertTrue("pokeworld:first" in registry)
        assertNull(registry["pokeworld:missing"])
    }

    @Test
    fun `rejects duplicates and malformed ids`() {
        val registry = GameRegistry<QuestDefinition>("quests")
        registry.register(quest("pokeworld:first"))

        assertFailsWith<IllegalArgumentException> { registry.register(quest("pokeworld:first")) }
        assertFailsWith<IllegalArgumentException> { registry.register(quest("NoNamespace")) }
        assertFailsWith<IllegalArgumentException> { registry.register(quest("pokeworld:Upper")) }
    }

    @Test
    fun `frozen registry refuses register but accepts reload`() {
        val registry = GameRegistry<QuestDefinition>("quests")
        registry.register(quest("pokeworld:a"))
        registry.freeze()

        assertFailsWith<IllegalStateException> { registry.register(quest("pokeworld:b")) }

        registry.replaceAll(listOf(quest("pokeworld:b"), quest("pokeworld:c")))

        assertEquals(setOf("pokeworld:b", "pokeworld:c"), registry.ids())
    }

    @Test
    fun `failed reload keeps previous content`() {
        val registry = GameRegistry<QuestDefinition>("quests")
        registry.register(quest("pokeworld:a"))

        assertFailsWith<IllegalArgumentException> {
            registry.replaceAll(listOf(quest("pokeworld:b"), quest("pokeworld:b")))
        }

        assertEquals(setOf("pokeworld:a"), registry.ids())
    }

    @Test
    fun `bootstrap rejects duplicate pack ids and freezes`() {
        val pack = object : ContentPack {
            override val id = "pack"
            override fun register(registries: PokeWorldRegistries) {
                registries.quests.register(quest("pack:q"))
            }
        }

        assertFailsWith<IllegalArgumentException> {
            PokeWorldBootstrap.loadContent(PokeWorldRegistries(), listOf(pack, pack))
        }

        val registries = PokeWorldRegistries()
        PokeWorldBootstrap.loadContent(registries, listOf(pack))

        assertEquals(1, registries.quests.size)
        assertTrue(registries.all().all { it.isFrozen })
    }
}
