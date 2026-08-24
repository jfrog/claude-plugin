#!/usr/bin/env node

// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const errors = [];
const warnings = [];

const pluginNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function addError(message) {
  errors.push(message);
}

function addWarning(message) {
  warnings.push(message);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath, context) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    addError(`${context} is missing: ${filePath}`);
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    addError(`${context} contains invalid JSON (${filePath}): ${error.message}`);
    return null;
  }
}

function normalizeNewlines(content) {
  return content.replace(/\r\n/g, "\n");
}

function extractFrontmatterBlock(content) {
  const normalized = normalizeNewlines(content);
  if (!normalized.startsWith("---\n")) {
    return null;
  }
  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    return null;
  }
  return normalized.slice(4, closingIndex);
}

async function validateSkillFile(filePath, pluginName) {
  const content = await fs.readFile(filePath, "utf8");
  const relativeFile = path.relative(repoRoot, filePath);
  const block = extractFrontmatterBlock(content);
  if (!block) {
    addError(`${pluginName}: skill missing YAML frontmatter: ${relativeFile}`);
    return;
  }
  if (!/^name:\s+/m.test(block)) {
    addError(`${pluginName}: skill missing "name" in frontmatter: ${relativeFile}`);
  }
  if (!/^description:\s+/m.test(block)) {
    addError(`${pluginName}: skill missing "description" in frontmatter: ${relativeFile}`);
  }
}

async function validateSkills(pluginDir, pluginName) {
  const skillsDir = path.join(pluginDir, "skills");
  if (!(await pathExists(skillsDir))) {
    addWarning(`${pluginName}: no skills/ directory`);
    return;
  }
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  let foundSkill = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
    if (await pathExists(skillMd)) {
      foundSkill = true;
      await validateSkillFile(skillMd, pluginName);
    }
  }
  if (!foundSkill) {
    addError(`${pluginName}: no skills/*/SKILL.md found under ${path.relative(repoRoot, skillsDir)}`);
  }
}

async function main() {
  const manifestPath = path.join(repoRoot, ".claude-plugin", "plugin.json");
  const pluginManifest = await readJsonFile(manifestPath, "Plugin manifest (.claude-plugin/plugin.json)");
  if (!pluginManifest) {
    summarizeAndExit();
    return;
  }

  const pluginName = pluginManifest.name || "plugin";
  if (typeof pluginManifest.name !== "string" || !pluginNamePattern.test(pluginManifest.name)) {
    addError(
      `"name" in plugin.json must be lowercase and use only alphanumerics, hyphens, and periods.`
    );
  }

  await validateSkills(repoRoot, pluginName);

  summarizeAndExit();
}

function summarizeAndExit() {
  if (warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
    console.log("");
  }

  if (errors.length > 0) {
    console.error("Validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("Validation passed.");
}

await main();
