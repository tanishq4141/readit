package com.readit.app.data

import java.io.File

class FileContentStore(private val rootDir: File) : ContentStore {

    init {
        rootDir.mkdirs()
    }

    private fun resolve(path: String): File = File(rootDir, path)

    override fun readText(path: String): String? {
        val file = resolve(path)
        if (!file.isFile) return null
        return try {
            file.readText()
        } catch (_: Exception) {
            null
        }
    }

    override fun list(dir: String): List<String>? {
        val directory = resolve(dir)
        if (!directory.isDirectory) return null
        return directory.list()?.toList()
    }

    override fun exists(path: String): Boolean = resolve(path).exists()
}
