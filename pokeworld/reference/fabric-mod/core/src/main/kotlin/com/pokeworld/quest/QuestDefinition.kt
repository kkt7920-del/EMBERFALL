package com.pokeworld.quest

import com.pokeworld.core.GameDefinition

enum class QuestType {
    MAIN,
    REGION,
    GYM,
    SIDE,
    EXPLORATION,
    RESEARCH,
    RUIN,
    LEGENDARY
}

data class QuestDefinition(

    override val id: String,

    val type: QuestType,

    val title: String,

    val prerequisiteIds: List<String>,

    val rewards: List<String>

) : GameDefinition
