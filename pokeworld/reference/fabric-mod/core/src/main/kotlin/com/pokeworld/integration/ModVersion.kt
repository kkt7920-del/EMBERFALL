package com.pokeworld.integration

/**
 * Minimal semantic version: `1.8.1`, `1.8.1+1.21.1`, `1.8.1-beta.2`.
 * Build metadata after `+` is ignored, and a pre-release sorts before its
 * release, matching how Fabric compares versions in fabric.mod.json.
 */
data class ModVersion(

    val numbers: List<Int>,

    val preRelease: String? = null

) : Comparable<ModVersion> {

    override fun compareTo(other: ModVersion): Int {
        for (i in 0 until maxOf(numbers.size, other.numbers.size)) {
            val diff = numbers.getOrElse(i) { 0 }.compareTo(other.numbers.getOrElse(i) { 0 })
            if (diff != 0) return diff
        }

        return when {
            preRelease == other.preRelease -> 0
            preRelease == null -> 1
            other.preRelease == null -> -1
            else -> preRelease.compareTo(other.preRelease)
        }
    }

    override fun toString(): String =
        numbers.joinToString(".") + (preRelease?.let { "-$it" } ?: "")

    companion object {

        fun parse(raw: String): ModVersion? {
            val withoutBuild = raw.trim().substringBefore('+')
            val core = withoutBuild.substringBefore('-')
            val pre = withoutBuild.substringAfter('-', missingDelimiterValue = "")

            val numbers = core.split('.').map { it.toIntOrNull() ?: return null }

            if (numbers.isEmpty())
                return null

            return ModVersion(numbers, pre.ifEmpty { null })
        }
    }
}
