pluginManagement {
    repositories {
        gradlePluginPortal()
        maven("https://maven.fabricmc.net/") { name = "Fabric" }
        mavenCentral()
    }
}

rootProject.name = "pokeworld"

// :core is plain Kotlin (no Minecraft classes) and is unit-tested on its own.
// :fabric is the Loom mod project; it compiles :core sources into the mod jar.
// Pass -Ppokeworld.coreOnly=true to build/test :core without Fabric/Mojang access.
include(":core")

if (providers.gradleProperty("pokeworld.coreOnly").orNull != "true") {
    include(":fabric")
}
