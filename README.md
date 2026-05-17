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

**OTA content:** On pushes that change `books/` or `catalog/`, CI uploads manuscripts to a **public S3 prefix**. The app syncs `content-manifest.json`, caches files on disk, and reads chapters locally — no APK reinstall when you add or edit chapters.

| Build | Bundled manuscripts | Content updates |
|-------|---------------------|-----------------|
| **Debug** | Full `books/` copied at build (`syncBookAssetsBooks`) | S3 sync when `readit.content.base.url` is set |
| **Release** | `catalog/books.json` + reader only | S3 sync for book text |

Configure the content base URL in `apps/android/local.properties` (see [`local.properties.example`](apps/android/local.properties.example)):

```properties
readit.content.base.url=https://YOUR_BUCKET.s3.us-east-1.amazonaws.com/readit/
```

Must end with `/`. Match your bucket, region, and prefix (`readit` by default).

### S3 setup (one-time)

1. Create an S3 bucket and IAM user for CI with `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on `readit/*`.
2. Add a bucket policy so the app can read objects anonymously:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadReaditContent",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR_BUCKET/readit/*"
    }
  ]
}
```

3. Set GitLab CI/CD variables (masked): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `READIT_S3_BUCKET`, `READIT_CONTENT_BASE_URL` (same HTTPS URL as above). Optional: `READIT_S3_PREFIX` (default `readit`).
4. Verify in a browser: `https://YOUR_BUCKET.s3.REGION.amazonaws.com/readit/content-manifest.json` returns JSON (200).

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
| `content:publish` | `books/**` or `catalog/**` changed | Syncs `books/`, `catalog/`, and manifest to S3 |
| `android:apk` | Always on `main` | `dist/readit.apk` — uses `READIT_CONTENT_BASE_URL` from CI variables |
| `web:build` | Always on `main` | Production Next.js build (`.next/`) |

Generate the content manifest locally:

```bash
npm run content:manifest
```

Output: `dist/content-manifest.json`

**Install the Android app from CI:** open the pipeline on `main` → `android:apk` → **Browse** artifacts → download `readit.apk`, then install on device (enable “Install unknown apps” for your browser/files app).

After `content:publish` runs, pull down on the library screen in the app to fetch new chapters.

To sign release APKs later, add keystore CI variables and switch the pipeline to `assembleRelease` (see comments in `.gitlab-ci.yml`).
