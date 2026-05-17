package com.readit.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class BookType {
    @SerialName("technical")
    TECHNICAL,

    @SerialName("mental-models")
    MENTAL_MODELS,

    @SerialName("startup-things")
    STARTUP_THINGS,
}

@Serializable
data class BookMeta(
    val slug: String,
    val title: String,
    val subtitle: String? = null,
    val description: String,
    val type: BookType,
    val folder: String,
)

@Serializable
data class CatalogFile(val books: List<BookMeta>)

data class ChapterRef(
    val id: String,
    val title: String,
    val assetPath: String,
    val order: Int,
)

data class PartRef(
    val id: String,
    val title: String,
    val chapters: List<ChapterRef>,
)

data class BookIndex(
    val meta: BookMeta,
    val intro: ChapterRef,
    val parts: List<PartRef>,
)
