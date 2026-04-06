import * as vscode from 'vscode';
import * as path from 'path';

export class ContextProvider {
    /**
     * Get the content of the currently active editor file.
     */
    getActiveFileContext(): { filename: string; content: string; language: string } | null {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return null;

        const document = editor.document;
        // Skip untitled or very large files
        if (document.isUntitled || document.lineCount > 500) return null;

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
    async getFileByName(query: string): Promise<{ filename: string; content: string; language: string } | null> {
        const pattern = `**/*${query}*`;
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 10);

        if (files.length === 0) return null;

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
        } catch {
            return null;
        }
    }

    /**
     * Get a tree view of the workspace structure (max depth 3).
     */
    async getWorkspaceTree(): Promise<string> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return 'No workspace folder open.';

        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 100);
        const relativePaths = files
            .map(f => path.relative(workspaceFolder.uri.fsPath, f.fsPath).replace(/\\/g, '/'))
            .filter(p => p.split('/').length <= 3)
            .sort();

        if (relativePaths.length === 0) return 'Workspace is empty.';

        return `Workspace: ${workspaceFolder.name}\n` + relativePaths.map(p => `  ${p}`).join('\n');
    }

    /**
     * Get all readable files inside a folder matching the query name.
     */
    async getFolderContents(query: string): Promise<{
        folderName: string;
        files: Array<{ filename: string; content: string; language: string }>;
    } | null> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return null; }

        const allFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500);

        // Collect unique folder paths (up to depth 3)
        const folders = new Set<string>();
        for (const f of allFiles) {
            const rel = path.relative(workspaceFolder.uri.fsPath, f.fsPath);
            const parts = rel.split(path.sep);
            for (let depth = 1; depth < Math.min(parts.length, 4); depth++) {
                folders.add(parts.slice(0, depth).join(path.sep));
            }
        }

        // Find best matching folder
        const q = query.toLowerCase().replace(/[\\/]/g, path.sep);
        let best: string | null = null;
        for (const f of folders) {
            if (f.toLowerCase() === q || f.toLowerCase().endsWith(path.sep + q)) {
                best = f;
                break;
            }
        }
        if (!best) {
            for (const f of folders) {
                if (f.toLowerCase().includes(q)) { best = f; break; }
            }
        }
        if (!best) { return null; }

        const prefix = best + path.sep;
        const matching = allFiles.filter(f => {
            const rel = path.relative(workspaceFolder.uri.fsPath, f.fsPath);
            return rel === best || rel.startsWith(prefix);
        });

        const MAX_FILES = 20;
        const MAX_CHARS = 12_000;
        let totalChars = 0;
        const results: Array<{ filename: string; content: string; language: string }> = [];

        for (const uri of matching.slice(0, MAX_FILES)) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                if (doc.lineCount > 800) { continue; }
                const content = doc.getText();
                if (totalChars + content.length > MAX_CHARS) { continue; }
                totalChars += content.length;
                results.push({
                    filename: path.relative(workspaceFolder.uri.fsPath, uri.fsPath),
                    content,
                    language: doc.languageId,
                });
            } catch { continue; }
        }

        if (results.length === 0) { return null; }
        return { folderName: best, files: results };
    }

    /**
     * Build a context string to prepend to the conversation.
     */
    buildContextMessage(fileContext: { filename: string; content: string; language: string } | null): string {
        if (!fileContext) return '';

        return [
            `[Active File: ${fileContext.filename}]`,
            '```' + fileContext.language,
            fileContext.content,
            '```',
        ].join('\n');
    }

    buildFolderContextMessage(folderCtx: {
        folderName: string;
        files: Array<{ filename: string; content: string; language: string }>;
    }): string {
        const blocks = folderCtx.files.map(f =>
            `[File: ${f.filename}]\n\`\`\`${f.language}\n${f.content}\n\`\`\``
        ).join('\n\n');
        return `[Folder: ${folderCtx.folderName}] (${folderCtx.files.length} file${folderCtx.files.length !== 1 ? 's' : ''})\n\n${blocks}`;
    }
}
