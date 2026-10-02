plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(
        "org.jetbrains.kotlinx:kotlinx-serialization-json:" +
            providers.gradleProperty("kotlinx_serialization_version").get()
    )

    testImplementation(kotlin("test"))
}

kotlin {
    // Minecraft 1.21.1 runs on Java 21
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
}
