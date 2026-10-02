package com.pokeworld.region

data class RegionConnection(

    val fromRegionId: String,

    val toRegionId: String,

    val minimumBadgeCount: Int = 0,

    val requiredQuestId: String? = null
)

class RegionProgression {

    private val connections =
        mutableListOf<RegionConnection>()

    fun add(connection: RegionConnection) {
        connections += connection
    }

    fun availableFrom(
        regionId: String,
        badgeCount: Int,
        completedQuests: Set<String>
    ): List<String> =
        connections
            .filter {
                it.fromRegionId == regionId &&
                    badgeCount >= it.minimumBadgeCount &&
                    (it.requiredQuestId == null || it.requiredQuestId in completedQuests)
            }
            .map { it.toRegionId }
}
