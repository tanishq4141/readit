package com.readit.app.ui.screens

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject

private fun renderMarkdown(webView: WebView, markdown: String) {
    val escaped = JSONObject.quote(markdown)
    webView.evaluateJavascript(
        "if (window.renderMarkdown) { renderMarkdown($escaped); }",
        null,
    )
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ReaderScreen(
    markdown: String,
    onPrevious: (() -> Unit)? = null,
    onNext: (() -> Unit)? = null,
) {
    val markdownState = rememberUpdatedState(markdown)

    Column(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            factory = { context ->
                WebView(context).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.allowFileAccess = true
                    webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView?, url: String?) {
                            view?.let { renderMarkdown(it, markdownState.value) }
                        }
                    }
                    loadUrl("file:///android_asset/reader/index.html")
                }
            },
            update = { webView ->
                if (webView.progress == 100) {
                    renderMarkdown(webView, markdownState.value)
                }
            },
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        )

        if (onPrevious != null || onNext != null) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                TextButton(
                    onClick = { onPrevious?.invoke() },
                    enabled = onPrevious != null,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        text = "← Previous",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                TextButton(
                    onClick = { onNext?.invoke() },
                    enabled = onNext != null,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        text = "Next →",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}
