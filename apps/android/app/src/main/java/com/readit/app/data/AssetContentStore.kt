package com.readit.app.data

import android.content.Context

class AssetContentStore(private val context: Context) : ContentStore {

    override fun readText(path: String): String? =
        try {
            context.assets.open(path).bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            null
        }

    override fun list(dir: String): List<String>? =
        try {
            context.assets.list(dir)?.toList()
        } catch (_: Exception) {
            null
        }

    override fun exists(path: String): Boolean =
        try {
            context.assets.open(path).close()
            true
        } catch (_: Exception) {
            false
        }
}
