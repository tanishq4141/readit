package com.readit.app.data

interface ContentStore {
    fun readText(path: String): String?
    fun list(dir: String): List<String>?
    fun exists(path: String): Boolean
}
