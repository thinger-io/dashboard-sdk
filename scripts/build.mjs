// Build: ESM + .d.ts (tsc), the classic-script bundle (esbuild), and the compatibility outputs
// derived from the @requiresServer declarations: dist/compat.json and the TSDoc of each function.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { annotateDeclaration } from './compat-docs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = root + 'dist/';
const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));

execFileSync('node', [root + 'scripts/version.mjs'], { stdio: 'inherit' });
rmSync(dist, { recursive: true, force: true });
execFileSync('npx', ['tsc', '-p', root + 'tsconfig.build.json'], { stdio: 'inherit', cwd: root });

// Classic script: defines the global `Thinger`.
const banner = `/*! @thinger-io/dashboard-sdk ${pkg.version} | MIT | https://github.com/thinger-io/dashboard-sdk */`;
for (const minify of [false, true]) {
    await build({
        entryPoints: [dist + 'iife.js'],
        outfile: dist + (minify ? 'thinger-dashboard.min.js' : 'thinger-dashboard.js'),
        bundle: true,
        format: 'iife',
        target: 'es2020',
        platform: 'browser',
        minify,
        sourcemap: minify,
        banner: { js: banner },
        logLevel: 'warning',
    });
}

// the bundle entry is not part of the module API
for (const f of ['iife.js', 'iife.js.map', 'iife.d.ts', 'iife.d.ts.map'])
    rmSync(dist + f, { force: true });

// Compatibility: what each declared function needs, from the declarations themselves.
const { serverRequirements, BASE_SERVER_VERSION } = await import(
    pathToFileURL(dist + 'compat.js').href
);
const { ThingerClient } = await import(pathToFileURL(dist + 'client.js').href);
const requirements = serverRequirements();
writeFileSync(
    dist + 'compat.json',
    JSON.stringify(
        { sdk: pkg.version, baseServer: BASE_SERVER_VERSION, functions: requirements },
        null,
        4,
    ) + '\n',
);

// TSDoc: "Requires Thinger ≥ X" on each declared function, in the .d.ts editors read.
const client = new ThingerClient({ window: null });
const declarations = readdirSync(dist).filter((f) => f.endsWith('.d.ts'));
for (const [name, version] of Object.entries(requirements)) {
    const parts = name.split('.');
    const method = parts.pop();
    let owner = client;
    for (const part of parts) owner = owner?.[part];
    if (!owner || typeof owner[method] !== 'function') {
        throw new Error(`@requiresServer('${name}'): Thinger.${name} is not a function`);
    }
    const className = owner.constructor.name;
    let done = false;
    for (const file of declarations) {
        const text = readFileSync(dist + file, 'utf8');
        const out = annotateDeclaration(text, className, method, version);
        if (out !== null) {
            writeFileSync(dist + file, out);
            done = true;
            break;
        }
    }
    if (!done)
        throw new Error(
            `@requiresServer('${name}'): ${className}.${method} not found in the declarations`,
        );
}

console.log(
    `built ${pkg.name} ${pkg.version}: ESM, .d.ts, thinger-dashboard(.min).js, compat.json (${Object.keys(requirements).length} declared)`,
);
