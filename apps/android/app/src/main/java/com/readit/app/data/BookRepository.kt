package com.readit.app.data

import android.content.Context
import kotlinx.serialization.json.Json

class BookRepository(private val context: Context) {

    private val json = Json { ignoreUnknownKeys = true }

    fun loadCatalog(): List<BookMeta> {
        val raw = readAsset("catalog/books.json")
        return json.decodeFromString<CatalogFile>(raw).books
    }

    fun loadBookIndex(slug: String): BookIndex? {
        val meta = loadCatalog().find { it.slug == slug } ?: return null
        val bookRoot = "books/${meta.folder}"

        val introPath = "$bookRoot/README.md"
        val introTitle = titleFromAsset(introPath, meta.title)
        val intro = ChapterRef("intro", introTitle, introPath, 0)

        val partDirs = context.assets.list(bookRoot)
            ?.filter { isPartDirectory(it) }
            ?.sorted()
            ?: emptyList()

        val parts = partDirs.map { partDir ->
            val partPath = "$bookRoot/$partDir"
            val files = context.assets.list(partPath)?.toList() ?: emptyList()
            val chapterFiles = files
                .filter { isChapterFile(it) }
                .sortedBy { chapterOrder(it) }

            var partTitle = prettifySegment(partDir)
            if (files.contains("_intro.md")) {
                partTitle = titleFromAsset("$partPath/_intro.md", partTitle)
            } else if (chapterFiles.isNotEmpty()) {
                val firstContent = readAsset("$partPath/${chapterFiles.first()}")
                val partLine = Regex("""">\s*\*\*Part\s+\d+\s+of\s+\d+\s*·\s*(.+?)\*\*""")
                    .find(firstContent)
                if (partLine != null) partTitle = partLine.groupValues[1].trim()
            }

            val chapters = chapterFiles.map { file ->
                val assetPath = "$partPath/$file"
                ChapterRef(
                    id = assetPath.removePrefix("$bookRoot/").removeSuffix(".md"),
                    title = titleFromAsset(assetPath, prettifySegment(file)),
                    assetPath = assetPath,
                    order = chapterOrder(file),
                )
            }

            PartRef(partDir, partTitle, chapters)
        }

        return BookIndex(meta, intro, parts)
    }

    fun readChapter(assetPath: String): String = readAsset(assetPath)

    fun flatChapters(index: BookIndex): List<ChapterRef> =
        listOf(index.intro) + index.parts.flatMap { it.chapters }

    private fun isPartDirectory(name: String): Boolean =
        Regex("^(?:part|Part)-\\d+", RegexOption.IGNORE_CASE).containsMatchIn(name)

    private fun isChapterFile(name: String): Boolean {
        if (!name.endsWith(".md")) return false
        return name.startsWith("CH-") ||
            name.startsWith("chapter-") ||
            name == "_intro.md"
    }

    private fun readAsset(path: String): String =
        context.assets.open(path).bufferedReader().readText()

    private fun titleFromAsset(path: String, fallback: String): String {
        val content = readAsset(path)
        val match = Regex("^#\\s+(.+)$", RegexOption.MULTILINE).find(content)
        return match?.groupValues?.get(1)?.replace("*", "")?.trim() ?: fallback
    }

    private fun prettifySegment(segment: String): String =
        segment
            .replace(Regex("^(?:part|Part)-\\d+-", RegexOption.IGNORE_CASE), "")
            .replace(Regex("^(?:CH|chapter)-\\d+-", RegexOption.IGNORE_CASE), "")
            .replace(Regex("^_intro$", RegexOption.IGNORE_CASE), "Part overview")
            .replace("-", " ")

    private fun chapterOrder(filename: String): Int {
        if (filename == "_intro.md") return 0
        val match = Regex("^(?:CH|chapter)-(\\d+)", RegexOption.IGNORE_CASE).find(filename)
        return match?.groupValues?.get(1)?.toIntOrNull() ?: 999
    }
}

fun BookType.label(): String = when (this) {
    BookType.TECHNICAL -> "Technical"
    BookType.MENTAL_MODELS -> "Mental Models"
    BookType.STARTUP_THINGS -> "Startup"
}

fun formatChapterTitle(title: String): String =
    title
        .replace(Regex("^CH-\\d+:\\s*", RegexOption.IGNORE_CASE), "")
        .replace(Regex("^Chapter\\s+\\d+:\\s*", RegexOption.IGNORE_CASE), "")
        .trim()
