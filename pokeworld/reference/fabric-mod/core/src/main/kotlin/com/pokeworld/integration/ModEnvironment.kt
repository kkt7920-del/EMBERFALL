package com.pokeworld.integration

import java.nio.file.Path

/**
 * What PokeWorld needs to know about the loader it runs in. The Fabric
 * implementation wraps FabricLoader; tests use a fake.
 */
interface ModEnvironment {

    fun isModLoaded(modId: String): Boolean

    /** The installed version string, or null when the mod is absent. */
    fun modVersion(modId: String): String?

    val configDir: Path

    val isDedicatedServer: Boolean
}
