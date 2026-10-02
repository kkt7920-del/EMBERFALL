plugins {
    kotlin("jvm") version "2.2.21" apply false
    kotlin("plugin.serialization") version "2.2.21" apply false
}

allprojects {
    group = "com.pokeworld"
    version = providers.gradleProperty("mod_version").get()
}
