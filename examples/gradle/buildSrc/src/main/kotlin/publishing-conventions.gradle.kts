plugins {
    `java-library`
    `maven-publish`
}

group = "com.example.mavenr2"
version = providers.gradleProperty("publishVersion").orElse("1.0.0").get()

val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(libs.findVersion("java").get().requiredVersion))
    withSourcesJar()
    withJavadocJar()
}

publishing {
    publications {
        create<MavenPublication>("library") {
            from(components["java"])
            pom {
                name.set(project.name)
                description.set("Maven R2 publishing example")
            }
        }
    }
    val endpoint = providers.environmentVariable("MAVEN_R2_URL")
    if (endpoint.isPresent) {
        repositories {
            maven {
                name = "mavenR2"
                url = uri(endpoint.get())
                isAllowInsecureProtocol = true
                credentials {
                    username = providers.environmentVariable("MAVEN_R2_USERNAME").get()
                    password = providers.environmentVariable("MAVEN_R2_PASSWORD").get()
                }
            }
        }
    }
}
