# Readit

Monorepo for the Readit product — a clean library and reader for AI-authored books.

## Projects

| App | Path | Stack |
|-----|------|-------|
| Web | `apps/web` | Next.js (App Router), TypeScript, Tailwind |
| Android | `apps/android` | Kotlin, Jetpack Compose |

Protected content (do not modify via automation unless requested):

- `books/the-solvers-mind/` — book manuscript
- `.claude/` — agent skills and config

## Book catalog

Register books in `catalog/books.json`. Each entry points at a folder under `books/`.

**Types:** `technical` · `mental-models` · `startup-things`

Markdown manuscripts support GFM, syntax-highlighted code blocks, and Mermaid diagrams.

## Web

```bash
npm install
npm run dev:web
```

- `/` — library catalog
- `/books/{slug}` — table of contents
- `/books/{slug}/read/{chapter}` — reader

## Android

Open `apps/android` in Android Studio, sync Gradle, run on a device or emulator.

Book assets are copied from `books/` and `catalog/` on each build (`syncBookAssets`). A committed `catalog/books.json` fallback ships in the APK so the app can start even before the first sync.

### CLI build (optional)

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
cd apps/android && ./gradlew assembleDebug
```

If terminal builds fail on Java 26+, uncomment `org.gradle.java.home` in `apps/android/gradle.properties`.
