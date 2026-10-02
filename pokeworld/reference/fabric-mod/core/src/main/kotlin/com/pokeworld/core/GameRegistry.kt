package com.pokeworld.core

/**
 * Id-keyed store for one kind of [GameDefinition].
 *
 * Writes happen while content loads (mod init or datapack reload); reads happen
 * from the server thread afterwards. Readers always see a complete, immutable
 * snapshot: [register] and [replaceAll] publish a new map instead of mutating
 * the one being read.
 */
class GameRegistry<T : GameDefinition>(
    val key: String
) {

    @Volatile
    private var entries: Map<String, T> = emptyMap()

    @Volatile
    var isFrozen: Boolean = false
        private set

    val size: Int
        get() = entries.size

    @Synchronized
    fun register(value: T) {
        check(!isFrozen) {
            "Registry '$key' is frozen; use replaceAll() on reload"
        }

        GameIds.requireValid(value.id)

        require(value.id !in entries) {
            "Duplicate id in registry '$key': ${value.id}"
        }

        entries = LinkedHashMap(entries).apply {
            put(value.id, value)
        }
    }

    /**
     * Atomically swaps the full content of this registry. Used by datapack
     * reloads, so it is allowed after [freeze].
     */
    @Synchronized
    fun replaceAll(values: Collection<T>) {
        val next = LinkedHashMap<String, T>(values.size)

        for (value in values) {
            GameIds.requireValid(value.id)

            require(next.put(value.id, value) == null) {
                "Duplicate id in registry '$key': ${value.id}"
            }
        }

        entries = next
    }

    fun freeze() {
        isFrozen = true
    }

    operator fun get(id: String): T? =
        entries[id]

    operator fun contains(id: String): Boolean =
        id in entries

    fun getOrThrow(id: String): T =
        entries[id]
            ?: error("Missing definition in registry '$key': $id")

    fun all(): Collection<T> =
        entries.values

    fun ids(): Set<String> =
        entries.keys
}
