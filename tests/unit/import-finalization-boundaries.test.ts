import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve("src");
const service = path.resolve(root, "server/services/published-dataset-import-finalization.ts");
const factory = path.resolve(root, "server/database/import-finalizer-client.ts");

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? files(name) : /\.tsx?$/.test(name) ? [name] : [];
  });
}

function imports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const result: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      result.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) result.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

function reachable(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const specifier of imports(entry)) {
    const base = specifier.startsWith("@/")
      ? path.join(root, specifier.slice(2))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(entry), specifier)
        : undefined;
    if (!base) continue;
    const target = [base + ".ts", base + ".tsx", path.join(base, "index.ts")].find(existsSync);
    if (target) reachable(target, seen);
  }
  return seen;
}

describe("internal finalization import boundaries", () => {
  it("marks both privileged entry modules server-only", () => {
    expect(imports(service)).toContain("server-only");
    expect(imports(factory)).toContain("server-only");
  });

  it("has no public route, server action, or client import path to the finalizer", () => {
    for (const file of files(root)) {
      const content = readFileSync(file, "utf8");
      if (path.basename(file) === "route.ts" || /^\s*["']use (client|server)["']/m.test(content)) {
        const dependencies = reachable(file);
        // Phase 4 adds only a JWT-protected internal control-plane endpoint.
        if (file.replaceAll("\\", "/").includes("/api/internal/executions/")) {
          expect(content).toContain("getServiceTokenVerifier");
          expect(content).toContain('"execution.finalize"');
          expect(content.indexOf(".verify(")).toBeLessThan(content.indexOf("new ExecutionService"));
          continue;
        }
        expect(dependencies.has(service), file).toBe(false);
        expect(dependencies.has(factory), file).toBe(false);
        if (/^\s*["']use client["']/m.test(content)) {
          expect(dependencies.has(path.resolve(root, "server/config/env.ts")), file).toBe(false);
        }
      }
    }
  });

  it("does not reach publication storage or transport modules", () => {
    const dependencies = reachable(service);
    for (const file of dependencies) {
      expect(file.replaceAll("\\", "/")).not.toMatch(/integrations\/storage|server\/storage/);
      expect(imports(file).join("\n")).not.toMatch(/@aws-sdk|presigner/);
    }
    expect(readFileSync(service, "utf8")).not.toMatch(/\bfetch\s*\(|\bgetDb\s*\(/);
    expect(readFileSync(factory, "utf8")).not.toMatch(
      /env\.DATABASE_URL|\bgetDb\s*\(|\bcreateDbClient\s*\(/
    );
  });
});
