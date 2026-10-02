package com.pokeworld.client

import com.pokeworld.PokeWorldMod
import net.fabricmc.api.ClientModInitializer

/** Client-only entrypoint; loaded by Fabric only on the physical client. */
object PokeWorldClient : ClientModInitializer {

    override fun onInitializeClient() {
        PokeWorldMod.LOGGER.info("PokeWorld client initialized")
    }
}
