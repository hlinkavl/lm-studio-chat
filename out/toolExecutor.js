"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolExecutor = void 0;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
class ToolExecutor {
    // ── Workspace boundary guard ──────────────────────────────────────────────
    assertInWorkspace(absPath, wsRoot) {
        const rel = path.relative(wsRoot, absPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`Access denied: path is outside the workspace ("${absPath}").`);
        }
    }
    // ── Shared path resolver (with fuzzy basename fallback) ───────────────────
    async resolveAbsPath(filePath) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        if (path.isAbsolute(filePath)) {
            this.assertInWorkspace(filePath, wsRoot);
            return filePath;
        }
        const candidate = path.join(wsRoot, filePath);
        this.assertInWorkspace(candidate, wsRoot);
        // For any path, try the candidate first
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
            return candidate; // exists, use it
        }
        catch { /* fall through to fuzzy */ }
        // Fuzzy basename search as fallback
        const basename = path.basename(filePath);
        const matches = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 10);
        if (matches.length === 0) {
            throw new Error(`File not found: "${filePath}". Check the workspace tree for the correct path.`);
        }
        if (matches.length === 1) {
            return matches[0].fsPath;
        }
        // If the original path had separators, prefer the match whose relative path ends with it
        const normalized = filePath.replace(/\\/g, '/');
        const exact = matches.find(m => path.relative(wsRoot, m.fsPath).replace(/\\/g, '/') === normalized);
        if (exact) {
            return exact.fsPath;
        }
        const relPaths = matches.map(m => path.relative(wsRoot, m.fsPath).replace(/\\/g, '/'));
        throw new Error(`"${filePath}" is ambiguous — found ${matches.length} files:\n` +
            relPaths.map(p => `  - ${p}`).join('\n') +
            '\nAsk the user which one they meant and retry with the full path.');
    }
    resolveWritePath(filePath) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(wsRoot, filePath);
        this.assertInWorkspace(absPath, wsRoot);
        return absPath;
    }
    async applyFileEdit(filePath, newContent) {
        const absPath = this.resolveWritePath(filePath);
        // Ensure parent directory exists
        const parentUri = vscode.Uri.file(path.dirname(absPath));
        try {
            await vscode.workspace.fs.createDirectory(parentUri);
        }
        catch { /* already exists */ }
        await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), new TextEncoder().encode(newContent));
    }
    async deleteFile(filePath) {
        const absPath = await this.resolveAbsPath(filePath);
        await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { useTrash: true });
    }
    async createDir(dirPath) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        const absPath = path.isAbsolute(dirPath) ? dirPath : path.join(wsRoot, dirPath);
        this.assertInWorkspace(absPath, wsRoot);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(absPath));
    }
    async renameFile(fromPath, toPath) {
        const absFrom = await this.resolveAbsPath(fromPath);
        const absTo = this.resolveWritePath(toPath);
        const toParent = vscode.Uri.file(path.dirname(absTo));
        try {
            await vscode.workspace.fs.createDirectory(toParent);
        }
        catch { /* already exists */ }
        await vscode.workspace.fs.rename(vscode.Uri.file(absFrom), vscode.Uri.file(absTo), { overwrite: false });
    }
    async searchFiles(query, globPattern) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }
        const include = globPattern ? `**/${globPattern}` : '**/*';
        const files = await vscode.workspace.findFiles(include, '**/node_modules/**', 100);
        const lowerQuery = query.toLowerCase();
        const lines = [];
        let matchCount = 0;
        for (const file of files) {
            if (matchCount >= 200) {
                break;
            }
            const ext = file.fsPath.split('.').pop()?.toLowerCase() ?? '';
            if (ToolExecutor.BINARY_EXTENSIONS.has(ext)) {
                continue;
            }
            let raw;
            try {
                raw = await vscode.workspace.fs.readFile(file);
            }
            catch {
                continue;
            }
            const text = new TextDecoder().decode(raw);
            const fileLines = text.split('\n');
            const rel = path.relative(workspaceFolder.uri.fsPath, file.fsPath).replace(/\\/g, '/');
            for (let i = 0; i < fileLines.length; i++) {
                if (fileLines[i].toLowerCase().includes(lowerQuery)) {
                    lines.push(`${rel}:${i + 1}: ${fileLines[i].trimEnd()}`);
                    matchCount++;
                    if (matchCount >= 200) {
                        break;
                    }
                }
            }
        }
        if (lines.length === 0) {
            return `No matches found for "${query}"${globPattern ? ` in ${globPattern}` : ''}.`;
        }
        const result = lines.join('\n');
        return result.length > 6000 ? result.slice(0, 6000) + '\n…(truncated)' : result;
    }
    async runBash(command) {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return new Promise((resolve) => {
            cp.exec(command, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                const raw = [stdout, stderr].filter(Boolean).join('\n');
                const output = raw.length > 4000 ? raw.slice(0, 4000) + '\n…(truncated)' : raw;
                if (err) {
                    const timedOut = err.code === 'ETIMEDOUT' || err.killed;
                    if (timedOut) {
                        resolve({ exitCode: 124, output: `Command timed out after 30s.\n${output}`.trim() });
                        return;
                    }
                    resolve({ exitCode: typeof err.code === 'number' ? err.code : 1, output });
                    return;
                }
                resolve({ exitCode: 0, output });
            });
        });
    }
    async readFile(filePath) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(wsRoot, filePath);
        this.assertInWorkspace(absPath, wsRoot);
        // ── Try exact path first ─────────────────────────────────────────────
        try {
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
            const content = new TextDecoder().decode(raw);
            return content.length > 8000 ? content.slice(0, 8000) + '\n…(truncated)' : content;
        }
        catch {
            // Fall through to fuzzy search
        }
        // ── Fuzzy basename search ────────────────────────────────────────────
        const basename = path.basename(filePath);
        const matches = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 10);
        if (matches.length === 0) {
            throw new Error(`File not found: "${filePath}". Check the workspace tree for the correct path.`);
        }
        // If the original path had separators, prefer an exact relative-path match
        const normalized = filePath.replace(/\\/g, '/');
        const exactMatch = matches.find(m => path.relative(wsRoot, m.fsPath).replace(/\\/g, '/') === normalized) ?? (matches.length === 1 ? matches[0] : null);
        if (exactMatch) {
            const resolvedRel = path.relative(wsRoot, exactMatch.fsPath).replace(/\\/g, '/');
            const raw = await vscode.workspace.fs.readFile(exactMatch);
            const content = new TextDecoder().decode(raw);
            const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n…(truncated)' : content;
            return `[Resolved "${filePath}" → "${resolvedRel}"]\n${truncated}`;
        }
        // Multiple matches — give the model the list so it can ask the user
        const relPaths = matches.map(m => path.relative(wsRoot, m.fsPath).replace(/\\/g, '/'));
        throw new Error(`"${filePath}" is ambiguous — found ${matches.length} files:\n` +
            relPaths.map(p => `  - ${p}`).join('\n') +
            '\nAsk the user which one they meant and retry with the full path.');
    }
    async applyPatch(filePath, search, replace) {
        const absPath = await this.resolveAbsPath(filePath);
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
        const original = new TextDecoder().decode(raw);
        if (!original.includes(search)) {
            throw new Error(`patch_file: search text not found in "${filePath}".\n` +
                `Make sure the <search> block matches the file content exactly (including whitespace).`);
        }
        // Guard against ambiguous patch: if search text appears more than once the replacement is ambiguous
        const firstIdx = original.indexOf(search);
        const secondIdx = original.indexOf(search, firstIdx + 1);
        if (secondIdx !== -1) {
            throw new Error(`patch_file: search text appears multiple times in "${filePath}" — patch is ambiguous.\n` +
                `Expand the <search> block to include more surrounding context so it matches exactly once.`);
        }
        const patched = original.slice(0, firstIdx) + replace + original.slice(firstIdx + search.length);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), new TextEncoder().encode(patched));
    }
    async listDir(dirPath) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        const absPath = path.isAbsolute(dirPath) ? dirPath : path.join(wsRoot, dirPath);
        this.assertInWorkspace(absPath, wsRoot);
        let entries;
        try {
            entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absPath));
        }
        catch {
            throw new Error(`list_dir: directory not found: "${dirPath}"`);
        }
        entries.sort(([aName, aType], [bName, bType]) => {
            // Directories first, then files, then alphabetical
            const aIsDir = aType === vscode.FileType.Directory ? 0 : 1;
            const bIsDir = bType === vscode.FileType.Directory ? 0 : 1;
            return aIsDir - bIsDir || aName.localeCompare(bName);
        });
        const lines = entries.map(([name, type]) => {
            const label = type === vscode.FileType.Directory ? '[dir] ' : '[file]';
            return `${label} ${name}`;
        });
        return `Contents of "${dirPath}":\n${lines.join('\n')}`;
    }
    async computeDiff(filePath, newContent) {
        let oldContent = '';
        try {
            const absPath = await this.resolveAbsPath(filePath);
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
            oldContent = new TextDecoder().decode(raw);
        }
        catch {
            // New file — every line is an addition
            return newContent.split('\n').map(text => ({ type: 'add', text }));
        }
        try {
            return diffLines(oldContent, newContent);
        }
        catch {
            // Fallback if diff algorithm fails for any reason
            return newContent.split('\n').map(text => ({ type: 'add', text }));
        }
    }
}
exports.ToolExecutor = ToolExecutor;
ToolExecutor.BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'tiff',
    'mp3', 'mp4', 'wav', 'ogg', 'flac', 'avi', 'mov', 'mkv', 'webm',
    'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
    'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o', 'a', 'lib',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    'pyc', 'pyo', 'class', 'jar', 'war',
    'db', 'sqlite', 'sqlite3',
    'lock',
]);
// ── Line diff ────────────────────────────────────────────────────────────────
function diffLines(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    // For very large files skip LCS and just show new content
    if (oldLines.length > 500 || newLines.length > 500) {
        const preview = newLines.slice(0, 60).map(t => ({ type: 'add', text: t }));
        if (newLines.length > 60) {
            preview.push({ type: 'ctx', text: `… (${newLines.length - 60} more lines)` });
        }
        return [
            { type: 'ctx', text: `(large file — ${oldLines.length} → ${newLines.length} lines, showing new content)` },
            ...preview,
        ];
    }
    const m = oldLines.length;
    const n = newLines.length;
    // Build LCS DP table
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = oldLines[i - 1] === newLines[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    // Traceback
    const ops = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            ops.unshift({ type: 'ctx', text: oldLines[i - 1] });
            i--;
            j--;
        }
        else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            ops.unshift({ type: 'add', text: newLines[j - 1] });
            j--;
        }
        else {
            ops.unshift({ type: 'del', text: oldLines[i - 1] });
            i--;
        }
    }
    return collapseContext(ops, 3);
}
function collapseContext(ops, ctx) {
    const changed = new Set();
    ops.forEach((op, i) => { if (op.type !== 'ctx') {
        changed.add(i);
    } });
    if (changed.size === 0) {
        return [{ type: 'ctx', text: '(no changes)' }];
    }
    const keep = new Set();
    changed.forEach(idx => {
        for (let k = Math.max(0, idx - ctx); k <= Math.min(ops.length - 1, idx + ctx); k++) {
            keep.add(k);
        }
    });
    const result = [];
    let lastKept = -1;
    for (let i = 0; i < ops.length; i++) {
        if (!keep.has(i)) {
            continue;
        }
        if (lastKept !== -1 && i > lastKept + 1) {
            result.push({ type: 'ctx', text: `… (${i - lastKept - 1} unchanged lines)` });
        }
        result.push(ops[i]);
        lastKept = i;
    }
    return result;
}
//# sourceMappingURL=toolExecutor.js.map