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
exports.ContextProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
class ContextProvider {
    /**
     * Get the content of the currently active editor file.
     */
    getActiveFileContext() {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return null;
        const document = editor.document;
        // Skip untitled or very large files
        if (document.isUntitled || document.lineCount > 500)
            return null;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const relativePath = workspaceFolder
            ? path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath)
            : path.basename(document.uri.fsPath);
        return {
            filename: relativePath,
            content: document.getText(),
            language: document.languageId,
        };
    }
    /**
     * Search for a file in the workspace by name and return its content.
     */
    async getFileByName(query) {
        const pattern = `**/*${query}*`;
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 10);
        if (files.length === 0)
            return null;
        // Prefer exact basename match
        let target = files.find(f => path.basename(f.fsPath).toLowerCase() === query.toLowerCase());
        if (!target) {
            target = files[0];
        }
        try {
            const document = await vscode.workspace.openTextDocument(target);
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            const relativePath = workspaceFolder
                ? path.relative(workspaceFolder.uri.fsPath, target.fsPath)
                : path.basename(target.fsPath);
            return {
                filename: relativePath,
                content: document.getText(),
                language: document.languageId,
            };
        }
        catch {
            return null;
        }
    }
    /**
     * Get a tree view of the workspace structure (max depth 3).
     */
    async getWorkspaceTree() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder)
            return 'No workspace folder open.';
        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 100);
        const relativePaths = files
            .map(f => path.relative(workspaceFolder.uri.fsPath, f.fsPath).replace(/\\/g, '/'))
            .filter(p => p.split('/').length <= 3)
            .sort();
        if (relativePaths.length === 0)
            return 'Workspace is empty.';
        return `Workspace: ${workspaceFolder.name}\n` + relativePaths.map(p => `  ${p}`).join('\n');
    }
    /**
     * Get all readable files inside a folder matching the query name.
     */
    async getFolderContents(query) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }
        const allFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500);
        // Collect unique folder paths (up to depth 3)
        const folders = new Set();
        for (const f of allFiles) {
            const rel = path.relative(workspaceFolder.uri.fsPath, f.fsPath);
            const parts = rel.split(path.sep);
            for (let depth = 1; depth < Math.min(parts.length, 4); depth++) {
                folders.add(parts.slice(0, depth).join(path.sep));
            }
        }
        // Find best matching folder
        const q = query.toLowerCase().replace(/[\\/]/g, path.sep);
        let best = null;
        for (const f of folders) {
            if (f.toLowerCase() === q || f.toLowerCase().endsWith(path.sep + q)) {
                best = f;
                break;
            }
        }
        if (!best) {
            for (const f of folders) {
                if (f.toLowerCase().includes(q)) {
                    best = f;
                    break;
                }
            }
        }
        if (!best) {
            return null;
        }
        const prefix = best + path.sep;
        const matching = allFiles.filter(f => {
            const rel = path.relative(workspaceFolder.uri.fsPath, f.fsPath);
            return rel === best || rel.startsWith(prefix);
        });
        const MAX_FILES = 20;
        const MAX_CHARS = 12000;
        let totalChars = 0;
        const results = [];
        for (const uri of matching.slice(0, MAX_FILES)) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                if (doc.lineCount > 800) {
                    continue;
                }
                const content = doc.getText();
                if (totalChars + content.length > MAX_CHARS) {
                    continue;
                }
                totalChars += content.length;
                results.push({
                    filename: path.relative(workspaceFolder.uri.fsPath, uri.fsPath),
                    content,
                    language: doc.languageId,
                });
            }
            catch {
                continue;
            }
        }
        if (results.length === 0) {
            return null;
        }
        return { folderName: best, files: results };
    }
    /**
     * Build a context string to prepend to the conversation.
     */
    buildContextMessage(fileContext) {
        if (!fileContext)
            return '';
        return [
            `[Active File: ${fileContext.filename}]`,
            '```' + fileContext.language,
            fileContext.content,
            '```',
        ].join('\n');
    }
    buildFolderContextMessage(folderCtx) {
        const blocks = folderCtx.files.map(f => `[File: ${f.filename}]\n\`\`\`${f.language}\n${f.content}\n\`\`\``).join('\n\n');
        return `[Folder: ${folderCtx.folderName}] (${folderCtx.files.length} file${folderCtx.files.length !== 1 ? 's' : ''})\n\n${blocks}`;
    }
}
exports.ContextProvider = ContextProvider;
//# sourceMappingURL=contextProvider.js.map