#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const exampleRoot = path.resolve(__dirname, '..');
const expectedRiffRoot = path.resolve(exampleRoot, '..');
const installedRiff = path.resolve(exampleRoot, 'node_modules', 'riff');

function fail(message) {
  console.error(`[riff-link-check] ERROR: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(installedRiff)) {
  fail(`Missing ${installedRiff}. Run "yarn install" in example root.`);
}

const installedPkgPath = path.join(installedRiff, 'package.json');
if (!fs.existsSync(installedPkgPath)) {
  fail(`Missing ${installedPkgPath}. node_modules/riff is not a valid package.`);
}

const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf8'));
if (installedPkg.name !== 'riff') {
  fail(`Expected package name "riff", got "${installedPkg.name}".`);
}

const resolvedInstalled = fs.realpathSync(installedRiff);
const resolvedExpected = fs.realpathSync(expectedRiffRoot);
if (resolvedInstalled !== resolvedExpected) {
  fail(
    [
      'example/node_modules/riff does not point to local library source.',
      `resolved installed: ${resolvedInstalled}`,
      `resolved expected:  ${resolvedExpected}`,
      'Run: yarn sync:riff',
    ].join('\n')
  );
}

const sentinel = path.join(installedRiff, 'cpp', 'CollectionViewContainerShadowNode.cpp');
if (!fs.existsSync(sentinel)) {
  fail(`Missing sentinel source file: ${sentinel}`);
}

console.log(`[riff-link-check] OK: node_modules/riff -> ${resolvedInstalled}`);
