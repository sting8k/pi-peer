import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create an isolated temp dir for peer-talk storage artifacts. */
export function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-peer-test-"));
}

export function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

export function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredRenderers: Array<string> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredRenderers,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(type: string) {
        registeredRenderers.push(type);
      },
      registerShortcut() {},
      getAllTools() {
        return [];
      },
    } as any,
  };
}

export function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

/** Extract the import specifiers of a TS source after stripping comments. */
export function importSpecifiers(src: string): string[] {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const specifiers: string[] = [];
  const re = /\b(?:from|import|require)\s*(?:[({]\s*)?["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) specifiers.push(m[1]);
  return specifiers;
}