package com.pokeworld.integration

import com.pokeworld.core.IntegrationSettings

enum class IntegrationState {
    /** Present, compatible and in use. */
    ACTIVE,

    /** Not installed. */
    MISSING,

    /** Installed but unusable (wrong version, or a requirement is missing). */
    INCOMPATIBLE,

    /** Installed but switched off in the PokeWorld config. */
    DISABLED
}

data class IntegrationStatus(

    val modId: String,

    val state: IntegrationState,

    val version: String?,

    val detail: String
) {

    val isActive: Boolean
        get() = state == IntegrationState.ACTIVE
}

data class Integrations(

    val cobblemon: IntegrationStatus,

    val megaShowdown: IntegrationStatus
)

object IntegrationDetector {

    const val COBBLEMON_MOD_ID = "cobblemon"

    const val MEGA_SHOWDOWN_MOD_ID = "mega_showdown"

    val COBBLEMON_MIN_VERSION: ModVersion =
        ModVersion(listOf(1, 8, 1))

    fun detect(
        environment: ModEnvironment,
        settings: IntegrationSettings
    ): Integrations {
        val cobblemon = detectCobblemon(environment)

        return Integrations(
            cobblemon = cobblemon,
            megaShowdown = detectMegaShowdown(environment, settings, cobblemon)
        )
    }

    private fun detectCobblemon(environment: ModEnvironment): IntegrationStatus {
        if (!environment.isModLoaded(COBBLEMON_MOD_ID))
            return IntegrationStatus(
                COBBLEMON_MOD_ID,
                IntegrationState.MISSING,
                null,
                "Cobblemon $COBBLEMON_MIN_VERSION or newer is required"
            )

        val raw = environment.modVersion(COBBLEMON_MOD_ID)
        val version = raw?.let(ModVersion::parse)

        return when {
            version == null ->
                IntegrationStatus(
                    COBBLEMON_MOD_ID,
                    IntegrationState.INCOMPATIBLE,
                    raw,
                    "unrecognised Cobblemon version '$raw'"
                )

            version < COBBLEMON_MIN_VERSION ->
                IntegrationStatus(
                    COBBLEMON_MOD_ID,
                    IntegrationState.INCOMPATIBLE,
                    raw,
                    "Cobblemon $raw is older than required $COBBLEMON_MIN_VERSION"
                )

            else ->
                IntegrationStatus(
                    COBBLEMON_MOD_ID,
                    IntegrationState.ACTIVE,
                    raw,
                    "Cobblemon $raw"
                )
        }
    }

    private fun detectMegaShowdown(
        environment: ModEnvironment,
        settings: IntegrationSettings,
        cobblemon: IntegrationStatus
    ): IntegrationStatus {
        val loaded = environment.isModLoaded(MEGA_SHOWDOWN_MOD_ID)
        val version = if (loaded) environment.modVersion(MEGA_SHOWDOWN_MOD_ID) else null

        return when {
            !loaded ->
                IntegrationStatus(
                    MEGA_SHOWDOWN_MOD_ID,
                    IntegrationState.MISSING,
                    null,
                    "not installed; battle gimmicks are off"
                )

            !settings.megaShowdown ->
                IntegrationStatus(
                    MEGA_SHOWDOWN_MOD_ID,
                    IntegrationState.DISABLED,
                    version,
                    "installed but disabled in config (integrations.megaShowdown)"
                )

            !cobblemon.isActive ->
                IntegrationStatus(
                    MEGA_SHOWDOWN_MOD_ID,
                    IntegrationState.INCOMPATIBLE,
                    version,
                    "needs a compatible Cobblemon"
                )

            else ->
                IntegrationStatus(
                    MEGA_SHOWDOWN_MOD_ID,
                    IntegrationState.ACTIVE,
                    version,
                    "Mega Showdown $version"
                )
        }
    }
}
