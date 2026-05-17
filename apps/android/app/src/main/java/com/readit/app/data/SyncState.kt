package com.readit.app.data

sealed class SyncState {
    data object Idle : SyncState()
    data object Syncing : SyncState()
    data class UpToDate(val version: String) : SyncState()
    data class Error(val message: String) : SyncState()
}
