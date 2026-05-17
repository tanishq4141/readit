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

**OTA content:** Manuscripts are published to GitLab Generic Package Registry on pushes that change `books/` or `catalog/`. The app syncs a manifest and caches files on disk — you do not need to reinstall the APK when you add or edit chapters.

| Build | Bundled manuscripts | Content updates |
|-------|---------------------|-----------------|
| **Debug** | Full `books/` copied at build (`syncBookAssetsBooks`) | GitLab sync when `readit.content.base.url` is set |
| **Release** | `catalog/books.json` + reader only | GitLab sync required for book text |

Configure GitLab sync in `apps/android/local.properties` (see [`local.properties.example`](apps/android/local.properties.example)):

```properties
readit.content.base.url=https://gitlab.com/api/v4/projects/PROJECT_ID/packages/generic/readit-content/latest/
```

Replace `PROJECT_ID` with your GitLab project ID. CI sets `READIT_CONTENT_BASE_URL` automatically when building the APK on GitLab.

**Private projects:** The app downloads content without credentials. Enable public read access for the package registry, use a public project for content, or accept that OTA sync will not work on a fully private registry without embedding tokens in the APK.

### CLI build (optional)

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
cd apps/android && ./gradlew assembleDebug
```

If terminal builds fail on Java 26+, uncomment `org.gradle.java.home` in `apps/android/gradle.properties`.

## CI (GitLab)

On every push to `main`, GitLab CI runs:

| Job | When | Output |
|-----|------|--------|
| `content:publish` | `books/**` or `catalog/**` changed | Uploads manuscripts to `readit-content/latest/` on the Generic Package Registry |
| `android:apk` | Always on `main` | `dist/readit.apk` — debug build with `CONTENT_BASE_URL` baked in |
| `web:build` | Always on `main` | Production Next.js build (`.next/`) — deploy job will be added when hosting is ready |

Generate the content manifest locally:

```bash
npm run content:manifest
```

Output: `dist/content-manifest.json`

**Install the Android app from CI:** open the pipeline on `main` → `android:apk` → **Browse** artifacts → download `readit.apk`, then install on device (enable “Install unknown apps” for your browser/files app).

To sign release APKs later, add keystore CI variables and switch the pipeline to `assembleRelease` (see comments in `.gitlab-ci.yml`).
