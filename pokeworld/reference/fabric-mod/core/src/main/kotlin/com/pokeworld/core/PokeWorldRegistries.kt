package com.pokeworld.core

import com.pokeworld.air.AirZoneDefinition
import com.pokeworld.biome.BiomeDefinition
import com.pokeworld.crafting.RecipeDefinition
import com.pokeworld.legendary.LegendaryEventDefinition
import com.pokeworld.mining.OreDefinition
import com.pokeworld.mount.MountDefinition
import com.pokeworld.ocean.OceanZoneDefinition
import com.pokeworld.quest.QuestDefinition
import com.pokeworld.region.RegionDefinition
import com.pokeworld.spawn.SpawnDefinition
import com.pokeworld.structure.StructureDefinition
import com.pokeworld.vehicle.AircraftPart
import com.pokeworld.vehicle.VehicleDefinition

/**
 * Every PokeWorld registry. One instance per server, so an integrated server
 * and a later one in the same JVM never share content.
 */
class PokeWorldRegistries {

    val regions = GameRegistry<RegionDefinition>("regions")

    val biomes = GameRegistry<BiomeDefinition>("biomes")

    val spawns = GameRegistry<SpawnDefinition>("spawns")

    val mounts = GameRegistry<MountDefinition>("mounts")

    val vehicles = GameRegistry<VehicleDefinition>("vehicles")

    val aircraftParts = GameRegistry<AircraftPart>("aircraft_parts")

    val oceanZones = GameRegistry<OceanZoneDefinition>("ocean_zones")

    val airZones = GameRegistry<AirZoneDefinition>("air_zones")

    val ores = GameRegistry<OreDefinition>("ores")

    val recipes = GameRegistry<RecipeDefinition>("recipes")

    val structures = GameRegistry<StructureDefinition>("structures")

    val quests = GameRegistry<QuestDefinition>("quests")

    val legendaryEvents = GameRegistry<LegendaryEventDefinition>("legendary_events")

    fun all(): List<GameRegistry<*>> =
        listOf(
            regions, biomes, spawns, mounts, vehicles, aircraftParts,
            oceanZones, airZones, ores, recipes, structures, quests,
            legendaryEvents
        )

    fun freezeAll() {
        all().forEach(GameRegistry<*>::freeze)
    }
}
