import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LmStudioClient, ChatMessage } from './lmStudioClient.js';
import { ContextProvider } from './contextProvider.js';
import { ToolExecutor } from './toolExecutor.js';
import { McpManager } from './mcpManager.js';

type PermissionMode = 'ask' | 'edit';

type PendingTool =
    | { type: 'edit';   path: string; newContent: string }
    | { type: 'patch';  path: string; search: string; replace: string }
    | { type: 'bash';   command: string }
    | { type: 'delete'; path: string }
    | { type: 'mkdir';  path: string }
    | { type: 'rename'; from: string; to: string }
    | { type: 'mcp';    server: string; tool: string; args: object };

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private webviewView?: vscode.WebviewView;
    private conversationHistory: ChatMessage[] = [];
    private client: LmStudioClient;
    private contextProvider: ContextProvider;
    private toolExecutor: ToolExecutor;
    private pendingTools: Map<string, PendingTool> = new Map();

    public mcpManager: McpManager;

    private workspaceMode: boolean;
    private permissionMode: PermissionMode;
    private shellEnabled: boolean;
    private shellPermissions: string = '';
    private mcpInstructions: Record<string, string> = {};
    private mcpPermissions:  Record<string, string> = {};
    private toolIterations: number = 0;
    private isProcessingTools: boolean = false;
    private currentModel: string = '';
    private systemPromptCache: string = '';

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext
    ) {
        this.client = new LmStudioClient();
        this.contextProvider = new ContextProvider();
        this.toolExecutor = new ToolExecutor();
        this.mcpManager = new McpManager(context);
        this.mcpManager.initialize().catch(console.error);
        this.mcpManager.onStatusChange(() => this.sendMcpStatus());
        context.subscriptions.push({ dispose: () => this.mcpManager.dispose() });

        this.workspaceMode   = true; // workspace context is always active
        this.permissionMode  = context.globalState.get<PermissionMode>('permissionMode', 'ask');
        this.shellEnabled     = context.globalState.get<boolean>('shellEnabled', false);
        this.shellPermissions = context.globalState.get<string>('shellPermissions', '');
        this.mcpInstructions  = context.globalState.get<Record<string, string>>('mcpInstructions', {});
        this.mcpPermissions  = context.globalState.get<Record<string, string>>('mcpPermissions', {});

        const savedHistory = context.globalState.get<ChatMessage[]>('chatHistory', []);
        this.conversationHistory = savedHistory;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
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
                    this.sendMcpStatus();
                    break;

                case 'saveMcpConfig':
                    await this.mcpManager.saveServerConfigs(message.configs);
                    this.sendMcpStatus();
                    break;

                case 'saveMcpInstructions':
                    this.mcpInstructions = message.instructions ?? {};
                    await this.context.globalState.update('mcpInstructions', this.mcpInstructions);
                    break;

                case 'saveMcpPermissions':
                    this.mcpPermissions = message.permissions ?? {};
                    await this.context.globalState.update('mcpPermissions', this.mcpPermissions);
                    break;

                case 'openMcpConfig': {
                    const configPath = this.mcpManager.getConfigFilePath();
                    // Create the file with an empty array if it doesn't exist yet
                    const fs = await import('fs');
                    const path = await import('path');
                    fs.mkdirSync(path.dirname(configPath), { recursive: true });
                    if (!fs.existsSync(configPath)) {
                        fs.writeFileSync(configPath, '[]', 'utf-8');
                    }
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
                    await vscode.window.showTextDocument(doc, { preview: false });
                    break;
                }

                case 'getMcpStatus':
                    this.sendMcpStatus();
                    break;

                case 'toggleWorkspace':
                    // Do nothing, just keep workspace status showing
                    this.sendWorkspaceStatus();
                    break;

                case 'toggleShell': {
                    this.shellEnabled = !this.shellEnabled;
                    await this.context.globalState.update('shellEnabled', this.shellEnabled);
                    this.sendShellStatus();
                    break;
                }

                case 'saveShellPermissions': {
                    this.shellPermissions = message.permissions ?? '';
                    await this.context.globalState.update('shellPermissions', this.shellPermissions);
                    break;
                }

                case 'cyclePermission': {
                    const modes: PermissionMode[] = ['ask', 'edit'];
                    const next = modes[(modes.indexOf(this.permissionMode) + 1) % 2];
                    this.permissionMode = next;
                    await this.context.globalState.update('permissionMode', this.permissionMode);
                    this.sendPermissionStatus();
                    break;
                }

                case 'approveTool': {
                    const tool = this.pendingTools.get(message.id);
                    if (!tool) { break; }
                    this.pendingTools.delete(message.id);

                    if (tool.type === 'edit') {
                        try {
                            await this.toolExecutor.applyFileEdit(tool.path, tool.newContent);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: true });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: write_file "${tool.path}"]\nSuccess: file written.` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: write_file "${tool.path}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    } else if (tool.type === 'patch') {
                        try {
                            await this.toolExecutor.applyPatch(tool.path, tool.search, tool.replace);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: true });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: patch_file "${tool.path}"]\nSuccess: patch applied.` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: patch_file "${tool.path}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    } else if (tool.type === 'bash') {
                        try {
                            const result = await this.toolExecutor.runBash(tool.command);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: result.exitCode === 0, output: result.output });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: run_bash]\nExit code: ${result.exitCode}\n${result.output}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: run_bash]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    } else if (tool.type === 'delete') {
                        try {
                            await this.toolExecutor.deleteFile(tool.path);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: true });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: delete_file "${tool.path}"]\nSuccess: file deleted.` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: delete_file "${tool.path}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    } else if (tool.type === 'mkdir') {
                        try {
                            await this.toolExecutor.createDir(tool.path);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: true });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: create_dir "${tool.path}"]\nSuccess: directory created.` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: create_dir "${tool.path}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    } else if (tool.type === 'rename') {
                        try {
                            await this.toolExecutor.renameFile(tool.from, tool.to);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: true });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: rename_file "${tool.from}" → "${tool.to}"]\nSuccess: file renamed.` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.webviewView?.webview.postMessage({ type: 'toolResult', id: message.id, success: false, output: msg });
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: rename_file "${tool.from}" → "${tool.to}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.continueAfterToolResult();
                        }
                    } else if (tool.type === 'mcp') {
                        try {
                            const output = await this.mcpManager.callTool(tool.server, tool.tool, tool.args);
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: mcp_call server="${tool.server}" tool="${tool.tool}"]\n${output}` });
                            this.saveHistory();
                            this.webviewView?.webview.postMessage({
                                type: 'toolMcpResult', id: message.id,
                                server: tool.server, tool: tool.tool,
                                output, success: true,
                            });
                            this.continueAfterToolResult();
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.conversationHistory.push({ role: 'user', content: `[Tool result: mcp_call server="${tool.server}" tool="${tool.tool}"]\nError: ${msg}` });
                            this.saveHistory();
                            this.webviewView?.webview.postMessage({
                                type: 'toolMcpResult', id: message.id,
                                server: tool.server, tool: tool.tool,
                                output: msg, success: false,
                            });
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

                case 'exportConversation':
                    await this.exportConversation();
                    break;

                case 'denyTool': {
                    const tool = this.pendingTools.get(message.id);
                    if (!tool) { break; }
                    this.pendingTools.delete(message.id);

                    // Build a human-readable description of what was denied
                    const denyDesc = tool.type === 'edit'   ? `editing file "${tool.path}"`
                        : tool.type === 'patch'  ? `patching file "${tool.path}"`
                        : tool.type === 'delete' ? `deleting file "${tool.path}"`
                        : tool.type === 'mkdir'  ? `creating directory "${tool.path}"`
                        : tool.type === 'rename' ? `renaming "${tool.from}" to "${tool.to}"`
                        : tool.type === 'mcp'    ? `calling MCP tool "${tool.tool}" on server "${tool.server}"`
                        : `running command: ${(tool as { type: 'bash'; command: string }).command}`;

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

    private saveHistory(): void {
        this.context.globalState.update('chatHistory', this.conversationHistory);
    }

    private sendWorkspaceStatus(): void {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        this.webviewView?.webview.postMessage({
            type: 'workspaceStatus',
            active: this.workspaceMode,
            path: wsFolder?.uri.fsPath ?? null,
        });
    }

    private sendPermissionStatus(): void {
        this.webviewView?.webview.postMessage({
            type: 'permissionStatus',
            mode: this.permissionMode,
        });
    }

    private sendShellStatus(): void {
        this.webviewView?.webview.postMessage({
            type: 'shellStatus',
            enabled:     this.shellEnabled,
            permissions: this.shellPermissions,
        });
    }

    private sendMcpStatus(): void {
        const servers = this.mcpManager.getServerStatuses().map(s => ({
            name: s.config.name,
            status: s.status,
            errorMessage: s.errorMessage,
            toolCount: s.tools.length,
            transport: s.config.config.transport,
        }));
        this.webviewView?.webview.postMessage({
            type: 'mcpStatus',
            servers,
            configs: this.mcpManager.getServerConfigs(),
            instructions: this.mcpInstructions,
            permissions:  this.mcpPermissions,
        });
    }

    public resetConversation(): void {
        this.conversationHistory = [];
        this.pendingTools.clear();
        this.toolIterations = 0;
        this.isProcessingTools = false;
        this.saveHistory();
        this.webviewView?.webview.postMessage({ type: 'reset' });
        vscode.window.showInformationMessage('LM Studio Chat: Conversation cleared');
    }

    public async exportConversation(): Promise<void> {
        if (this.conversationHistory.length === 0) {
            vscode.window.showWarningMessage('No conversation to export.');
            return;
        }

        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) {
            vscode.window.showWarningMessage('No workspace folder open — cannot export.');
            return;
        }

        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
        const filename = `chat-${timestamp}.md`;

        const exportDir = path.join(wsFolder.uri.fsPath, 'lm-chat-history');
        fs.mkdirSync(exportDir, { recursive: true });

        const filePath = path.join(exportDir, filename);
        const content = this.formatConversation();
        fs.writeFileSync(filePath, content, 'utf-8');

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc, { preview: true });
        vscode.window.showInformationMessage(`Conversation saved to lm-chat-history/${filename}`);
    }

    private formatConversation(): string {
        const lines: string[] = [];
        const now = new Date().toLocaleString();

        lines.push('# LM Studio Chat Export');
        lines.push('');
        lines.push(`**Exported:** ${now}`);
        if (this.currentModel) {
            lines.push(`**Model:** ${this.currentModel}`);
        }
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (wsFolder) {
            lines.push(`**Workspace:** ${wsFolder.uri.fsPath}`);
        }
        lines.push('');
        lines.push('---');
        lines.push('');

        for (const msg of this.conversationHistory) {
            if (msg.role === 'system') { continue; }
            // Skip internal tool-result and system-control messages
            if (msg.role === 'user' && (
                msg.content.startsWith('[Tool result:') ||
                msg.content.startsWith('[SYSTEM —')
            )) { continue; }

            if (msg.role === 'user') {
                lines.push('## You');
                lines.push('');
                lines.push(msg.content);
                lines.push('');
            } else {
                lines.push('## Assistant');
                lines.push('');
                lines.push(msg.content);
                lines.push('');
            }
        }

        return lines.join('\n');
    }

    public async refreshHealthCheck(): Promise<void> {
        await this.handleHealthCheck();
        this.sendCurrentConfig();
    }

    private sendCurrentConfig(): void {
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        this.webviewView?.webview.postMessage({
            type: 'configUpdate',
            endpoint:     config.get<string>('endpoint', 'http://127.0.0.1:1234'),
            model:        config.get<string>('model', ''),
            systemPrompt: config.get<string>('systemPrompt', ''),
        });
    }

    public async showModelPicker(): Promise<void> {
        const models = await this.client.fetchModels();
        if (models.length === 0) {
            vscode.window.showWarningMessage('No models available. Is LM Studio running?');
            return;
        }

        const config = vscode.workspace.getConfiguration('lmStudioChat');
        const currentModel = config.get<string>('model', '');

        const items: vscode.QuickPickItem[] = [
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
        if (!selected) { return; }

        const newModel = selected.label.startsWith('$(sparkle)') ? '' : selected.label;
        await config.update('model', newModel, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Model set to: ${newModel || 'Auto'}`);
        await this.handleHealthCheck();
        this.sendCurrentConfig();
    }

    private async handleHealthCheck(): Promise<void> {
        const health = await this.client.checkHealth();
        if (health.ok && health.models?.length) {
            const config = vscode.workspace.getConfiguration('lmStudioChat');
            const configured = config.get<string>('model', '');
            this.currentModel = configured || health.models[0];
        }
        this.webviewView?.webview.postMessage({
            type: 'healthStatus',
            ok: health.ok, models: health.models, error: health.error,
        });
    }

    // ── System prompt builder ────────────────────────────────────────────────

    private async buildSystemPrompt(): Promise<string> {
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        let prompt = config.get<string>('systemPrompt', '');
        if (this.workspaceMode) {
            const wsFolder  = vscode.workspace.workspaceFolders?.[0];
            const wsPath    = wsFolder?.uri.fsPath ?? '(no workspace)';
            const tree      = await this.contextProvider.getWorkspaceTree();
            const isWindows = process.platform === 'win32';

            // Shell status note — injected BEFORE the file tree so it isn't buried
            const shellNote = this.shellEnabled
                ? `\n\nShell execution is ENABLED. WARNING: run_bash is NOT sandboxed to the workspace — commands can read and write anywhere on the system. Invoke a shell command like this:\n<run_bash>\n[your shell command]\n</run_bash>${isWindows ? '\nIMPORTANT: The shell runs on Windows (cmd.exe). Use Windows commands — e.g. "cmd /c del file.txt" instead of "rm", "cmd /c rmdir /s /q dir" instead of "rm -rf", "cmd /c copy src dest" instead of "cp". Do NOT use Unix/bash commands.' : ''}`
                : `\n\nShell execution is DISABLED — do not use <run_bash>, it will be blocked.`;
            prompt += shellNote;

            // User-defined shell permissions — injected immediately after the shell note,
            // before the file tree, so weaker models see them while context is fresh
            if (this.shellEnabled && this.shellPermissions.trim()) {
                const rules = this.shellPermissions.trim().split('\n');
                const numbered = rules.map((l, i) => `  ${i + 1}. ${l.replace(/^\d+[\.\)]\s*/, '')}`).join('\n');
                prompt += '\n\n'
                    + '=== SHELL PERMISSIONS (HARD CONSTRAINTS -- never violate) ===\n'
                    + 'The user has defined the following shell permission rules.\n'
                    + 'You MUST read and follow EVERY rule below before running any shell command.\n'
                    + 'These are non-negotiable -- treat them as the highest-priority rules for run_bash.\n'
                    + 'Rules:\n'
                    + numbered + '\n'
                    + '=== END SHELL PERMISSIONS ===';
            }

            // Workspace context (file tree) follows shell settings
            prompt += `\n\nCurrent workspace: ${wsPath}\n\nFile tree (use these exact paths in tool calls):\n${tree}\n\nIMPORTANT: Every path shown in the tree above exists. NEVER say a file or directory does not exist — use <read_file path="..."/> to verify a file and <list_dir path="..."/> to verify a directory. Always read a file before editing it.`;

            // Chat history folder hint — list actual files so the model can read them directly
            const historyDir = path.join(wsPath, 'lm-chat-history');
            if (fs.existsSync(historyDir)) {
                try {
                    const historyFiles = fs.readdirSync(historyDir)
                        .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
                        .sort()
                        .reverse(); // newest first
                    if (historyFiles.length > 0) {
                        const fileList = historyFiles.slice(0, 10).map(f => `  lm-chat-history/${f}`).join('\n');
                        prompt += `\n\nPast conversation exports (newest first):\n${fileList}\nUse <read_file path="lm-chat-history/FILENAME"/> to recall context from previous conversations. Do this automatically without asking when it seems useful.`;
                    }
                } catch { /* ignore read errors */ }
            }
        }
        prompt += this.mcpManager.getToolsSystemPromptBlock(this.mcpInstructions, this.mcpPermissions);
        return prompt;
    }

    // ── User message handler ─────────────────────────────────────────────────

    private async handleUserMessage(text: string): Promise<void> {
        if (!this.webviewView) { return; }

        // Reset per-turn counters and build system prompt once for the whole turn
        this.toolIterations = 0;
        this.systemPromptCache = await this.buildSystemPrompt();

        const config = vscode.workspace.getConfiguration('lmStudioChat');
        const messages: ChatMessage[] = [];
        if (this.systemPromptCache) {
            messages.push({ role: 'system', content: this.systemPromptCache });
        }

        messages.push(...this.trimHistory(this.conversationHistory, config));
        messages.push({ role: 'user', content: text });

        this.conversationHistory.push({ role: 'user', content: text });
        this.saveHistory();

        // Stream
        let fullResponse = '';
        this.webviewView.webview.postMessage({ type: 'streamStart' });

        await this.client.streamChat(messages, {
            onChunk: (content: string) => {
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
            onError: (error: string) => {
                this.webviewView?.webview.postMessage({ type: 'streamError', error });
            },
        });
    }

    // ── Tool call processing ─────────────────────────────────────────────────

    private async processToolCalls(response: string): Promise<void> {
        if (!this.webviewView) { return; }
        if (this.isProcessingTools) { return; }
        this.isProcessingTools = true;
        try {
            await this._processToolCallsInner(response);
        } finally {
            this.isProcessingTools = false;
        }
    }

    private async _processToolCallsInner(response: string): Promise<void> {
        if (!this.webviewView) { return; }

        // Strip markdown code blocks (fenced and inline) before checking for tool tags.
        // This prevents the parser from acting on tag examples the model quotes in its
        // explanatory text (e.g. when asked to list the rules it follows).
        const stripped = response
            .replace(/```[\s\S]*?```/g, '')   // fenced code blocks
            .replace(/`[^`\n]+`/g, '');       // inline code spans

        // Quick pre-check before running the regex.
        // For tags that require a closing element, require BOTH opening and closing to be present —
        // this prevents false positives when the model merely *mentions* a tag name in text.
        const hasToolTag =
            (stripped.includes('<write_file')   && stripped.includes('</write_file>'))   ||
            (stripped.includes('<run_bash>')     && stripped.includes('</run_bash>'))     ||
            (stripped.includes('<patch_file')    && stripped.includes('</patch_file>'))   ||
            (stripped.includes('<mcp_call')      && stripped.includes('</mcp_call>'))     ||
            stripped.includes('<read_file')   || stripped.includes('<list_dir')   ||
            stripped.includes('<search_files') || stripped.includes('<delete_file') ||
            stripped.includes('<create_dir')  || stripped.includes('<rename_file');

        // Detect native model tool-call formats (wrong format — model ignoring instructions)
        const hasNativeFormat = stripped.includes('<tool_call') || stripped.includes('[TOOL_CALLS]') ||
                                stripped.includes('<|tool_call|>') || stripped.includes('"function_call"');

        if (!hasToolTag && !hasNativeFormat) { return; }

        // If the model used a native format instead of our XML tags, send a correction and retry
        if (hasNativeFormat && !hasToolTag) {
            const correction = `[SYSTEM — TOOL FORMAT ERROR]\nYou used an unsupported tool-calling format (<tool_call>, [TOOL_CALLS], or similar).\nDo NOT use <tool_call> or any other format. Use ONLY the exact XML tags from your instructions:\n  <mcp_call server="SERVER_NAME" tool="TOOL_NAME">{"arg":"val"}</mcp_call>\nPlease retry your tool call using the correct format.`;
            this.conversationHistory.push({ role: 'user', content: correction });
            this.saveHistory();
            this.webviewView.webview.postMessage({
                type: 'systemMessage',
                text: 'Model used wrong tool format — correcting and retrying…',
            });
            this.continueAfterToolResult();
            return;
        }

        // Parse from the stripped text so code-block examples are never executed
        const tools = parseToolCalls(stripped);

        if (tools.length === 0) {
            // Tags were present but regex didn't match
            this.webviewView.webview.postMessage({
                type: 'systemMessage',
                text: 'Tool tag detected but could not be parsed — check tag format and attributes.',
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
                    this.webviewView.webview.postMessage({ type: 'toolRead', path: tool.path, content });
                    didRead = true;
                } catch (err) {
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
                    this.webviewView.webview.postMessage({ type: 'toolListDir', path: tool.path, content: listing });
                    didRead = true;
                } catch (err) {
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
                } catch (err) {
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
                    } catch (err) {
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
                } else {
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
                } catch (err) {
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
                    } catch (err) {
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
                } else {
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
                } catch (err) {
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
                    } catch (err) {
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
                } else {
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
                    } catch (err) {
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
                } else {
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
                    } catch (err) {
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
                } else {
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
                    } catch (err) {
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
                } else {
                    // ask mode
                    this.pendingTools.set(id, { type: 'bash', command: tool.command });
                    this.webviewView.webview.postMessage({
                        type: 'toolPendingBash', id, command: tool.command,
                    });
                }
            }

            // ── mcp_call ─────────────────────────────────────────────────────
            if (tool.type === 'mcp_call') {
                if (tool.parseError) {
                    const errMsg = `[Tool result: mcp_call server="${tool.server}" tool="${tool.tool}"]\nError: ${tool.parseError}. The content inside <mcp_call> tags must be a valid JSON object.`;
                    this.conversationHistory.push({ role: 'user', content: errMsg });
                    this.saveHistory();
                    this.webviewView.webview.postMessage({ type: 'systemMessage', text: `mcp_call JSON error: ${tool.parseError}` });
                    didRead = true;
                    continue;
                }
                if (this.permissionMode === 'edit') {
                    // Edit mode — auto-execute
                    this.webviewView.webview.postMessage({
                        type: 'toolMcpCall', id,
                        server: tool.server, tool: tool.tool,
                    });
                    try {
                        const output = await this.mcpManager.callTool(tool.server, tool.tool, tool.args);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: mcp_call server="${tool.server}" tool="${tool.tool}"]\n${output}`,
                        });
                        this.saveHistory();
                        this.webviewView.webview.postMessage({
                            type: 'toolMcpResult', id,
                            server: tool.server, tool: tool.tool,
                            output, success: true,
                        });
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.conversationHistory.push({
                            role: 'user',
                            content: `[Tool result: mcp_call server="${tool.server}" tool="${tool.tool}"]\nError: ${msg}`,
                        });
                        this.saveHistory();
                        this.webviewView.webview.postMessage({
                            type: 'toolMcpResult', id,
                            server: tool.server, tool: tool.tool,
                            output: msg, success: false,
                        });
                    }
                    didRead = true;
                } else {
                    // Ask mode — show pending card, wait for user approval
                    this.pendingTools.set(id, { type: 'mcp', server: tool.server, tool: tool.tool, args: tool.args });
                    this.webviewView.webview.postMessage({
                        type: 'toolPendingMcp', id,
                        server: tool.server, tool: tool.tool,
                        args: tool.args,
                    });
                }
                continue;
            }
        }

        // After reading file(s), re-invoke the model so it can proceed with edits.
        // Only continue if there are no pending tools waiting for user approval —
        // if there are, the continuation will fire once the user accepts/denies them.
        if (didRead && this.pendingTools.size === 0) {
            await this.continueAfterToolResult();
        }
    }

    private continueAfterToolResult(): void {
        this.toolIterations++;
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        const maxIter = config.get<number>('maxToolIterations', 10);
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

    private async continueConversation(): Promise<void> {
        if (!this.webviewView) { return; }

        // Reuse system prompt built at start of this turn — avoids redundant workspace tree reads
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        const messages: ChatMessage[] = [];
        if (this.systemPromptCache) {
            messages.push({ role: 'system', content: this.systemPromptCache });
        }
        messages.push(...this.trimHistory(this.conversationHistory, config));

        let fullResponse = '';
        this.webviewView.webview.postMessage({ type: 'streamStart' });

        await this.client.streamChat(messages, {
            onChunk: (content: string) => {
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
            onError: (error: string) => {
                this.webviewView?.webview.postMessage({ type: 'streamError', error });
            },
        });
    }

    // ── History trim ─────────────────────────────────────────────────────────

    private trimHistory(history: ChatMessage[], config: vscode.WorkspaceConfiguration): ChatMessage[] {
        const max = config.get<number>('maxHistoryMessages', 50);
        if (history.length <= max) { return history; }

        const pinnedCount = history.filter(m => m.content.startsWith('[SYSTEM — ACCESS DENIED]')).length;
        const keepNormal  = Math.max(0, max - pinnedCount);

        // Walk backwards in chronological order: always keep pinned, keep most recent normal ones
        const result: ChatMessage[] = [];
        let keptNormal = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            const isPinned = m.content.startsWith('[SYSTEM — ACCESS DENIED]');
            if (isPinned || keptNormal < keepNormal) {
                result.unshift(m); // prepend to preserve original order
                if (!isPinned) { keptNormal++; }
            }
        }
        return result;
    }

    // ── Webview HTML ─────────────────────────────────────────────────────────

    private getWebviewContent(): string {
        const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'chat.html');
        try {
            const nonce     = crypto.randomBytes(16).toString('hex');
            const cspSource = this.webviewView!.webview.cspSource;
            let html = fs.readFileSync(htmlPath, 'utf-8');
            html = html.replace(/\{NONCE\}/g, nonce);
            html = html.replace(/\{CSP_SOURCE\}/g, cspSource);
            return html;
        } catch {
            return `<!DOCTYPE html><html><body style="color:var(--vscode-foreground)">
<p>Error: Could not load chat interface. Please reinstall the extension.</p>
</body></html>`;
        }
    }
}

// ── Tool call parser ─────────────────────────────────────────────────────────

type ToolCall =
    | { type: 'write_file';   path: string; content: string;                  pos: number }
    | { type: 'patch_file';   path: string; search: string; replace: string;  pos: number }
    | { type: 'run_bash';     command: string;                                 pos: number }
    | { type: 'read_file';    path: string;                                    pos: number }
    | { type: 'list_dir';     path: string;                                    pos: number }
    | { type: 'search_files'; query: string; glob?: string;                    pos: number }
    | { type: 'delete_file';  path: string;                                    pos: number }
    | { type: 'create_dir';   path: string;                                    pos: number }
    | { type: 'rename_file';  from: string; to: string;                        pos: number }
    | { type: 'mcp_call';     server: string; tool: string; args: object; parseError?: string; pos: number };

function parseToolCalls(text: string): ToolCall[] {
    const results: ToolCall[] = [];
    let m: RegExpExecArray | null;

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
        const search  = m[2].replace(/^\n/, '').replace(/\n$/, '');
        const replace = m[3].replace(/^\n/, '').replace(/\n$/, '');
        results.push({ type: 'patch_file', path: m[1], search, replace, pos: m.index });
    }

    // run_bash — skip obvious placeholder content from system prompt examples
    const BASH_PLACEHOLDERS = new Set(['[your shell command]', 'command here', '[command]', 'your command here']);
    const bashRe = /<run_bash\b[^>]*>([\s\S]*?)<\/run_bash>/g;
    while ((m = bashRe.exec(text)) !== null) {
        const command = m[1].trim();
        if (BASH_PLACEHOLDERS.has(command.toLowerCase())) { continue; }
        results.push({ type: 'run_bash', command, pos: m.index });
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

    // mcp_call — <mcp_call server="name" tool="toolname">{"json":"args"}</mcp_call>
    const mcpRe = /<mcp_call\b([^>]+)>([\s\S]*?)<\/mcp_call>/g;
    while ((m = mcpRe.exec(text)) !== null) {
        const attrs = m[1];
        const serverMatch = attrs.match(/\bserver=["']([^"']+)["']/);
        const toolMatch   = attrs.match(/\btool=["']([^"']+)["']/);
        if (!serverMatch || !toolMatch) { continue; }
        let args: object = {};
        let parseError: string | undefined;
        const rawArgs = m[2].trim();
        try { args = JSON.parse(rawArgs); } catch {
            parseError = `Invalid JSON arguments: ${rawArgs.slice(0, 120)}`;
        }
        results.push({ type: 'mcp_call', server: serverMatch[1], tool: toolMatch[1], args, parseError, pos: m.index });
    }

    return results.sort((a, b) => a.pos - b.pos);
}

// ── patch_file diff helper ────────────────────────────────────────────────────

function diffSearchReplace(search: string, replace: string): import('./toolExecutor.js').DiffLine[] {
    const dels = search.split('\n').map(t => ({ type: 'del' as const, text: t }));
    const adds = replace.split('\n').map(t => ({ type: 'add' as const, text: t }));
    return [...dels, ...adds];
}
