package com.readit.app.data

import kotlinx.serialization.json.Json

class BookRepository(private val store: ContentStore) {

    private val json = Json { ignoreUnknownKeys = true }

    fun loadCatalog(): List<BookMeta> {
        val raw = store.readText("catalog/books.json")
            ?: throw IllegalStateException("catalog/books.json not found")
        return json.decodeFromString<CatalogFile>(raw).books
    }

    fun loadBookIndex(slug: String): BookIndex? {
        val meta = loadCatalog().find { it.slug == slug } ?: return null
        val bookRoot = "books/${meta.folder}"

        val introPath = "$bookRoot/README.md"
        val introTitle = titleFromPath(introPath, meta.title)
        val intro = ChapterRef("intro", introTitle, introPath, 0)

        val partDirs = store.list(bookRoot)
            ?.filter { isPartDirectory(it) }
            ?.sorted()
            ?: emptyList()

        val parts = partDirs.map { partDir ->
            val partPath = "$bookRoot/$partDir"
            val files = store.list(partPath) ?: emptyList()
            val chapterFiles = files
                .filter { isChapterFile(it) }
                .sortedBy { chapterOrder(it) }

            var partTitle = prettifySegment(partDir)
            if (files.contains("_intro.md")) {
                partTitle = titleFromPath("$partPath/_intro.md", partTitle)
            } else if (chapterFiles.isNotEmpty()) {
                val firstContent = store.readText("$partPath/${chapterFiles.first()}")
                if (firstContent != null) {
                    val partLine = Regex("""">\s*\*\*Part\s+\d+\s+of\s+\d+\s*·\s*(.+?)\*\*""")
                        .find(firstContent)
                    if (partLine != null) partTitle = partLine.groupValues[1].trim()
                }
            }

            val chapters = chapterFiles.map { file ->
                val assetPath = "$partPath/$file"
                ChapterRef(
                    id = assetPath.removePrefix("$bookRoot/").removeSuffix(".md"),
                    title = titleFromPath(assetPath, prettifySegment(file)),
                    assetPath = assetPath,
                    order = chapterOrder(file),
                )
            }

            PartRef(partDir, partTitle, chapters)
        }

        return BookIndex(meta, intro, parts)
    }

    fun readChapter(assetPath: String): String =
        store.readText(assetPath)
            ?: throw IllegalStateException("Chapter not found: $assetPath")

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

    private fun titleFromPath(path: String, fallback: String): String {
        val content = store.readText(path) ?: return fallback
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
