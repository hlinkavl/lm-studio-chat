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
exports.ChatViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const lmStudioClient_js_1 = require("./lmStudioClient.js");
const contextProvider_js_1 = require("./contextProvider.js");
const toolExecutor_js_1 = require("./toolExecutor.js");
class ChatViewProvider {
    constructor(extensionUri, context) {
        this.extensionUri = extensionUri;
        this.context = context;
        this.conversationHistory = [];
        this.pendingTools = new Map();
        this.toolIterations = 0;
        this.isProcessingTools = false;
        this.currentModel = '';
        this.client = new lmStudioClient_js_1.LmStudioClient();
        this.contextProvider = new contextProvider_js_1.ContextProvider();
        this.toolExecutor = new toolExecutor_js_1.ToolExecutor();
        this.workspaceMode = true; // workspace context is always active
        this.permissionMode = context.globalState.get('permissionMode', 'ask');
        this.shellEnabled = context.globalState.get('shellEnabled', false);
        const savedHistory = context.globalState.get('chatHistory', []);
        this.conversationHistory = savedHistory;
    }
    resolveWebviewView(webviewView, _context, _token) {
        this.webviewView = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webviewView.webview.html = this.getWebviewContent();
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'sendMessage':
                    await this.handleUserMessage(message.text);
                    break;
                case 'stopGeneration':
                    this.client.abort();
                    break;
                case 'checkHealth':
                    await this.handleHealthCheck();
                    break;
                case 'updateSystemPrompt': {
                    const config = vscode.workspace.getConfiguration('lmStudioChat');
                    await config.update('systemPrompt', message.text, vscode.ConfigurationTarget.Global);
                    break;
                }
                case 'openSettings':
                case 'changeEndpoint':
                    await vscode.commands.executeCommand('lmStudioChat.setEndpoint');
                    break;
                case 'selectModel':
                    await this.showModelPicker();
                    break;
                case 'newChat':
                    this.resetConversation();
                    break;
                case 'ready':
                    if (this.conversationHistory.length > 0) {
                        this.webviewView?.webview.postMessage({
                            type: 'loadHistory',
                            history: this.conversationHistory,
                        });
                    }
                    await this.handleHealthCheck();
                    this.sendCurrentConfig();
                    this.sendWorkspaceStatus();
                    this.sendPermissionStatus();
                    this.sendShellStatus();
                    break;
                case 'toggleWorkspace':
                    // Do nothing, just keep workspace status showing
                    this.sendWorkspaceStatus();
                    break;
                case 'toggleShell': {
                    this.shellEnabled = !this.shellEnabled;
                    this.context.globalState.update('shellEnabled', this.shellEnabled);
                    this.sendShellStatus();
                    break;
                }
                case 'cyclePermission': {
                    const modes = ['ask', 'edit'];
                    const next = modes[(modes.indexOf(this.permissionMode) + 1) % 2];
                    this.permissionMode = next;
                    this.context.globalState.update('permissionMode', this.permissionMode);
                    this.sendPermissionStatus();
                    break;
                }
                case 'approveTool': {
                    const tool = this.pendingTools.get(message.id);
                    if (!tool) {
                        break;
                    }
                    this.pendingTools.delete(message.id);
                    if (tool.type === 'edit') {
                        try {
                            await this.toolExecutor.applyFileEdit(tool.path, tool.newContent);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: true });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: write_file "${tool.path}"]\nSuccess: file written.` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                        catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: write_file "${tool.path}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    }
                    else if (tool.type === 'patch') {
                        try {
                            await this.toolExecutor.applyPatch(tool.path, tool.search, tool.replace);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: true });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: patch_file "${tool.path}"]\nSuccess: patch applied.` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                        catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: patch_file "${tool.path}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    }
                    else if (tool.type === 'bash') {
                        try {
                            const result = await this.toolExecutor.runBash(tool.command);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: result.exitCode === 0, output: result.output });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: run_bash]\nExit code: ${result.exitCode}\n${result.output}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                        catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: run_bash]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    }
                    else if (tool.type === 'delete') {
                        try {
                            await this.toolExecutor.deleteFile(tool.path);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: true });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: delete_file "${tool.path}"]\nSuccess: file deleted.` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                        catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: delete_file "${tool.path}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    }
                    else if (tool.type === 'mkdir') {
                        try {
                            await this.toolExecutor.createDir(tool.path);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: true });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: create_dir "${tool.path}"]\nSuccess: directory created.` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                        catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: create_dir "${tool.path}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    }
                    else if (tool.type === 'rename') {
                        try {
                            await this.toolExecutor.renameFile(tool.from, tool.to);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: true });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: rename_file "${tool.from}" → "${tool.to}"]\nSuccess: file renamed.` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                        catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: rename_file "${tool.from}" → "${tool.to}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    }
                    break;
                }
                case 'rejectTool':
                    this.pendingTools.delete(message.id);
                    this.webviewView?.webview.postMessage({
                        type: 'toolResult', id: message.id, skipped: true,
                    });
                    break;
                case 'denyTool': {
                    const tool = this.pendingTools.get(message.id);
                    if (!tool) {
                        break;
                    }
                    this.pendingTools.delete(message.id);
                    // Build a human-readable description of what was denied
                    const denyDesc = tool.type === 'edit' ? `editing file "${tool.path}"`
                        : tool.type === 'patch' ? `patching file "${tool.path}"`
                            : tool.type === 'delete' ? `deleting file "${tool.path}"`
                                : tool.type === 'mkdir' ? `creating directory "${tool.path}"`
                                    : tool.type === 'rename' ? `renaming "${tool.from}" to "${tool.to}"`
                                        : `running command: ${tool.command}`;
                    this.webviewView?.webview.postMessage({
                        type: 'toolResult', id: message.id, denied: true,
                        denyReason: denyDesc,
                    });
                    // Push a strong memory entry so the model doesn't retry
                    this.conversationHistory.push({
                        role: 'user',
                        content: `[SYSTEM — ACCESS DENIED]\nThe user explicitly denied your request for ${denyDesc}.\nDo NOT attempt this action again in this session. Acknowledge the restriction and ask the user what they would like you to do instead.`,
                    });
                    this.saveHistory();
                    this.continueAfterToolResult();
                    break;
                }
            }
        });
    }
    // ── State helpers ────────────────────────────────────────────────────────
    saveHistory() {
        this.context.globalState.update('chatHistory', this.conversationHistory);
    }
    sendWorkspaceStatus() {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        this.webviewView?.webview.postMessage({
            type: 'workspaceStatus',
            active: this.workspaceMode,
            path: wsFolder?.uri.fsPath ?? null,
        });
    }
    sendPermissionStatus() {
        this.webviewView?.webview.postMessage({
            type: 'permissionStatus',
            mode: this.permissionMode,
        });
    }
    sendShellStatus() {
        this.webviewView?.webview.postMessage({
            type: 'shellStatus',
            enabled: this.shellEnabled,
        });
    }
    resetConversation() {
        this.conversationHistory = [];
        this.pendingTools.clear();
        this.toolIterations = 0;
        this.isProcessingTools = false;
        this.saveHistory();
        this.webviewView?.webview.postMessage({ type: 'reset' });
        vscode.window.showInformationMessage('LM Studio Chat: Conversation cleared');
    }
    async refreshHealthCheck() {
        await this.handleHealthCheck();
        this.sendCurrentConfig();
    }
    sendCurrentConfig() {
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        this.webviewView?.webview.postMessage({
            type: 'configUpdate',
            endpoint: config.get('endpoint', 'http://127.0.0.1:1234'),
            model: config.get('model', ''),
            systemPrompt: config.get('systemPrompt', ''),
        });
    }
    async showModelPicker() {
        const models = await this.client.fetchModels();
        if (models.length === 0) {
            vscode.window.showWarningMessage('No models available. Is LM Studio running?');
            return;
        }
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        const currentModel = config.get('model', '');
        const items = [
            {
                label: '$(sparkle) Auto (use loaded model)',
                description: currentModel === '' ? '(current)' : '',
                detail: 'Let LM Studio decide which model to use',
            },
            ...models.map(m => ({
                label: m,
                description: m === currentModel ? '(current)' : '',
            })),
        ];
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a model to chat with',
            title: 'LM Studio — Select Model',
        });
        if (!selected) {
            return;
        }
        const newModel = selected.label.startsWith('$(sparkle)') ? '' : selected.label;
        await config.update('model', newModel, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Model set to: ${newModel || 'Auto'}`);
        await this.handleHealthCheck();
        this.sendCurrentConfig();
    }
    async handleHealthCheck() {
        const health = await this.client.checkHealth();
        if (health.ok && health.models?.length) {
            const config = vscode.workspace.getConfiguration('lmStudioChat');
            const configured = config.get('model', '');
            this.currentModel = configured || health.models[0];
        }
        this.webviewView?.webview.postMessage({
            type: 'healthStatus',
            ok: health.ok, models: health.models, error: health.error,
        });
    }
    // ── User message handler ─────────────────────────────────────────────────
    async handleUserMessage(text) {
        if (!this.webviewView) {
            return;
        }
        // Reset per-turn tool iteration counter
        this.toolIterations = 0;
        // Build messages array
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        let systemPrompt = config.get('systemPrompt', '');
        // Inject workspace tree when workspace mode is on
        if (this.workspaceMode) {
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            const wsPath = wsFolder?.uri.fsPath ?? '(no workspace)';
            const tree = await this.contextProvider.getWorkspaceTree();
            const isWindows = process.platform === 'win32';
            const shellNote = this.shellEnabled
                ? `\nShell execution is ENABLED. WARNING: run_bash is NOT sandboxed to the workspace — commands can read and write anywhere on the system. You may run commands with:\n<run_bash>\ncommand here\n</run_bash>${isWindows ? '\nIMPORTANT: The shell runs on Windows (cmd.exe). Use Windows commands — e.g. "cmd /c del file.txt" instead of "rm", "cmd /c rmdir /s /q dir" instead of "rm -rf", "cmd /c copy src dest" instead of "cp". Do NOT use Unix/bash commands.' : ''}`
                : `\nShell execution is DISABLED — do not use <run_bash>, it will be blocked.`;
            systemPrompt += `\n\nCurrent workspace: ${wsPath}\n\nFile tree (use these exact paths in tool calls):\n${tree}\n\nIMPORTANT: Every path shown in the tree above exists. NEVER say a file or directory does not exist — use <read_file path="..."/> to verify a file and <list_dir path="..."/> to verify a directory. Always read a file before editing it.${shellNote}`;
        }
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push(...this.trimHistory(this.conversationHistory, config));
        messages.push({ role: 'user', content: text });
        this.conversationHistory.push({ role: 'user', content: text });
        this.saveHistory();
        // Stream
        let fullResponse = '';
        this.webviewView.webview.postMessage({ type: 'streamStart' });
        await this.client.streamChat(messages, {
            onChunk: (content) => {
                fullResponse += content;
                this.webviewView?.webview.postMessage({ type: 'streamChunk', content });
            },
            onDone: () => {
                if (fullResponse) {
                    this.conversationHistory.push({ role: 'assistant', content: fullResponse });
                    this.saveHistory();
                }
                this.webviewView?.webview.postMessage({ type: 'streamDone', model: this.currentModel });
                this.processToolCalls(fullResponse).catch(err => {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.webviewView?.webview.postMessage({
                        type: 'systemMessage', text: `Tool processing error: ${msg}`,
                    });
                });
            },
            onError: (error) => {
                this.webviewView?.webview.postMessage({ type: 'streamError', error });
            },
        });
    }
    // ── Tool call processing ─────────────────────────────────────────────────
    async processToolCalls(response) {
        if (!this.webviewView) {
            return;
        }
        if (this.isProcessingTools) {
            return;
        }
        this.isProcessingTools = true;
        try {
            await this._processToolCallsInner(response);
        }
        finally {
            this.isProcessingTools = false;
        }
    }
    async _processToolCallsInner(response) {
        if (!this.webviewView) {
            return;
        }
        // Quick pre-check before running the regex
        const hasToolTag = response.includes('<write_file') || response.includes('<run_bash>') ||
            response.includes('<read_file') || response.includes('<patch_file') ||
            response.includes('<list_dir') || response.includes('<search_files') ||
            response.includes('<delete_file') || response.includes('<create_dir') ||
            response.includes('<rename_file');
        if (!hasToolTag) {
            return;
        }
        const tools = parseToolCalls(response);
        if (tools.length === 0) {
            // Tags were present but regex didn't match — show a warning with context
            this.webviewView.webview.postMessage({
                type: 'systemMessage',
                text: 'Tool tag detected but could not be parsed. Ensure the format is: <write_file path="relative/path">…</write_file>',
            });
            return;
        }
        let didRead = false;
        for (const tool of tools) {
            const id = crypto.randomBytes(8).toString('hex');
            // ── read_file: always auto-execute (read-only) ──────────────────
            if (tool.type === 'read_file') {
                try {
                    const content = await this.toolExecutor.readFile(tool.path);
                    this.conversationHistory.push({
                        role: 'user',
                        content: `[Tool result: read_file "${tool.path}"]\n\`\`\`\n${content}\n\`\`\``,
                    });
                    this.saveHistory();
                    this.webviewView.webview.postMessage({ type: 'toolRead', path: tool.path });
                    didRead = true;
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.conversationHistory.push({
                        role: 'user',
                        content: `[Tool result: read_file "${tool.path}"]\nError: ${msg}`,
                    });
                    this.saveHistory();
                    this.webviewView.webview.postMessage({
                        type: 'toolRead', path: tool.path, error: msg,
                    });
                    didRead = true;
                }
                continue;
            }
            // ── list_dir: always auto-execute (read-only) ───────────────────
            if (tool.type === 'list_dir') {
                try {
                    const listing = await this.toolExecutor.listDir(tool.path);
                    this.conversationHistory.push({
                        role: 'user',
                        content: `[Tool result: list_dir "${tool.path}"]\n${listing}`,
                    });
                    this.saveHistory();
                    this.webviewView.webview.postMessage({ type: 'toolListDir', path: tool.path });
                    didRead = true;
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.conversationHistory.push({
                        role: 'user',
                        content: `[Tool result: list_dir "${tool.path}"]\nError: ${msg}`,
                    });
                    this.saveHistory();
                    this.webviewView.webview.postMessage({
                        type: 'toolListDir', path: tool.path, error: msg,
                    });
                    didRead = true;
                }
                continue;
            }
            // ── write_file ──────────────────────────────────────────────────
            if (tool.type === 'write_file') {
                let diff;
                try {
                    diff = await this.toolExecutor.computeDiff(tool.path, tool.content);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.webviewView?.webview.postMessage({
                        type: 'systemMessage', text: `Diff error for "${tool.path}": ${msg}`,
                    });
                    continue;
                }
                if (this.permissionMode === 'edit') {
                    try {
                        await this.toolExecutor.applyFileEdit(tool.path, tool.content);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: write_file "${tool.path}"]\nSuccess: file written.`,
                        });
                        this.saveHistory();
                        this.webviewView?.webview.postMessage({
                            type: 'toolPendingEdit', id, path: tool.path, diff,
                            autoApplied: true, success: true,
                        });
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: write_file "${tool.path}"]\nError: ${msg}`,
                        });
                        this.saveHistory();
                        this.webviewView?.webview.postMessage({
                            type: 'toolPendingEdit', id, path: tool.path, diff,
                            autoApplied: true, success: false, error: msg,
                        });
                        didRead = true;
                    }
                }
                else {
                    // ask mode
                    this.pendingTools.set(id, { type: 'edit', path: tool.path, newContent: tool.content });
                    this.webviewView?.webview.postMessage({
                        type: 'toolPendingEdit', id, path: tool.path, diff,
                    });
                }
                continue;
            }
            // ── patch_file ───────────────────────────────────────────────────
            if (tool.type === 'patch_file') {
                let diff;
                try {
                    // For diff preview: treat search as old content, replace as new
                    diff = diffSearchReplace(tool.search, tool.replace);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.webviewView?.webview.postMessage({
                        type: 'systemMessage', text: `Diff error for "${tool.path}": ${msg}`,
                    });
                    continue;
                }
                if (this.permissionMode === 'edit') {
                    try {
                        await this.toolExecutor.applyPatch(tool.path, tool.search, tool.replace);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: patch_file "${tool.path}"]\nSuccess: patch applied.`,
                        });
                        this.saveHistory();
                        this.webviewView?.webview.postMessage({
                            type: 'toolPendingEdit', id, path: tool.path, diff,
                            isPatch: true, autoApplied: true, success: true,
                        });
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: patch_file "${tool.path}"]\nError: ${msg}`,
                        });
                        this.saveHistory();
                        this.webviewView?.webview.postMessage({
                            type: 'toolPendingEdit', id, path: tool.path, diff,
                            isPatch: true, autoApplied: true, success: false, error: msg,
                        });
                        didRead = true; // let model react to the error
                    }
                }
                else {
                    // ask mode
                    this.pendingTools.set(id, { type: 'patch', path: tool.path, search: tool.search, replace: tool.replace });
                    this.webviewView?.webview.postMessage({
                        type: 'toolPendingEdit', id, path: tool.path, diff, isPatch: true,
                    });
                }
                continue;
            }
            // ── search_files ─────────────────────────────────────────────────
            if (tool.type === 'search_files') {
                try {
                    const result = await this.toolExecutor.searchFiles(tool.query, tool.glob);
                    this.conversationHistory.push({
                        role: 'user',
                        content: `[Tool result: search_files "${tool.query}"]\n${result}`,
                    });
                    this.saveHistory();
                    this.webviewView.webview.postMessage({ type: 'toolRead', path: `search: ${tool.query}` });
                    didRead = true;
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.conversationHistory.push({
                        role: 'user',
                        content: `[Tool result: search_files "${tool.query}"]\nError: ${msg}`,
                    });
                    this.saveHistory();
                    didRead = true;
                }
                continue;
            }
            // ── delete_file ───────────────────────────────────────────────────
            if (tool.type === 'delete_file') {
                if (this.permissionMode === 'edit') {
                    try {
                        await this.toolExecutor.deleteFile(tool.path);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: delete_file "${tool.path}"]\nSuccess: file deleted.`,
                        });
                        this.saveHistory();
                        this.webviewView.webview.postMessage({
                            type: 'toolPendingBash', id, command: `delete: ${tool.path}`,
                            autoApplied: true, success: true, output: 'File deleted.',
                        });
                        didRead = true;
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: delete_file "${tool.path}"]\nError: ${msg}`,
                        });
                        this.saveHistory();
                        this.webviewView.webview.postMessage({
                            type: 'toolPendingBash', id, command: `delete: ${tool.path}`,
                            autoApplied: true, success: false, output: msg,
                        });
                        didRead = true;
                    }
                }
                else {
                    this.pendingTools.set(id, { type: 'delete', path: tool.path });
                    this.webviewView.webview.postMessage({
                        type: 'toolPendingBash', id, command: `delete: ${tool.path}`,
                    });
                }
                continue;
            }
            // ── create_dir ────────────────────────────────────────────────────
            if (tool.type === 'create_dir') {
                if (this.permissionMode === 'edit') {
                    try {
                        await this.toolExecutor.createDir(tool.path);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: create_dir "${tool.path}"]\nSuccess: directory created.`,
                        });
                        this.saveHistory();
                        this.webviewView.webview.postMessage({
                            type: 'toolPendingBash', id, command: `mkdir: ${tool.path}`,
                            autoApplied: true, success: true, output: 'Directory created.',
                        });
                        didRead = true;
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: create_dir "${tool.path}"]\nError: ${msg}`,
                        });
                        this.saveHistory();
                        this.webviewView.webview.postMessage({
                            type: 'toolPendingBash', id, command: `mkdir: ${tool.path}`,
                            autoApplied: true, success: false, output: msg,
                        });
                        didRead = true;
                    }
                }
                else {
                    this.pendingTools.set(id, { type: 'mkdir', path: tool.path });
                    this.webviewView.webview.postMessage({
                        type: 'toolPendingBash', id, command: `mkdir: ${tool.path}`,
                    });
                }
                continue;
            }
            // ── rename_file ───────────────────────────────────────────────────
            if (tool.type === 'rename_file') {
                if (this.permissionMode === 'edit') {
                    try {
                        await this.toolExecutor.renameFile(tool.from, tool.to);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: rename_file "${tool.from}" → "${tool.to}"]\nSuccess: file renamed.`,
                        });
                        this.saveHistory();
                        this.webviewView.webview.postMessage({
                            type: 'toolPendingBash', id, command: `rename: ${tool.from} → ${tool.to}`,
                            autoApplied: true, success: true, output: 'File renamed.',
                        });
                        didRead = true;
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: rename_file "${tool.from}" → "${tool.to}"]\nError: ${msg}`,
                        });
                        this.saveHistory();
                        this.webviewView.webview.postMessage({
                            type: 'toolPendingBash', id, command: `rename: ${tool.from} → ${tool.to}`,
                            autoApplied: true, success: false, output: msg,
                        });
                        didRead = true;
                    }
                }
                else {
                    this.pendingTools.set(id, { type: 'rename', from: tool.from, to: tool.to });
                    this.webviewView.webview.postMessage({
                        type: 'toolPendingBash', id, command: `rename: ${tool.from} → ${tool.to}`,
                    });
                }
                continue;
            }
            // ── run_bash ─────────────────────────────────────────────────────
            if (tool.type === 'run_bash') {
                if (!this.shellEnabled) {
                    this.conversationHistory.push({
                        role: 'user',
                        content: `[Tool result: run_bash]\nError: Shell execution is disabled. The user has turned off the shell toggle. Do not attempt run_bash again until it is enabled.`,
                    });
                    this.saveHistory();
                    this.webviewView.webview.postMessage({
                        type: 'toolPendingBash', id, command: tool.command,
                        autoApplied: true, success: false,
                        output: 'Shell execution is disabled — enable the shell button to allow commands.',
                    });
                    didRead = true; // let model react to the error
                    continue;
                }
                if (this.permissionMode === 'edit') {
                    try {
                        const result = await this.toolExecutor.runBash(tool.command);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: run_bash]\nExit code: ${result.exitCode}\n${result.output}`,
                        });
                        this.saveHistory();
                        this.webviewView.webview.postMessage({
                            type: 'toolPendingBash', id, command: tool.command,
                            autoApplied: true, success: result.exitCode === 0, output: result.output,
                        });
                        didRead = true;
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: run_bash]\nError: ${msg}`,
                        });
                        this.saveHistory();
                        this.webviewView.webview.postMessage({
                            type: 'toolPendingBash', id, command: tool.command,
                            autoApplied: true, success: false, output: msg,
                        });
                        didRead = true;
                    }
                }
                else {
                    // ask mode
                    this.pendingTools.set(id, { type: 'bash', command: tool.command });
                    this.webviewView.webview.postMessage({
                        type: 'toolPendingBash', id, command: tool.command,
                    });
                }
            }
        }
        // After reading file(s), re-invoke the model so it can proceed with edits.
        // Only continue if there are no pending tools waiting for user approval —
        // if there are, the continuation will fire once the user accepts/denies them.
        if (didRead && this.pendingTools.size === 0) {
            await this.continueAfterToolResult();
        }
    }
    continueAfterToolResult() {
        this.toolIterations++;
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        const maxIter = config.get('maxToolIterations', 10);
        if (this.toolIterations >= maxIter) {
            this.webviewView?.webview.postMessage({
                type: 'systemMessage',
                text: `Stopped after ${maxIter} consecutive tool iterations. Send a message to continue.`,
            });
            this.toolIterations = 0;
            return;
        }
        this.continueConversation().catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            this.webviewView?.webview.postMessage({
                type: 'systemMessage', text: `Continuation error: ${msg}`,
            });
        });
    }
    async continueConversation() {
        if (!this.webviewView) {
            return;
        }
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        let systemPrompt = config.get('systemPrompt', '');
        if (this.workspaceMode) {
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            const wsPath = wsFolder?.uri.fsPath ?? '(no workspace)';
            const tree = await this.contextProvider.getWorkspaceTree();
            const isWindows = process.platform === 'win32';
            const shellNote = this.shellEnabled
                ? `\nShell execution is ENABLED. WARNING: run_bash is NOT sandboxed to the workspace — commands can read and write anywhere on the system. You may run commands with:\n<run_bash>\ncommand here\n</run_bash>${isWindows ? '\nIMPORTANT: The shell runs on Windows (cmd.exe). Use Windows commands — e.g. "cmd /c del file.txt" instead of "rm", "cmd /c rmdir /s /q dir" instead of "rm -rf", "cmd /c copy src dest" instead of "cp". Do NOT use Unix/bash commands.' : ''}`
                : `\nShell execution is DISABLED — do not use <run_bash>, it will be blocked.`;
            systemPrompt += `\n\nCurrent workspace: ${wsPath}\n\nFile tree (use these exact paths in tool calls):\n${tree}\n\nIMPORTANT: Every path shown in the tree above exists. NEVER say a file or directory does not exist — use <read_file path="..."/> to verify a file and <list_dir path="..."/> to verify a directory. Always read a file before editing it.${shellNote}`;
        }
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push(...this.trimHistory(this.conversationHistory, config));
        let fullResponse = '';
        this.webviewView.webview.postMessage({ type: 'streamStart' });
        await this.client.streamChat(messages, {
            onChunk: (content) => {
                fullResponse += content;
                this.webviewView?.webview.postMessage({ type: 'streamChunk', content });
            },
            onDone: () => {
                if (fullResponse) {
                    this.conversationHistory.push({ role: 'assistant', content: fullResponse });
                    this.saveHistory();
                }
                this.webviewView?.webview.postMessage({ type: 'streamDone', model: this.currentModel });
                this.processToolCalls(fullResponse).catch(err => {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.webviewView?.webview.postMessage({
                        type: 'systemMessage', text: `Tool processing error: ${msg}`,
                    });
                });
            },
            onError: (error) => {
                this.webviewView?.webview.postMessage({ type: 'streamError', error });
            },
        });
    }
    // ── History trim ─────────────────────────────────────────────────────────
    trimHistory(history, config) {
        const max = config.get('maxHistoryMessages', 50);
        if (history.length <= max) {
            return history;
        }
        const pinnedCount = history.filter(m => m.content.startsWith('[SYSTEM — ACCESS DENIED]')).length;
        const keepNormal = Math.max(0, max - pinnedCount);
        // Walk backwards in chronological order: always keep pinned, keep most recent normal ones
        const result = [];
        let keptNormal = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            const isPinned = m.content.startsWith('[SYSTEM — ACCESS DENIED]');
            if (isPinned || keptNormal < keepNormal) {
                result.unshift(m); // prepend to preserve original order
                if (!isPinned) {
                    keptNormal++;
                }
            }
        }
        return result;
    }
    // ── Webview HTML ─────────────────────────────────────────────────────────
    getWebviewContent() {
        const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chat.html');
        try {
            const nonce = crypto.randomBytes(16).toString('hex');
            const cspSource = this.webviewView.webview.cspSource;
            let html = fs.readFileSync(htmlPath, 'utf-8');
            html = html.replace(/\{NONCE\}/g, nonce);
            html = html.replace(/\{CSP_SOURCE\}/g, cspSource);
            return html;
        }
        catch {
            return `<!DOCTYPE html><html><body style="color:var(--vscode-foreground)">
<p>Error: Could not load chat interface. Please reinstall the extension.</p>
</body></html>`;
        }
    }
}
exports.ChatViewProvider = ChatViewProvider;
function parseToolCalls(text) {
    const results = [];
    let m;
    // write_file
    const writeRe = /<write_file\b[^>]*\bpath=["']([^"']+)["'][^>]*>([\s\S]*?)<\/write_file>/g;
    while ((m = writeRe.exec(text)) !== null) {
        let content = m[2];
        content = content.replace(/^\n/, '').replace(/\n$/, '');
        content = content.replace(/^```[^\n]*\n([\s\S]*?)```\s*$/, '$1');
        results.push({ type: 'write_file', path: m[1], content, pos: m.index });
    }
    // patch_file — <patch_file path="..."><search>...</search><replace>...</replace></patch_file>
    const patchRe = /<patch_file\b[^>]*\bpath=["']([^"']+)["'][^>]*>\s*<search>([\s\S]*?)<\/search>\s*<replace>([\s\S]*?)<\/replace>\s*<\/patch_file>/g;
    while ((m = patchRe.exec(text)) !== null) {
        const search = m[2].replace(/^\n/, '').replace(/\n$/, '');
        const replace = m[3].replace(/^\n/, '').replace(/\n$/, '');
        results.push({ type: 'patch_file', path: m[1], search, replace, pos: m.index });
    }
    // run_bash
    const bashRe = /<run_bash\b[^>]*>([\s\S]*?)<\/run_bash>/g;
    while ((m = bashRe.exec(text)) !== null) {
        results.push({ type: 'run_bash', command: m[1].trim(), pos: m.index });
    }
    // read_file — self-closing or empty element
    const readRe = /<read_file\b[^>]*\bpath=["']([^"']+)["'][^>]*(?:\/>|>\s*<\/read_file>)/g;
    while ((m = readRe.exec(text)) !== null) {
        results.push({ type: 'read_file', path: m[1], pos: m.index });
    }
    // list_dir — self-closing or empty element
    const listRe = /<list_dir\b[^>]*\bpath=["']([^"']+)["'][^>]*(?:\/>|>\s*<\/list_dir>)/g;
    while ((m = listRe.exec(text)) !== null) {
        results.push({ type: 'list_dir', path: m[1], pos: m.index });
    }
    // search_files — <search_files query="..." glob="*.ts"/>
    const searchRe = /<search_files\b[^>]*\bquery=["']([^"']+)["'][^>]*(?:\/>|>\s*<\/search_files>)/g;
    while ((m = searchRe.exec(text)) !== null) {
        const globMatch = m[0].match(/\bglob=["']([^"']+)["']/);
        results.push({ type: 'search_files', query: m[1], glob: globMatch?.[1], pos: m.index });
    }
    // delete_file — self-closing or empty element
    const deleteRe = /<delete_file\b[^>]*\bpath=["']([^"']+)["'][^>]*(?:\/>|>\s*<\/delete_file>)/g;
    while ((m = deleteRe.exec(text)) !== null) {
        results.push({ type: 'delete_file', path: m[1], pos: m.index });
    }
    // create_dir — self-closing or empty element
    const mkdirRe = /<create_dir\b[^>]*\bpath=["']([^"']+)["'][^>]*(?:\/>|>\s*<\/create_dir>)/g;
    while ((m = mkdirRe.exec(text)) !== null) {
        results.push({ type: 'create_dir', path: m[1], pos: m.index });
    }
    // rename_file — <rename_file from="..." to="..."/>
    const renameRe = /<rename_file\b[^>]*\bfrom=["']([^"']+)["'][^>]*\bto=["']([^"']+)["'][^>]*(?:\/>|>\s*<\/rename_file>)/g;
    while ((m = renameRe.exec(text)) !== null) {
        results.push({ type: 'rename_file', from: m[1], to: m[2], pos: m.index });
    }
    return results.sort((a, b) => a.pos - b.pos);
}
// ── patch_file diff helper ────────────────────────────────────────────────────
function diffSearchReplace(search, replace) {
    const dels = search.split('\n').map(t => ({ type: 'del', text: t }));
    const adds = replace.split('\n').map(t => ({ type: 'add', text: t }));
    return [...dels, ...adds];
}
//# sourceMappingURL=chatViewProvider.js.map