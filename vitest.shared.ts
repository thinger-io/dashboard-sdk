import ts from 'typescript';
import type { Plugin } from 'vite';

/**
 * Vite's transformer (oxc) only lowers legacy decorators. Files with the SDK's standard
 * decorators (@requiresServer) go through TypeScript first, as in the published build.
 */
export function standardDecorators(): Plugin {
    return {
        name: 'standard-decorators',
        enforce: 'pre',
        transform(code, id) {
            if (!/\.ts$/.test(id) || !/^\s*@\w+\(/m.test(code)) return null;
            const out = ts.transpileModule(code, {
                fileName: id,
                compilerOptions: {
                    target: ts.ScriptTarget.ES2020,
                    module: ts.ModuleKind.ESNext,
                    sourceMap: true,
                    verbatimModuleSyntax: false,
                },
            });
            return { code: out.outputText, map: out.sourceMapText ?? null };
        },
    };
}
