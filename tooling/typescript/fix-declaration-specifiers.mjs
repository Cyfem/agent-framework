#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const DECLARATION_FILE_PATTERN = /\.d\.(?:c|m)?ts$/u;
const DECLARATION_MAP_PATTERN = /\.d\.(?:c|m)?ts\.map$/u;
const NODE_RUNTIME_EXTENSION_PATTERN = /\.(?:cjs|js|json|jsx|mjs|node)$/iu;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function isFile(filePath) {
  return (await stat(filePath).catch(() => null))?.isFile() === true;
}

async function collectDeclarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDeclarationFiles(entryPath)));
    } else if (entry.isFile() && DECLARATION_FILE_PATTERN.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function collectDeclarationMaps(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDeclarationMaps(entryPath)));
    } else if (entry.isFile() && DECLARATION_MAP_PATTERN.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function collectModuleSpecifiers(sourceFile) {
  const literals = [];
  const addLiteral = (node) => {
    if (node && ts.isStringLiteral(node)) literals.push(node);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addLiteral(node.argument.literal);
    } else if (ts.isModuleDeclaration(node)) {
      addLiteral(node.name);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return literals;
}

function isRelativeSpecifier(specifier) {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

async function resolveNodeNextSpecifier(declarationPath, specifier) {
  if (!isRelativeSpecifier(specifier) || NODE_RUNTIME_EXTENSION_PATTERN.test(specifier)) {
    return specifier;
  }

  assert(
    !specifier.includes('?') && !specifier.includes('#'),
    `${declarationPath}: relative declaration specifier cannot contain a query or fragment: ${specifier}`,
  );

  const target = path.resolve(path.dirname(declarationPath), specifier);
  const candidates = [
    { declaration: `${target}.d.ts`, specifier: `${specifier}.js` },
    { declaration: `${target}.d.mts`, specifier: `${specifier}.mjs` },
    { declaration: `${target}.d.cts`, specifier: `${specifier}.cjs` },
    { declaration: path.join(target, 'index.d.ts'), specifier: `${specifier}/index.js` },
    { declaration: path.join(target, 'index.d.mts'), specifier: `${specifier}/index.mjs` },
    { declaration: path.join(target, 'index.d.cts'), specifier: `${specifier}/index.cjs` },
  ];
  const matches = [];
  for (const candidate of candidates) {
    if (await isFile(candidate.declaration)) matches.push(candidate);
  }

  assert(
    matches.length > 0,
    `${declarationPath}: cannot resolve relative declaration specifier: ${specifier}`,
  );
  assert(
    matches.length === 1,
    `${declarationPath}: relative declaration specifier is ambiguous: ${specifier}`,
  );
  return matches[0].specifier;
}

export async function fixDeclarationSpecifiers(directory) {
  const resolvedDirectory = path.resolve(directory);
  assert(
    (await stat(resolvedDirectory).catch(() => null))?.isDirectory() === true,
    `declaration directory does not exist: ${resolvedDirectory}`,
  );

  const files = await collectDeclarationFiles(resolvedDirectory);
  assert(files.length > 0, `no declaration files found in ${resolvedDirectory}`);
  const declarationMaps = await collectDeclarationMaps(resolvedDirectory);
  assert(
    declarationMaps.length === 0,
    'declaration maps are not supported because rewritten specifiers would invalidate their mappings',
  );

  let changedFiles = 0;
  let changedSpecifiers = 0;
  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    assert(
      sourceFile.parseDiagnostics.length === 0,
      `${filePath}: emitted declaration contains TypeScript parse errors`,
    );

    const replacements = [];
    for (const literal of collectModuleSpecifiers(sourceFile)) {
      const nextSpecifier = await resolveNodeNextSpecifier(filePath, literal.text);
      if (nextSpecifier === literal.text) continue;
      replacements.push({
        end: literal.getEnd(),
        replacement: JSON.stringify(nextSpecifier),
        start: literal.getStart(sourceFile),
      });
    }

    if (replacements.length === 0) continue;
    let rewritten = source;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
      rewritten =
        rewritten.slice(0, replacement.start) +
        replacement.replacement +
        rewritten.slice(replacement.end);
    }
    await writeFile(filePath, rewritten, 'utf8');
    changedFiles += 1;
    changedSpecifiers += replacements.length;
  }

  return { changedFiles, changedSpecifiers, directory: resolvedDirectory, files: files.length };
}

async function main(argv = process.argv.slice(2)) {
  assert(argv.length === 1, 'usage: fix-declaration-specifiers.mjs <declaration-directory>');
  return fixDeclarationSpecifiers(argv[0]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
  } catch (error) {
    process.stderr.write(
      `[declaration specifiers] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
