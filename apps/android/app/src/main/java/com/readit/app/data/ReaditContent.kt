package com.readit.app.data

import android.content.Context
import com.readit.app.BuildConfig
import java.io.File

class ReaditContent(context: Context) {
    private val appContext = context.applicationContext
    private val cacheRoot = File(appContext.filesDir, "content")

    val fileStore = FileContentStore(cacheRoot)
    val assetStore = AssetContentStore(appContext)
    val store: ContentStore = LayeredContentStore(fileStore, assetStore)
    val repository = BookRepository(store)

    val sync: ContentSync = ContentSync(
        baseUrl = BuildConfig.CONTENT_BASE_URL,
        cacheRoot = cacheRoot,
        prefs = appContext.getSharedPreferences("readit_content", Context.MODE_PRIVATE),
    )
}
