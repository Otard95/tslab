import * as ts from "typescript";

// TODO: Disallow accessing "module" of Node.js.

const createSourceFileOrig = ts.createSourceFile;

export interface ConvertResult {
  output?: string;
  declOutput?: string;
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  start: number;
  length: number;
  messageText: string;
  category: number;
  code: number;
}

export interface Converter {
  convert(prevDecl: string, src: string): ConvertResult;
  close(): void;
}

const srcFilename = "__tslab__.ts";
const dstFilename = "__tslab__.js";
const dstDeclFilename = "__tslab__.d.ts";
const declFilename = "__prev__.d.ts";

interface RebuildTimer {
  callback: (...args: any[]) => void;
}

export function createConverter(): Converter {
  const srcPrefix = "export {}" + ts.sys.newLine;
  let srcContent: string = "";
  let declContent: string = "";
  let builder: ts.BuilderProgram = null;

  const sys = Object.create(ts.sys) as ts.System;
  let rebuildTimer: RebuildTimer = null;
  sys.setTimeout = (callback: (...args: any[]) => void): any => {
    if (rebuildTimer) {
      throw new Error("Unexpected pending rebuildTimer");
    }
    rebuildTimer = { callback };
    return rebuildTimer;
  };
  sys.clearTimeout = (timeoutId: any) => {
    if (rebuildTimer === timeoutId) {
      rebuildTimer = null;
      return;
    }
    throw new Error("clearing unexpected tiemr");
  };
  sys.readFile = function(path, encoding) {
    if (path === srcFilename) {
      return srcPrefix + srcContent;
    }
    if (path === declFilename) {
      return srcPrefix + declContent;
    }
    return ts.sys.readFile(path, encoding);
  };
  sys.writeFile = function(path, data) {
    throw new Error("writeFile should not be called");
  };
  let notifyUpdateSrc: ts.FileWatcherCallback = null;
  let notifyUpdateDecls: ts.FileWatcherCallback = null;
  sys.watchFile = (path, callback) => {
    if (path === srcFilename) {
      notifyUpdateSrc = callback;
    } else if (path === declFilename) {
      notifyUpdateDecls = callback;
    }
    return {
      close: () => {}
    };
  };
  const host = ts.createWatchCompilerHost(
    [declFilename, srcFilename],
    {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017,
      declaration: true,
      // Remove 'use strict' from outputs.
      noImplicitUseStrict: true
    },
    sys,
    null,
    function(d: ts.Diagnostic) {
      console.log(d.messageText);
    },
    function(d: ts.Diagnostic) {
      // Drop watch status changes.
    }
  );
  host.afterProgramCreate = function(b: ts.BuilderProgram) {
    builder = b;
  };
  const watch = ts.createWatchProgram(host);
  if (!builder) {
    throw new Error("builder is not created");
  }
  return {
    close,
    convert
  };

  function close() {
    watch.close();
  }

  function convert(prevDecl: string, src: string): ConvertResult {
    updateContent(prevDecl, src);
    let program = builder.getProgram();
    let declsFile = builder.getSourceFile(declFilename);
    let srcFile = builder.getSourceFile(srcFilename);

    const locals = (srcFile as any).locals;
    const keys: string[] = [];
    if (locals) {
      locals.forEach((_: any, key: any) => {
        keys.push(key);
      });
    }
    if (keys.length > 0) {
      // Export all local variables.
      // TODO: Disallow "export" in the input.
      const suffix = "\nexport {" + keys.join(", ") + "}";
      updateContent(prevDecl, src + suffix);
      program = builder.getProgram();
      declsFile = builder.getSourceFile(declFilename);
      srcFile = builder.getSourceFile(srcFilename);
    }
    srcFile.parent = declsFile;

    let output: string;
    let declOutput: string;
    builder.emit(
      srcFile,
      (fileName: string, data: string) => {
        if (fileName === dstFilename) {
          output = data;
        } else if (fileName === dstDeclFilename) {
          declOutput = data;
        }
      },
      undefined,
      undefined,
      getCustomTransformers()
    );
    return {
      output,
      declOutput,
      diagnostics: convertDiagnostics(
        srcPrefix.length,
        ts.getPreEmitDiagnostics(program, srcFile)
      )
    };
  }

  function updateContent(decls: string, src: string) {
    declContent = decls;
    srcContent = src;
    builder = null;
    // TODO: Notify updates only when src is really updated,
    // unless there is another cache layer in watcher API.
    notifyUpdateSrc(srcFilename, ts.FileWatcherEventKind.Changed);
    notifyUpdateDecls(declFilename, ts.FileWatcherEventKind.Changed);
    if (!rebuildTimer) {
      throw new Error("rebuildTimer is not set properly");
    }
    rebuildTimer.callback();
    rebuildTimer = null;
    if (!builder) {
      throw new Error("builder is not recreated");
    }
  }

  function convertDiagnostics(
    offset: number,
    input: readonly ts.Diagnostic[]
  ): Diagnostic[] {
    const ret: Diagnostic[] = [];
    for (const d of input) {
      if (!d.file || d.file.fileName !== "__tslab__.ts") {
        continue;
      }
      if (typeof d.messageText === "string") {
        ret.push({
          start: d.start - offset,
          length: d.length,
          messageText: d.messageText.toString(),
          category: d.category,
          code: d.code
        });
        continue;
      }
      traverseDiagnosticMessageChain(
        d.start - offset,
        d.length,
        d.messageText,
        ret
      );
    }
    return ret;
  }

  function traverseDiagnosticMessageChain(
    start: number,
    length: number,
    msg: ts.DiagnosticMessageChain,
    out: Diagnostic[]
  ) {
    out.push({
      start,
      length,
      messageText: msg.messageText,
      category: msg.category,
      code: msg.code
    });
    if (!msg.next) {
      return;
    }
    for (const child of msg.next) {
      traverseDiagnosticMessageChain(start, length, child, out);
    }
  }

  function getCustomTransformers(): ts.CustomTransformers {
    return {
      after: [after],
      afterDeclarations: [afterDeclarations]
    };
    function after(
      context: ts.TransformationContext
    ): (node: ts.SourceFile) => ts.SourceFile {
      return (node: ts.SourceFile) => {
        // Delete Object.defineProperty(exports, \"__esModule\", { value: true });
        node.statements = ts.createNodeArray(node.statements.slice(1));
        return node;
      };
    }
    function afterDeclarations(
      context: ts.TransformationContext
    ): (node: ts.SourceFile) => ts.SourceFile {
      // Delete all exports { ... }
      return (node: ts.SourceFile) => {
        const statements = [];
        for (const stmt of node.statements) {
          if (ts.isExportDeclaration(stmt)) {
            continue;
          }
          statements.push(stmt);
        }
        node.statements = ts.createNodeArray(statements);
        return node;
      };
    }
  }
}
