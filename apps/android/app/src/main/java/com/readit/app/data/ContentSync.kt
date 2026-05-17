package com.readit.app.data

import android.content.SharedPreferences
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

class ContentSync(
    private val baseUrl: String,
    private val cacheRoot: File,
    private val prefs: SharedPreferences,
    private val client: OkHttpClient = defaultClient(),
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val _state = MutableStateFlow<SyncState>(SyncState.Idle)
    val state: StateFlow<SyncState> = _state.asStateFlow()

    private val indexFile: File get() = File(cacheRoot, ".sync-index.json")

    fun isEnabled(): Boolean = baseUrl.isNotBlank()

    suspend fun sync(force: Boolean = false): Boolean = withContext(Dispatchers.IO) {
        if (!isEnabled()) {
            _state.value = SyncState.Idle
            return@withContext false
        }
        if (_state.value is SyncState.Syncing && !force) return@withContext false

        _state.value = SyncState.Syncing
        try {
            cacheRoot.mkdirs()
            val manifest = fetchManifest()

            val localIndex = loadIndex()
            val toDownload = manifest.files.filter { file ->
                val localHash = localIndex.hashes[file.path]
                localHash != file.sha256 || !File(cacheRoot, file.path).isFile
            }

            if (toDownload.isNotEmpty()) {
                downloadFiles(toDownload)
            }

            val manifestPaths = manifest.files.map { it.path }.toSet()
            pruneOrphans(manifestPaths, localIndex.hashes.keys)

            val newHashes = manifest.files.associate { it.path to it.sha256 }
            saveIndex(ContentSyncIndex(manifest.version, newHashes))

            _state.value = SyncState.UpToDate(manifest.version)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Content sync failed", e)
            _state.value = SyncState.Error(e.message ?: "Sync failed")
            false
        }
    }

    suspend fun ensureCached(path: String) {
        if (!isEnabled()) return
        withContext(Dispatchers.IO) {
            val file = File(cacheRoot, path)
            if (file.isFile) return@withContext

            val index = loadIndex()
            val manifest = try {
                fetchManifest()
            } catch (_: Exception) {
                return@withContext
            }
            val entry = manifest.files.find { it.path == path } ?: return@withContext
            if (index.hashes[path] == entry.sha256 && file.isFile) return@withContext

            downloadFiles(listOf(entry))
            val updated = loadIndex().hashes.toMutableMap()
            updated[path] = entry.sha256
            saveIndex(ContentSyncIndex(manifest.version, updated))
        }
    }

    private fun fetchManifest(): ContentManifest {
        val url = resolveUrl("content-manifest.json")
        val request = Request.Builder().url(url).get().build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val hint = when (response.code) {
                    401, 403 ->
                        "Server returned ${response.code}. Check that S3 objects under your prefix are publicly readable."
                    404 ->
                        "Content not found (404). Run content:publish on main after changing books/ or catalog/."
                    else -> "HTTP ${response.code} while fetching manifest"
                }
                throw IllegalStateException(hint)
            }
            val body = response.body?.string()
                ?: throw IllegalStateException("Empty manifest response")
            return json.decodeFromString<ContentManifest>(body)
        }
    }

    private suspend fun downloadFiles(files: List<ContentManifestFile>) = coroutineScope {
        val semaphore = Semaphore(MAX_PARALLEL)
        files.map { entry ->
            async {
                semaphore.withPermit {
                    downloadOne(entry)
                }
            }
        }.awaitAll()
    }

    private fun downloadOne(entry: ContentManifestFile) {
        val url = resolveUrl(entry.path)
        val request = Request.Builder().url(url).get().build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IllegalStateException("Failed to download ${entry.path}: HTTP ${response.code}")
            }
            val bytes = response.body?.bytes() ?: throw IllegalStateException("Empty body for ${entry.path}")
            val dest = File(cacheRoot, entry.path)
            dest.parentFile?.mkdirs()
            val tmp = File(dest.parentFile, dest.name + ".tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(dest)) {
                dest.writeBytes(bytes)
                tmp.delete()
            }
        }
    }

    private fun resolveUrl(relativePath: String): String {
        val base = baseUrl.trimEnd('/').toHttpUrlOrNull()
            ?: throw IllegalStateException("Invalid content base URL: $baseUrl")
        return base.newBuilder()
            .addPathSegments(relativePath.trimStart('/'))
            .build()
            .toString()
    }

    private fun pruneOrphans(validPaths: Set<String>, cachedPaths: Set<String>) {
        for (path in cachedPaths) {
            if (path !in validPaths) {
                File(cacheRoot, path).delete()
            }
        }
    }

    private fun loadIndex(): ContentSyncIndex {
        if (!indexFile.isFile) {
            val legacy = prefs.getString(PREFS_INDEX, null) ?: return ContentSyncIndex()
            return try {
                json.decodeFromString<ContentSyncIndex>(legacy)
            } catch (_: Exception) {
                ContentSyncIndex()
            }
        }
        return try {
            json.decodeFromString<ContentSyncIndex>(indexFile.readText())
        } catch (_: Exception) {
            ContentSyncIndex()
        }
    }

    private fun saveIndex(index: ContentSyncIndex) {
        val encoded = json.encodeToString(index)
        indexFile.writeText(encoded)
        prefs.edit().putString(PREFS_INDEX, encoded).apply()
    }

    companion object {
        private const val TAG = "ContentSync"
        private const val PREFS_INDEX = "content_sync_index"
        private const val MAX_PARALLEL = 4

        fun defaultClient(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .build()
    }
}
