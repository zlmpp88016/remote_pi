import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing — loaded from android/key.properties when present.
// If the file is missing (CI without secrets, fresh clone for debug-only
// work), release builds fall back to the debug keys so `flutter run
// --release` still works locally without forcing every contributor to
// configure signing.
val keystoreProperties = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) {
        load(FileInputStream(f))
    }
}
val hasReleaseKeystore = keystoreProperties.getProperty("storeFile") != null

// Plan 86 #46 — OPT-IN isolated verification identity.
//
// Passing `-PremotePiHistoryVerification=true` (from the Flutter tool:
// `--android-project-arg=remotePiHistoryVerification=true`) appends the FIXED
// `.p86` suffix to the DEBUG and PROFILE application ids, so the verification
// build installs side by side with the shipped app and cannot touch its
// pairing / Hive / Block-Store state (all of which is keyed by the package
// name). Same rationale as `clients/desktop/android/app/build.gradle.kts`.
//
// Opt-in by construction, three properties worth keeping:
//   * property absent (or anything other than `true`) ⇒ both identifiers are
//     byte-identical to today's `com.example.remotepi`;
//   * RELEASE is never suffixed — a store artifact must not carry `.p86`;
//   * the suffix is fixed, not derived from a branch/SHA, so device scripts can
//     hardcode the package name.
//
// `namespace` (and therefore the activity class and the R/BuildConfig package)
// stays `com.example.remotepi`: only the install identity changes.
val historyVerificationId =
    (project.findProperty("remotePiHistoryVerification") as String?)?.toBoolean() == true
val historyVerificationSuffix =
    (project.findProperty("remotePiHistoryVerificationSuffix") as String?) ?: "p86"
if (historyVerificationId && historyVerificationSuffix !in setOf("p86", "p90")) {
    throw GradleException("unsupported isolated verification suffix")
}

android {
    namespace = "com.example.remotepi"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "com.example.remotepi"
        // plan/23 § "Versão mínima Android" — the remote_pi_identity
        // plugin requires API 34 (Block Store + modern biometry), so
        // the app inherits the same floor. Bump intentional, recorded
        // in the plano.
        minSdk = 34
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
            }
        }
    }

    buildTypes {
        if (historyVerificationId) {
            // The Flutter Gradle plugin creates `profile` in its own apply()
            // (with `initWith(debug)`), i.e. BEFORE this block runs — that copy
            // is by value, so an id set only on `debug` would NOT reach the
            // profile variant. Both variants are therefore set explicitly.
            // (`getByName` — not `maybeCreate` — because the plugin guarantees
            // `profile` exists; a missing one must fail the opt-in build loudly
            // instead of silently producing an unsuffixed APK.)
            getByName("debug").applicationIdSuffix = ".$historyVerificationSuffix"
            getByName("profile").applicationIdSuffix = ".$historyVerificationSuffix"
        }
        release {
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    // 16 KB page-size compliance (Google Play, enforced since Nov 2025).
    // mobile_scanner 5.2.3 pulls ML Kit + CameraX whose prebuilt native libs
    // are only 4 KB-aligned (libbarhopper_v3.so, libimage_processing_util_jni.so),
    // which Play now rejects. Force the newer, 16 KB-aligned releases — Gradle
    // version-conflict resolution picks these over mobile_scanner's transitive
    // 17.2.0 / 1.3.3. No Dart-side scanner API change. CameraX modules are kept
    // on one matching version to avoid cross-module runtime mismatches.
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
}
