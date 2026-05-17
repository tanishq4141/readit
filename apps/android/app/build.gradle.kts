plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.readit.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.readit.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
}

// apps/android/app → readit repo root (three levels up)
val repoRoot = rootProject.projectDir.parentFile.parentFile

val assetsDir = layout.projectDirectory.dir("src/main/assets")

tasks.register<Copy>("syncBookAssets") {
    description = "Copy books/ and catalog/ from the monorepo into Android assets"
    group = "readit"

    doFirst {
        delete(assetsDir.dir("books"))
        delete(assetsDir.dir("catalog"))
    }

    from(repoRoot.resolve("books")) {
        into("books")
        exclude("**/.claude/**", "**/.git/**", "**/node_modules/**")
    }
    from(repoRoot.resolve("catalog/books.json")) {
        into("catalog")
    }
    into(assetsDir)
}

listOf(
    "preBuild",
    "mergeDebugAssets",
    "mergeReleaseAssets",
).forEach { taskName ->
    tasks.matching { it.name == taskName }.configureEach {
        dependsOn("syncBookAssets")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")

    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.navigation:navigation-compose:2.8.5")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
