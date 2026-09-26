package com.github.continuedev.continueintellijextension.unit

import junit.framework.TestCase
import java.io.File

class JetBrainsIdentityMigrationTest : TestCase() {
    private fun projectFile(path: String): File {
        val userDir = File(System.getProperty("user.dir"))
        val candidates = listOf(
            File(userDir, path),
            File(userDir, "extensions/intellij/$path"),
        )
        return candidates.firstOrNull { it.isFile }
            ?: error("Unable to locate JetBrains project file: $path (user.dir=$userDir)")
    }

    fun `test StamCont presentation preserves compatibility identifiers`() {
        val pluginXml = projectFile("src/main/resources/META-INF/plugin.xml").readText()

        assertTrue(pluginXml.contains("<id>com.github.continuedev.continueintellijextension</id>"))
        assertTrue(pluginXml.contains("<name>StamCont</name>"))
        assertTrue(
            pluginXml.contains(
                "<vendor url=\"https://github.com/SaridakisStamatisChristos/StamCont\">StamCont</vendor>"
            )
        )

        assertTrue(pluginXml.contains("<toolWindow id=\"Continue\""))
        assertTrue(pluginXml.contains("<notificationGroup id=\"Continue\""))
        assertTrue(pluginXml.contains("<inline.completion.provider id=\"Continue\""))
        assertTrue(pluginXml.contains("id=\"ContinuePluginService\""))
        assertTrue(pluginXml.contains("id=\"ContinueSidebarActionsGroup\""))
        assertTrue(pluginXml.contains("id=\"continue.inlineEdit\""))
        assertTrue(pluginXml.contains("id=\"continue.openConfigPage\""))
        assertFalse(pluginXml.contains("id=\"stamcont."))

        assertTrue(pluginXml.contains("displayName=\"StamCont\""))
        assertTrue(pluginXml.contains("text=\"StamCont: Edit Code\""))
        assertTrue(pluginXml.contains("text=\"Reload StamCont Browser\""))
    }

    fun `test persisted settings identity remains readable`() {
        val settings = projectFile(
            "src/main/kotlin/com/github/continuedev/continueintellijextension/services/ContinueExtensionSettingsService.kt"
        ).readText()

        assertTrue(
            settings.contains(
                "name = \"com.github.continuedev.continueintellijextension.services.ContinueExtensionSettings\""
            )
        )
        assertTrue(settings.contains("Storage(\"ContinueExtensionSettings.xml\")"))
        assertTrue(settings.contains("\"StamCont Extension Settings\""))
    }

    fun `test implementation and artifact identities remain compatibility stable`() {
        val gradleProperties = projectFile("gradle.properties").readText()
        val settingsGradle = projectFile("settings.gradle.kts").readText()

        assertTrue(
            gradleProperties.contains(
                "pluginGroup=com.github.continuedev.continueintellijextension"
            )
        )
        assertTrue(
            settingsGradle.contains(
                "rootProject.name = \"continue-intellij-extension\""
            )
        )
    }

    fun `test tool window keeps lookup identity while presenting StamCont title`() {
        val factory = projectFile(
            "src/main/kotlin/com/github/continuedev/continueintellijextension/toolWindow/ContinuePluginToolWindowFactory.kt"
        ).readText()

        assertTrue(factory.contains("toolWindow.setTitle(\"StamCont\")"))
        assertTrue(factory.contains("getAction(\"ContinueSidebarActionsGroup\")"))
    }
}
