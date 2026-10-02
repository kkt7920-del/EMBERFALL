package com.pokeworld.core

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

data class ConfigLoadResult(

    val config: PokeWorldConfig,

    val warnings: List<String>,

    /** True when no file existed and the defaults were written out. */
    val createdDefault: Boolean
)

/**
 * Reads and writes the server config. A file that cannot be parsed is never
 * overwritten: the server starts on defaults and the admin gets a warning.
 */
class PokeWorldConfigLoader(

    private val path: Path

) {

    fun load(): ConfigLoadResult {
        if (Files.notExists(path)) {
            val defaults = PokeWorldConfig()
            write(defaults)
            return ConfigLoadResult(defaults, emptyList(), createdDefault = true)
        }

        val text = try {
            Files.readString(path)
        } catch (e: IOException) {
            return fallback("could not read $path: ${e.message}")
        }

        val decoded = try {
            json.decodeFromString(PokeWorldConfig.serializer(), migrate(text))
        } catch (e: SerializationException) {
            return fallback("could not parse $path: ${e.message}")
        } catch (e: IllegalArgumentException) {
            return fallback("invalid value in $path: ${e.message}")
        }

        val warnings = mutableListOf<String>()

        if (decoded.configVersion > PokeWorldConfig.CURRENT_VERSION) {
            warnings += "$path has configVersion ${decoded.configVersion}, newer than " +
                "supported ${PokeWorldConfig.CURRENT_VERSION}; unknown settings are ignored"
        }

        val (config, fixes) = decoded.sanitized()
        warnings += fixes

        if (decoded.configVersion < PokeWorldConfig.CURRENT_VERSION) {
            write(config.copy(configVersion = PokeWorldConfig.CURRENT_VERSION))
            warnings += "upgraded $path from configVersion ${decoded.configVersion} " +
                "to ${PokeWorldConfig.CURRENT_VERSION}"
        }

        return ConfigLoadResult(config, warnings, createdDefault = false)
    }

    fun write(config: PokeWorldConfig) {
        path.parent?.let(Files::createDirectories)

        val temp = path.resolveSibling("${path.fileName}.tmp")
        Files.writeString(temp, json.encodeToString(PokeWorldConfig.serializer(), config) + "\n")

        try {
            Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (e: AtomicMoveNotSupportedException) {
            Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    /**
     * Rewrites older config JSON into the current shape. Version 1 is the
     * first format, so there is nothing to rewrite yet; add steps here as
     * `if (version < N) ...` when the format changes.
     */
    private fun migrate(text: String): String {
        val version = json.parseToJsonElement(text)
            .jsonObject["configVersion"]
            ?.jsonPrimitive
            ?.int
            ?: 1

        require(version >= 1) { "configVersion must be >= 1" }

        return text
    }

    private fun fallback(reason: String): ConfigLoadResult =
        ConfigLoadResult(
            PokeWorldConfig(),
            listOf("$reason; using defaults and leaving the file untouched"),
            createdDefault = false
        )

    companion object {
        val json = Json {
            prettyPrint = true
            encodeDefaults = true
            ignoreUnknownKeys = true
        }
    }
}
