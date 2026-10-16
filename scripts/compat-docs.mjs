// Adds "Requires Thinger ≥ X" to the TSDoc of a method in a .d.ts, so editors show the server
// version a declared function needs. Used by build.mjs; unit-tested in test/unit/compat-docs.test.ts.
import ts from 'typescript';

const MARK = 'Requires Thinger ≥ ';

/**
 * `text` with the TSDoc of every signature of `className.method` stating `version`, or null when
 * the class is not declared in `text`. Throws when the class has no such method.
 */
export function annotateDeclaration(text, className, method, version) {
    const source = ts.createSourceFile('x.d.ts', text, ts.ScriptTarget.Latest, true);
    const cls = source.statements.find(
        (s) => ts.isClassDeclaration(s) && s.name?.text === className,
    );
    if (!cls) return null;
    const members = cls.members.filter(
        (m) =>
            ts.isMethodDeclaration(m) &&
            m.name &&
            ts.isIdentifier(m.name) &&
            m.name.text === method,
    );
    if (!members.length) throw new Error(`${className}.${method} not found`);

    const edits = [];
    for (const member of members) {
        const start = member.getStart(source);
        const lineStart = text.lastIndexOf('\n', start) + 1;
        const indent = text.slice(lineStart, start);
        const comments = ts.getLeadingCommentRanges(text, member.getFullStart()) || [];
        const doc = [...comments].reverse().find((c) => text.slice(c.pos, c.pos + 3) === '/**');
        if (doc) {
            const body = text.slice(doc.pos, doc.end);
            if (body.includes(MARK)) continue;
            if (!body.includes('\n')) {
                // one-line /** text */ → multi-line
                const inner = body.slice(3, -2).trim();
                const lines = [inner, '', `${MARK}${version}.`, `@since Thinger ${version}`].map(
                    (l) => (l ? `${indent} * ${l}` : `${indent} *`),
                );
                edits.push([doc.pos, doc.end, `/**\n${lines.join('\n')}\n${indent} */`]);
            } else {
                const close = doc.end - 2;
                const lineOfClose = text.lastIndexOf('\n', close) + 1;
                const add = `${indent} *\n${indent} * ${MARK}${version}.\n${indent} * @since Thinger ${version}\n`;
                edits.push([lineOfClose, lineOfClose, add]);
            }
        } else {
            const add = `/**\n${indent} * ${MARK}${version}.\n${indent} * @since Thinger ${version}\n${indent} */\n${indent}`;
            edits.push([start, start, add]);
        }
    }
    let out = text;
    for (const [from, to, insert] of edits.sort((a, b) => b[0] - a[0])) {
        out = out.slice(0, from) + insert + out.slice(to);
    }
    return out;
}
