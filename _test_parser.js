// Test the lenient parser regexes
function attr(tag, name) {
    const aliases = name === 'path' ? `(?:path|file)` : name;
    const qm = tag.match(new RegExp(`\\b${aliases}\\s*=\\s*["']([^"']+)["']`));
    if (qm) return qm[1];
    const um = tag.match(new RegExp(`\\b${aliases}\\s*=\\s*([^\\s>"']+?)(?=\\s|\\/>|>|$)`));
    return um?.[1];
}

// Test attr() first
console.log('=== attr tests ===');
console.log(attr('<read_file path="src/main.ts"/>', 'path'));     // src/main.ts
console.log(attr('<read_file file="src/main.ts"/>', 'path'));     // src/main.ts
console.log(attr('<read_file path=src/main.ts/>', 'path'));       // src/main.ts
console.log(attr('<read_file  path = "src/main.ts" />', 'path'));// src/main.ts

// Test full regex
const readRe = /<read_file\b[^>]*(?:path|file)\s*=[^>]*(?:\/>|>\s*(?:<\/read_file\s*>)?)/gi;

const tests = [
    ['self-close quoted',       '<read_file path="src/main.ts"/>'],
    ['self-close spaced',       '<read_file path="src/main.ts" />'],
    ['open+close',              '<read_file path="src/main.ts"></read_file>'],
    ['bare close',              '<read_file path="src/main.ts">'],
    ['file= alias',             '<read_file file="src/main.ts"/>'],
    ['unquoted self-close',     '<read_file path=src/main.ts/>'],
    ['unquoted bare',           '<read_file path=src/main.ts>'],
    ['case insensitive',        '<Read_File path="src/main.ts"/>'],
    ['extra spaces',            '<read_file  path = "src/main.ts" />'],
    ['in context',              'Let me read this:\n<read_file path="foo.ts"/>\nDone.'],
    ['with tool_call wrapper',  '<read_file path="bar.js">'],
];

console.log('\n=== full regex tests ===');
for (const [label, input] of tests) {
    readRe.lastIndex = 0;
    const m = readRe.exec(input);
    const p = m ? attr(m[0], 'path') : null;
    console.log(p ? 'PASS' : 'FAIL', '|', label, '->', p || '(no match)');
}
