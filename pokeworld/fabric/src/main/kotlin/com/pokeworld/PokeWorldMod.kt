package com.pokeworld

import com.pokeworld.battle.BattleGimmickManager
import com.pokeworld.battle.UnavailableGimmickAdapter
import com.pokeworld.core.PokeWorldBootstrap
import com.pokeworld.core.PokeWorldConfig
import com.pokeworld.core.PokeWorldConfigLoader
import com.pokeworld.core.PokeWorldRegistries
import com.pokeworld.integration.FabricModEnvironment
import com.pokeworld.integration.IntegrationDetector
import com.pokeworld.integration.IntegrationStatus
import com.pokeworld.integration.Integrations
import net.fabricmc.api.ModInitializer
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents
import org.slf4j.Logger
import org.slf4j.LoggerFactory

/**
 * Common (client + dedicated server) entrypoint. Must never reference client
 * classes; those live under com.pokeworld.client.
 */
object PokeWorldMod : ModInitializer {

    const val MOD_ID = "pokeworld"

    val LOGGER: Logger = LoggerFactory.getLogger(MOD_ID)

    /** Everything Phase 1 sets up; available once [onInitialize] has run. */
    class State(
        val config: PokeWorldConfig,
        val integrations: Integrations,
        val registries: PokeWorldRegistries,
        val battleGimmicks: BattleGimmickManager
    )

    @Volatile
    private var state: State? = null

    fun state(): State =
        state ?: error("PokeWorld has not been initialized yet")

    override fun onInitialize() {
        val environment = FabricModEnvironment()

        val loaded = PokeWorldConfigLoader(
            environment.configDir.resolve(MOD_ID).resolve("server.json")
        ).load()

        if (loaded.createdDefault)
            LOGGER.info("Wrote default config to config/{}/server.json", MOD_ID)

        loaded.warnings.forEach { LOGGER.warn("Config: {}", it) }

        val integrations = IntegrationDetector.detect(environment, loaded.config.integrations)

        log(integrations.cobblemon)
        log(integrations.megaShowdown)

        // fabric.mod.json already refuses to load without Cobblemon >= 1.8.1;
        // this catches a loader or dev setup that bypassed that check.
        check(integrations.cobblemon.isActive) {
            "PokeWorld requires Cobblemon: ${integrations.cobblemon.detail}"
        }

        val registries = PokeWorldRegistries()

        // Datapack-driven content is loaded per phase from Phase 2 on.
        PokeWorldBootstrap.loadContent(registries, emptyList())

        // Mega Showdown's adapter arrives in Phase 14; until then gimmicks stay off.
        val battleGimmicks = BattleGimmickManager(
            UnavailableGimmickAdapter,
            loaded.config.gimmickPolicy()
        )

        state = State(loaded.config, integrations, registries, battleGimmicks)

        ServerLifecycleEvents.SERVER_STOPPED.register {
            battleGimmicks.clear()
        }

        LOGGER.info(
            "PokeWorld initialized ({} side)",
            if (environment.isDedicatedServer) "dedicated server" else "client"
        )
    }

    private fun log(status: IntegrationStatus) {
        LOGGER.info("Integration {}: {} — {}", status.modId, status.state, status.detail)
    }
}
