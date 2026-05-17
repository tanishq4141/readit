package com.readit.app

import android.net.Uri
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.readit.app.data.BookRepository
import com.readit.app.data.ChapterRef
import com.readit.app.ui.screens.BookDetailScreen
import com.readit.app.ui.screens.CatalogScreen
import com.readit.app.ui.screens.ReaderScreen
import com.readit.app.ui.theme.ReaditTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReaditApp() {
    val context = LocalContext.current
    val repository = remember { BookRepository(context.applicationContext) }
    val navController = rememberNavController()
    val catalog = remember {
        try {
            repository.loadCatalog()
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun openChapter(slug: String, chapterId: String) {
        val encoded = Uri.encode(chapterId)
        navController.navigate("read/$slug?chapterId=$encoded") {
            popUpTo("book/$slug") { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    fun navigateBack() {
        val entry = navController.currentBackStackEntry ?: return
        val route = entry.destination.route ?: return
        when {
            route.startsWith("read/") -> {
                val slug = entry.arguments?.getString("slug") ?: return
                navController.popBackStack("book/$slug", inclusive = false)
            }
            route.startsWith("book/") -> {
                navController.popBackStack("catalog", inclusive = false)
            }
            else -> navController.popBackStack()
        }
    }

    ReaditTheme {
        val backStackEntry by navController.currentBackStackEntryAsState()
        val route = backStackEntry?.destination?.route

        Scaffold(
            topBar = {
                if (route != null && route != "catalog") {
                    val title = when {
                        route.startsWith("read/") -> {
                            val slug = backStackEntry?.arguments?.getString("slug")
                            val chapterId = backStackEntry?.arguments?.getString("chapterId")
                            if (slug != null && chapterId != null) {
                                repository.loadBookIndex(slug)
                                    ?.let { index ->
                                        repository.flatChapters(index)
                                            .find { it.id == chapterId }
                                            ?.title
                                    }
                            } else null
                        }
                        route.startsWith("book/") -> {
                            backStackEntry?.arguments?.getString("slug")
                                ?.let { repository.loadBookIndex(it)?.meta?.title }
                        }
                        else -> null
                    } ?: "Readit"

                    TopAppBar(
                        title = {
                            Text(
                                text = title,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                fontWeight = FontWeight.SemiBold,
                            )
                        },
                        navigationIcon = {
                            IconButton(onClick = ::navigateBack) {
                                Icon(
                                    Icons.AutoMirrored.Filled.ArrowBack,
                                    contentDescription = when {
                                        route.startsWith("read/") -> "Back to contents"
                                        route.startsWith("book/") -> "Back to library"
                                        else -> "Back"
                                    },
                                )
                            }
                        },
                        colors = TopAppBarDefaults.topAppBarColors(
                            containerColor = androidx.compose.material3.MaterialTheme.colorScheme.surface,
                        ),
                    )
                }
            },
        ) { padding ->
            NavHost(
                navController = navController,
                startDestination = "catalog",
                modifier = Modifier.padding(padding),
            ) {
                composable("catalog") {
                    CatalogScreen(
                        books = catalog,
                        onBookClick = { slug -> navController.navigate("book/$slug") },
                    )
                }

                composable(
                    route = "book/{slug}",
                    arguments = listOf(navArgument("slug") { type = NavType.StringType }),
                ) { entry ->
                    val slug = entry.arguments?.getString("slug") ?: return@composable
                    val index = repository.loadBookIndex(slug) ?: return@composable
                    BookDetailScreen(
                        index = index,
                        onChapterClick = { chapterId -> openChapter(slug, chapterId) },
                    )
                }

                composable(
                    route = "read/{slug}?chapterId={chapterId}",
                    arguments = listOf(
                        navArgument("slug") { type = NavType.StringType },
                        navArgument("chapterId") {
                            type = NavType.StringType
                            defaultValue = "intro"
                        },
                    ),
                ) { entry ->
                    val slug = entry.arguments?.getString("slug") ?: return@composable
                    val chapterId = entry.arguments?.getString("chapterId") ?: "intro"
                    val index = repository.loadBookIndex(slug) ?: return@composable

                    val flat = repository.flatChapters(index)
                    val currentIndex = flat.indexOfFirst { it.id == chapterId }
                    if (currentIndex < 0) return@composable

                    val chapter = flat[currentIndex]
                    val markdown = try {
                        repository.readChapter(chapter.assetPath)
                    } catch (_: Exception) {
                        return@composable
                    }

                    val prev: ChapterRef? = flat.getOrNull(currentIndex - 1)
                    val next: ChapterRef? = flat.getOrNull(currentIndex + 1)

                    ReaderScreen(
                        markdown = markdown,
                        onPrevious = prev?.let { { openChapter(slug, it.id) } },
                        onNext = next?.let { { openChapter(slug, it.id) } },
                    )
                }
            }
        }
    }
}
