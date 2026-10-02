package com.pokeworld.core

/**
 * Code-side content source. Most content arrives as datapack JSON; a pack is
 * for add-ons that need to compute definitions. The core mod runs with none.
 */
interface ContentPack {

    val id: String

    fun register(registries: PokeWorldRegistries)
}

object PokeWorldBootstrap {

    fun loadContent(
        registries: PokeWorldRegistries,
        packs: List<ContentPack>
    ) {
        val duplicate = packs
            .groupBy(ContentPack::id)
            .filterValues { it.size > 1 }
            .keys

        require(duplicate.isEmpty()) {
            "Duplicate content pack ids: $duplicate"
        }

        packs.forEach { it.register(registries) }

        registries.freezeAll()
    }
}
