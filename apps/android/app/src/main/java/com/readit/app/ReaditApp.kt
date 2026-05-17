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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.readit.app.data.ChapterRef
import com.readit.app.data.ReaditContent
import com.readit.app.data.SyncState
import com.readit.app.ui.screens.BookDetailScreen
import com.readit.app.ui.screens.CatalogScreen
import com.readit.app.ui.screens.ReaderScreen
import com.readit.app.ui.theme.ReaditTheme
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReaditApp() {
    val context = LocalContext.current
    val content = remember { ReaditContent(context.applicationContext) }
    val repository = content.repository
    val sync = content.sync
    val scope = rememberCoroutineScope()
    val navController = rememberNavController()

    val syncState by sync.state.collectAsStateWithLifecycle()
    var catalogKey by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) {
        if (sync.isEnabled()) {
            sync.sync()
        }
    }

    LaunchedEffect(syncState) {
        if (syncState is SyncState.UpToDate) {
            catalogKey++
        }
    }

    val catalog = remember(catalogKey) {
        try {
            repository.loadCatalog()
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun refreshLibrary() {
        scope.launch {
            sync.sync(force = true)
        }
    }

    fun openChapter(slug: String, chapterId: String) {
        val encoded = Uri.encode(chapterId)
        val route = "read/$slug?chapterId=$encoded"
        val current = navController.currentBackStackEntry
        val onReader = current?.destination?.route?.startsWith("read/") == true

        navController.navigate(route) {
            if (onReader) {
                // Replace the current reader entry so chapterId actually updates (launchSingleTop alone does not).
                popUpTo(current.destination.id) { inclusive = true }
            } else {
                popUpTo("book/$slug") { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
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
                if (route != null) {
                    val onCatalog = route == "catalog"
                    val title = when {
                        onCatalog -> "Readit"
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
                            if (!onCatalog) {
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
                        syncState = syncState,
                        contentSyncEnabled = sync.isEnabled(),
                        onRefresh = ::refreshLibrary,
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

                    key(chapterId) {
                        val index = repository.loadBookIndex(slug) ?: return@key
                        val flat = repository.flatChapters(index)
                        val currentIndex = flat.indexOfFirst { it.id == chapterId }
                        if (currentIndex < 0) return@key

                        val chapter = flat[currentIndex]
                        val markdown = try {
                            repository.readChapter(chapter.assetPath)
                        } catch (_: Exception) {
                            return@key
                        }

                        val prev: ChapterRef? = flat.getOrNull(currentIndex - 1)
                        val next: ChapterRef? = flat.getOrNull(currentIndex + 1)

                        LaunchedEffect(next?.assetPath) {
                            val nextPath = next?.assetPath ?: return@LaunchedEffect
                            if (sync.isEnabled()) {
                                sync.ensureCached(nextPath)
                            }
                        }

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
}
