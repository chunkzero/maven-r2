plugins { java }

java { toolchain.languageVersion.set(JavaLanguageVersion.of(libs.versions.java.get())) }
repositories {
    maven {
        url = uri(providers.gradleProperty("downloadRepository").get())
        isAllowInsecureProtocol = true
        credentials {
            username = "maven-r2"
            password = providers.environmentVariable("MAVEN_R2_TOKEN").get()
        }
    }
}
val dependencyVersion = providers.gradleProperty("verifyVersion").get()
dependencies {
    implementation("com.example.mavenr2:extra:$dependencyVersion")
    implementation("com.example.mavenr2:maven-library:$dependencyVersion")
}
tasks.register("verifyDownloads") {
    val artifacts = configurations.compileClasspath
    doLast {
        val names = artifacts.get().resolve().map { it.name }
        check(listOf("core-", "extra-", "maven-library-").all { prefix -> names.any { it.startsWith(prefix) } }) {
            "Missing transitive artifacts: $names"
        }
        println("Resolved Gradle and Maven artifacts: $names")
    }
}
