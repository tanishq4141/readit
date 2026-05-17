package com.readit.app.data

/** Prefer on-disk cache; fall back to bundled assets. */
class LayeredContentStore(
    private val primary: ContentStore,
    private val fallback: ContentStore,
) : ContentStore {

    override fun readText(path: String): String? =
        primary.readText(path) ?: fallback.readText(path)

    override fun list(dir: String): List<String>? =
        primary.list(dir) ?: fallback.list(dir)

    override fun exists(path: String): Boolean =
        primary.exists(path) || fallback.exists(path)
}
