plugins {
    id("fabric-loom") version "1.11-SNAPSHOT"
    kotlin("jvm")
    kotlin("plugin.serialization")
}

base {
    archivesName.set("pokeworld")
}

repositories {
    mavenCentral()
}

fun prop(name: String): String =
    providers.gradleProperty(name).get()

dependencies {
    minecraft("com.mojang:minecraft:${prop("minecraft_version")}")
    mappings(loom.officialMojangMappings())

    modImplementation("net.fabricmc:fabric-loader:${prop("loader_version")}")
    modImplementation("net.fabricmc.fabric-api:fabric-api:${prop("fabric_api_version")}")
    modImplementation("net.fabricmc:fabric-language-kotlin:${prop("fabric_kotlin_version")}")

    // Shipped at runtime by fabric-language-kotlin
    compileOnly(
        "org.jetbrains.kotlinx:kotlinx-serialization-json:" +
            prop("kotlinx_serialization_version")
    )

    // Cobblemon is detected at runtime in Phase 1 (fabric.mod.json declares the
    // hard dependency). Its API is added here as modCompileOnly in Phase 3.
}

kotlin {
    jvmToolchain(21)

    // :core is Minecraft-independent and compiled straight into the mod jar
    sourceSets.main {
        kotlin.srcDir(project(":core").file("src/main/kotlin"))
    }
}

tasks.processResources {
    val props = mapOf(
        "version" to project.version,
        "minecraft_version" to prop("minecraft_version"),
        "loader_version" to prop("loader_version"),
        "fabric_kotlin_version" to prop("fabric_kotlin_version"),
        "cobblemon_min_version" to prop("cobblemon_min_version"),
    )

    inputs.properties(props)

    filesMatching("fabric.mod.json") {
        expand(props)
    }
}
