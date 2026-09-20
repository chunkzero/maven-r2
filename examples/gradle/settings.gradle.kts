rootProject.name = "maven-r2-gradle-example"
include("core", "extra")

if (providers.gradleProperty("downloadRepository").isPresent) {
    include("consumer")
}
