package com.pokeworld.integration

import net.fabricmc.api.EnvType
import net.fabricmc.loader.api.FabricLoader
import java.nio.file.Path

class FabricModEnvironment(

    private val loader: FabricLoader = FabricLoader.getInstance()

) : ModEnvironment {

    override fun isModLoaded(modId: String): Boolean =
        loader.isModLoaded(modId)

    override fun modVersion(modId: String): String? =
        loader.getModContainer(modId)
            .map { it.metadata.version.friendlyString }
            .orElse(null)

    override val configDir: Path
        get() = loader.configDir

    override val isDedicatedServer: Boolean
        get() = loader.environmentType == EnvType.SERVER
}
