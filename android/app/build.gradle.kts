plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// La interfaz es la misma web del repositorio. En vez de duplicarla, se copia
// a los assets al compilar, asi que web y app nunca se desincronizan.
val webRoot = rootProject.projectDir.parentFile

val copyWebAssets by tasks.registering(Copy::class) {
    from(webRoot) {
        include("index.html", "styles.css", "icon.svg", "manifest.webmanifest")
        include("js/**")
        include("data/**")
    }
    into(layout.buildDirectory.dir("generated/webAssets"))
}

android {
    namespace = "com.riderdeck.macropad"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.riderdeck.macropad"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))

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
}

// Las tareas de variante las crea AGP despues de configurar el proyecto, asi
// que hay que engancharse segun aparecen en vez de buscarlas por nombre.
tasks.whenTaskAdded {
    if (name.startsWith("merge") && name.endsWith("Assets")) {
        dependsOn(copyWebAssets)
    }
}
tasks.named("preBuild") { dependsOn(copyWebAssets) }

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}
