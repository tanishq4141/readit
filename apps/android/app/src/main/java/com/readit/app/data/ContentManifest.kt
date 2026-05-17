package com.readit.app.data

import kotlinx.serialization.Serializable

@Serializable
data class ContentManifest(
    val version: String,
    val generatedAt: String,
    val files: List<ContentManifestFile>,
)

@Serializable
data class ContentManifestFile(
    val path: String,
    val sha256: String,
    val size: Long,
)

@Serializable
data class ContentSyncIndex(
    val manifestVersion: String = "",
    val hashes: Map<String, String> = emptyMap(),
)
