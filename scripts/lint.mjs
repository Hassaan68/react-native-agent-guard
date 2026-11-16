import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const ROOT_DIR = process.cwd();
const isFormatCheckOnly = process.argv.includes('--format-check');

function collectSourceFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'coverage' ||
      entry.name.startsWith('.')
    ) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, acc);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      acc.push(fullPath);
    }
  }
  return acc;
}

const files = [
  ...collectSourceFiles(path.join(ROOT_DIR, 'src')),
  ...collectSourceFiles(path.join(ROOT_DIR, '__tests__')),
  ...collectSourceFiles(path.join(ROOT_DIR, 'examples')),
  ...collectSourceFiles(path.join(ROOT_DIR, 'example')),
];

const errors = [];

for (const filePath of files) {
  const relPath = path.relative(ROOT_DIR, filePath);
  const content = fs.readFileSync(filePath, 'utf8');

  // 1. Formatting & hygiene checks
  if (content.includes('\r\n')) {
    errors.push(`${relPath}: Contains CRLF line endings (expected LF).`);
  }
  if (content.includes('\t')) {
    errors.push(`${relPath}: Contains tab characters (expected 2-space indentation).`);
  }

  if (isFormatCheckOnly) {
    continue;
  }

  // 2. AST & Security lint checks on src/ files
  const isSrcFile = relPath.startsWith(`src${path.sep}`);
  const scriptKind = filePath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : filePath.endsWith('.ts')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX;

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.ES2022,
    true,
    scriptKind,
  );

  const visit = (node) => {
    if (ts.isDebuggerStatement(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push(`${relPath}:${line + 1} - Unexpected 'debugger' statement (no-debugger).`);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'eval'
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push(`${relPath}:${line + 1} - Forbidden 'eval()' call (no-eval).`);
    }

    if (
      isSrcFile &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Math' &&
      node.expression.name.text === 'random'
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push(
        `${relPath}:${line + 1} - Forbidden 'Math.random()' in src/ security layer; use generateChallengeNonce() (CSPRNG).`,
      );
    }

    if (isSrcFile && node.kind === ts.SyntaxKind.AnyKeyword) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push(
        `${relPath}:${line + 1} - Unexpected 'any' type in src/ (@typescript-eslint/no-explicit-any).`,
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

// 3. If ESLint binary is installed in node_modules/.bin, run it as well
if (!isFormatCheckOnly) {
  const eslintBin = path.join(ROOT_DIR, 'node_modules', '.bin', 'eslint');
  if (fs.existsSync(eslintBin)) {
    const res = spawnSync(eslintBin, ['src', '__tests__'], {
      stdio: 'inherit',
      cwd: ROOT_DIR,
    });
    if (res.status !== 0) {
      process.exit(res.status ?? 1);
    }
  }
}

if (errors.length > 0) {
  console.error('Lint / Format check failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}

console.log(
  isFormatCheckOnly
    ? `Format check passed (${files.length} files verified).`
    : `ESLint & AST security lint passed (${files.length} files verified).`,
);
