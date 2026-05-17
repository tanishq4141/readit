package com.readit.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.readit.app.data.BookMeta
import com.readit.app.data.SyncState
import com.readit.app.ui.components.TypeBadge

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CatalogScreen(
    books: List<BookMeta>,
    syncState: SyncState,
    contentSyncEnabled: Boolean,
    onRefresh: () -> Unit,
    onBookClick: (String) -> Unit,
) {
    val isRefreshing = syncState is SyncState.Syncing

    PullToRefreshBox(
        isRefreshing = isRefreshing,
        onRefresh = onRefresh,
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp)) {
                Text(
                    text = "YOUR LIBRARY",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
                Text(
                    text = "Read without friction",
                    style = MaterialTheme.typography.headlineLarge,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 8.dp),
                )
                SyncStatusLine(
                    syncState = syncState,
                    contentSyncEnabled = contentSyncEnabled,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }

            if (books.isEmpty()) {
                Text(
                    text = emptyLibraryMessage(syncState, contentSyncEnabled),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(300.dp),
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(books, key = { it.slug }) { book ->
                        BookCard(book = book, onClick = { onBookClick(book.slug) })
                    }
                }
            }
        }
    }
}

@Composable
private fun SyncStatusLine(
    syncState: SyncState,
    contentSyncEnabled: Boolean,
    modifier: Modifier = Modifier,
) {
    if (!contentSyncEnabled) return

    val text = when (syncState) {
        SyncState.Idle -> null
        SyncState.Syncing -> "Updating library…"
        is SyncState.UpToDate -> "Library up to date"
        is SyncState.Error -> syncState.message
    }

    text?.let {
        Text(
            text = it,
            style = MaterialTheme.typography.bodySmall,
            color = when (syncState) {
                is SyncState.Error -> MaterialTheme.colorScheme.error
                else -> MaterialTheme.colorScheme.onSurfaceVariant
            },
            modifier = modifier,
        )
    }
}

private fun emptyLibraryMessage(syncState: SyncState, contentSyncEnabled: Boolean): String =
    when {
        !contentSyncEnabled ->
            "No books found. Set readit.content.base.url in local.properties to sync from S3, or use a debug build with bundled manuscripts."
        syncState is SyncState.Syncing ->
            "Loading library…"
        syncState is SyncState.Error ->
            "Could not load the library. Connect to the internet and pull down to refresh."
        else ->
            "No books yet. Pull down to sync from the server."
    }

@Composable
private fun BookCard(book: BookMeta, onClick: () -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = 1.dp,
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            TypeBadge(type = book.type)
            Text(
                text = book.title,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = 12.dp),
            )
            book.subtitle?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            Text(
                text = book.description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp),
            )
            Text(
                text = "Open book →",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(top = 16.dp),
            )
        }
    }
}
