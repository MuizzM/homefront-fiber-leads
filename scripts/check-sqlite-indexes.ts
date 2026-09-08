import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface IndexDefinition {
  file: string;
  line: number;
  name: string;
  signature: string;
  replaces: boolean;
}
export interface IndexInventory {
  definitions: IndexDefinition[];
  errors: string[];
}

// This is a literal-DDL guard, not a SQL evaluator. Preserve string values and
// expression/key order; only whitespace, comments and identifier case normalize.
function tokens(sql: string): string[] {
  const parts = sql.match(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\s+|[\w$]+|[^\s]/g) ?? [];
  return parts.filter(p => !/^\s|^--|^\/\*/.test(p)).map(p => {
    if (p.startsWith("'")) return p;
    if (p.startsWith('"') || p.startsWith("`") || p.startsWith("[")) {
      const identifier = p.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`").toLowerCase();
      return /^[a-z_][\w$]*$/.test(identifier) ? identifier : JSON.stringify(identifier);
    }
    return p.toLowerCase();
  });
}

function readSql(sql: string, file: string, line: number, result: IndexInventory): void {
  if (/CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(sql)
    && (sql.match(/--[^\r\n]*|\/\*[\s\S]*?\*\//g) ?? []).some(comment => comment.includes("\0"))) {
    result.errors.push(`${file}:${line}: interpolation in a SQL comment makes index DDL unreviewable`);
  }
  const all = tokens(sql);
  const dropped = new Set<string>();
  let start = 0;
  for (let end = 0; end <= all.length; end++) {
    if (end < all.length && all[end] !== ";") continue;
    const statement = all.slice(start, end);
    start = end + 1;
    if (statement[0] === "drop" && statement[1] === "index") {
      let at = statement[2] === "if" && statement[3] === "exists" ? 4 : 2;
      let name = statement[at++];
      if (statement[at] === ".") name = name === "main" ? statement[at + 1] : `${name}.${statement[at + 1]}`;
      if (name) dropped.add(name);
      continue;
    }
    if (statement[0] !== "create") continue;
    let at = 1;
    const unique = statement[at] === "unique";
    if (unique) at++;
    if (statement[at] !== "index") {
      if (statement.includes("\0") && statement.slice(0, 5).includes("index")) {
        result.errors.push(`${file}:${line}: dynamic CREATE INDEX needs a literal, reviewable definition`);
      }
      continue;
    }
    at++;
    if (statement.slice(at, at + 3).join(" ") === "if not exists") at += 3;
    let name = statement[at++];
    if (statement[at] === ".") {
      at++;
      const schema = name;
      name = statement[at++];
      if (schema !== "main") name = `${schema}.${name}`;
    }
    if (!name || statement[at] !== "on" || !statement.includes("(") || statement.some(token => token.includes("\0") || token.includes("\\u0000"))) {
      result.errors.push(`${file}:${line}: incomplete or dynamic CREATE INDEX needs a literal, reviewable definition`);
      continue;
    }
    result.definitions.push({ file, line, name, signature: `${unique ? "unique" : "index"} ${statement.slice(at).join(" ")}`, replaces: dropped.has(name) });
  }
}

// Unknown interpolations are a marker, never executed. Static indexes inside a
// template that interpolates unrelated CREATE TABLE defaults remain checkable.
function stringExpression(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map(s => stringExpression(s.expression) + s.literal.text).join("");
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return stringExpression(node.left) + stringExpression(node.right);
  }
  if (ts.isParenthesizedExpression(node)) return stringExpression(node.expression);
  return "\0";
}

export function indexesInSource(file: string, source: string): IndexInventory {
  const result: IndexInventory = { definitions: [], errors: [] };
  if (file.endsWith(".sql")) {
    readSql(source, file, 1, result);
    return result;
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateExpression(node)
      || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      readSql(stringExpression(node), file, tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, result);
      // The enclosing expression owns its literals; do not count its fragments
      // again. SQL returned by a function/variable is outside this check's scope.
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result;
}

const promotionName = "idx_scan_targets_canonical";
const oldSignature = "index on scan_targets ( tenant_id , canonical_key )";
const promotedSignature = "unique on scan_targets ( tenant_id , canonical_key ) where canonical_key is not null";

export function indexConflicts(definitions: IndexDefinition[], requirePromotion = false): string[] {
  const grouped = new Map<string, IndexDefinition[]>();
  for (const d of definitions) grouped.set(d.name, [...(grouped.get(d.name) ?? []), d]);
  const errors: string[] = [];
  let allowedPromotion = false;
  for (const [name, entries] of grouped) {
    if (new Set(entries.map(e => e.signature)).size < 2) continue;
    // The one deliberate replacement drops the old index after a guarded
    // canonical-key audit. Pin both signatures AND owners, not just its name.
    if (name === promotionName && entries.every(e =>
      (e.file === "server/storage.ts" && e.signature === oldSignature)
      || (e.file === "server/scanTargetCanonicalMerge.ts" && e.signature === promotedSignature && e.replaces))) {
      allowedPromotion = true;
      continue;
    }
    errors.push(`conflicting SQLite index ${name}:\n${entries.map(e => `  ${e.file}:${e.line}: ${e.signature}`).join("\n")}`);
  }
  if (requirePromotion && !allowedPromotion) errors.push("canonical-index promotion exception is stale; review and remove/update its exact signatures");
  return errors;
}

export function inspectRepository(root: string): IndexInventory & { files: number } {
  const result: IndexInventory & { files: number } = { definitions: [], errors: [], files: 0 };
  function walk(directory: string): void {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|js|mjs|cjs|sql)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
        result.files++;
        const found = indexesInSource(relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8"));
        result.definitions.push(...found.definitions);
        result.errors.push(...found.errors);
      }
    }
  }
  for (const area of ["server", "shared", "script", "migrations"]) walk(join(root, area));
  result.errors.push(...indexConflicts(result.definitions, true));
  return result;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const root = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(scriptPath), "..");
  const result = inspectRepository(root);
  console.log(`SQLite index check: ${result.definitions.length} literal definitions in ${result.files} files; ${result.errors.length} errors.`);
  console.log("Scope: literal DDL in server/shared/script/migrations; no execution, imported SQL, arbitrary computed SQL or live-schema audit.");
  if (result.errors.length) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  }
}
