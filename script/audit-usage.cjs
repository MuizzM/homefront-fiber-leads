// Read-only inventory: node script/audit-usage.cjs /tmp/homefront-usage.json
// Names and locations only; environment values are never included.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const output = process.argv[2];
if (!output) {
  console.error('Usage: node script/audit-usage.cjs <output.json>');
  process.exit(2);
}

const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean);
const tracked = [...new Set(listed)].filter(file => fs.existsSync(path.join(root, file)));
const sourcePaths = tracked.filter(file => /\.(?:[cm]?js|tsx?)$/.test(file));
const files = Object.fromEntries(sourcePaths.map(file => [file, {
  imports: [], exports: [], incoming: [], dynamicImports: [], envReads: [],
}]));
const identifierSites = new Map();
const routes = [];
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'use']);

function resolveModule(from, specifier) {
  let base;
  if (specifier.startsWith('@/')) base = 'client/src/' + specifier.slice(2);
  else if (specifier.startsWith('@shared/')) base = 'shared/' + specifier.slice(8);
  else if (specifier.startsWith('.')) base = path.join(path.dirname(from), specifier);
  else return null;
  return [base, base + '.ts', base + '.tsx', base + '.js', base + '/index.ts',
    base + '/index.tsx', base.replace(/\.js$/, '.ts')].find(file => files[file]) ?? null;
}

function bindingNames(node) {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    return node.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(element.name) : []);
  }
  return [];
}

for (const file of sourcePaths) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const data = files[file];
  const lineOf = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  function addImport(node, specifier, names, kind) {
    const target = resolveModule(file, specifier);
    const entry = { source: specifier, target, line: lineOf(node), names, kind };
    data.imports.push(entry);
    if (target) files[target].incoming.push({ file, line: entry.line, names, kind });
  }
  function visit(node) {
    if (ts.isIdentifier(node)) {
      const sites = identifierSites.get(node.text) ?? [];
      sites.push({ file, line: lineOf(node) });
      identifierSites.set(node.text, sites);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names = clause?.name ? ['default'] : [];
      const bindings = clause?.namedBindings;
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) names.push('*');
        else names.push(...bindings.elements.map(element => (element.propertyName ?? element.name).text));
      }
      addImport(node, node.moduleSpecifier.text, names, clause?.isTypeOnly ? 'type-import' : 'import');
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map(element => (element.propertyName ?? element.name).text) : ['*'];
      addImport(node, node.moduleSpecifier.text, names, 'reexport');
    }
    if (ts.isCallExpression(node)) {
      const argument = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') {
        if (argument && ts.isStringLiteral(argument)) {
          let host = node.parent;
          if (ts.isAwaitExpression(host)) host = host.parent;
          const names = ts.isVariableDeclaration(host) && ts.isObjectBindingPattern(host.name)
            ? host.name.elements.map(element => (element.propertyName ?? element.name).getText(source)) : ['*'];
          addImport(node, argument.text, names, 'dynamic-import');
        } else {
          data.dynamicImports.push({ line: lineOf(node), expression: node.getText(source).slice(0, 200) });
        }
      }
      if (file.startsWith('server/') && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const owner = node.expression.expression.getText(source);
        if (['app', 'router'].includes(owner) && HTTP_METHODS.has(method) && argument && ts.isStringLiteral(argument)) {
          routes.push({ file, line: lineOf(node), method, path: argument.text });
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'process.env') {
      data.envReads.push({ name: node.name.text, line: lineOf(node) });
    }
    if (ts.isElementAccessExpression(node) && node.expression.getText(source) === 'process.env') {
      const literal = ts.isStringLiteral(node.argumentExpression);
      data.envReads.push({ name: literal ? node.argumentExpression.text : null, line: lineOf(node), dynamic: !literal });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const node of source.statements) {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : [];
    if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    const names = isDefault ? ['default'] : ts.isVariableStatement(node)
      ? node.declarationList.declarations.flatMap(declaration => bindingNames(declaration.name))
      : node.name ? [node.name.text] : [];
    for (const name of names) {
      data.exports.push({ name, line: lineOf(node), kind: ts.SyntaxKind[node.kind],
        typeOnly: ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) });
    }
  }
}

for (const data of Object.values(files)) {
  for (const exported of data.exports) {
    exported.importSites = data.incoming.filter(entry => entry.names.includes(exported.name) || entry.names.includes('*'));
    exported.identifierSites = identifierSites.get(exported.name) ?? [];
  }
}
const environment = new Map();
function ensureEnv(name) {
  if (!environment.has(name)) environment.set(name, { name, codeReads: [], mentions: [] });
  return environment.get(name);
}
for (const [file, data] of Object.entries(files)) {
  for (const read of data.envReads) {
    if (read.name) ensureEnv(read.name).codeReads.push({ file, line: read.line });
  }
}
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const envExampleNames = [...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=/gm)].map(match => match[1]);
for (const name of envExampleNames) ensureEnv(name);
for (const file of tracked) {
  if (!/\.(?:md|json|toml|ya?ml|ts|tsx|js|mjs|cjs|sh|py|example)$/.test(file)) continue;
  if (/package-lock|^data\/|^\.claude\//.test(file) || path.resolve(root, file) === path.resolve(output)) continue;
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    const names = new Set([...line.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)].map(match => match[0]));
    for (const name of names) environment.get(name)?.mentions.push({ file, line: index + 1 });
  });
}
const inventory = {
  root, generatedAt: new Date().toISOString(),
  notes: [
    'Static references identify candidates, never prove dead code. Include documented CLI and external API consumers in manual review.',
    'Literal dynamic imports are included; computed imports, env aliases and dynamic env keys need manual review.',
    'Wildcard import sites conservatively include every export; lexical identifier sites can include unrelated same-name symbols.',
    'Environment inventory contains names and locations only, never values. Route inventory covers literal app/router declarations.',
  ],
  files, routes, environment: [...environment.values()], envExampleNames,
};
fs.writeFileSync(output, JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ output, files: sourcePaths.length, routes: routes.length,
  exports: Object.values(files).reduce((total, data) => total + data.exports.length, 0), envNames: environment.size }));
