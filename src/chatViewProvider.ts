import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LmStudioClient, ChatMessage, TokenUsage } from './lmStudioClient.js';
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
    private lastUsage: TokenUsage | null = null;

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

        this.scaffoldLmChatFolder();
    }

    // ── Auto-scaffold .lm-chat/ workspace folder ────────────────────────────

    private scaffoldLmChatFolder(): void {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) { return; }

        const root = path.join(wsFolder.uri.fsPath, '.lm-chat');

        // Only scaffold if the folder doesn't exist yet
        if (fs.existsSync(root)) { return; }

        fs.mkdirSync(root, { recursive: true });

        // Blank memory file
        fs.writeFileSync(path.join(root, 'MEMORY.md'), '', 'utf-8');

        // Default skills file with /save
        const defaultSkills = `# Skills

Slash-command skills you can invoke. When the user types a command listed here, follow the instructions exactly.

---

## /save

**Purpose:** Extract lessons learned from the current conversation and save them to memory so the model gets smarter over time.

**When invoked:** The user types \`/save\` (with or without additional context).

**Workflow (follow this exact sequence — each step requires a real tool call):**

**Step 1 — Read existing memory:**
Call \`<read_file path=".lm-chat/MEMORY.md"/>\` and WAIT for the result before continuing. You need the current content to avoid duplicates and to merge new entries with existing ones.

**Step 2 — Review the conversation and identify entries:**
After you have the file content, review the conversation and collect entries in ALL of these categories:
   **a) Key information & discoveries:**
   - Names of tables, views, columns, schemas, databases mentioned or worked with
   - Names of functions, variables, classes, files, endpoints, APIs
   - Connection strings, server names, port numbers (NOT passwords/tokens)
   - Any concrete facts learned about the project, its data, or its structure
   **b) Failed attempts & wrong approaches:**
   - Tool calls that failed and WHY (wrong path, bad syntax, missing arg, etc.)
   - Approaches that didn't work and what worked instead
   - Wrong assumptions that led to wasted turns
   **c) Fixes & workarounds discovered:**
   - What finally solved the problem and the exact steps
   - Non-obvious solutions that took multiple tries to find
   - Edge cases or gotchas encountered
   **d) User preferences & corrections:**
   - How the user wants things done (style, approach, workflow)
   - Corrections the user made ("no, do it this way")

**Step 3 — Write the updated file:**
Call \`<write_file path=".lm-chat/MEMORY.md">\` with the FULL content: all existing entries from Step 1 PLUS the new entries from Step 2. Append new entries under a date heading:
   \`\`\`
   ## YYYY-MM-DD
   - [INFO] Database has tables: orders, customers, products
   - [INFO] View sales_summary joins orders + customers
   - [FAIL] Tried X but it failed because Y — use Z instead
   - [FIX] When encountering A, the solution is B
   - [PREF] User prefers X over Y
   \`\`\`
Do NOT duplicate entries already present. Do NOT store anything sensitive (passwords, tokens, secrets).
When writing identifiers (table names, column names, view names, variable names, function names, etc.), copy them EXACTLY as they appeared in the conversation — character for character. NEVER use placeholders like "table_name", "the view", "mentioned table", etc. If a table was called sales_summary, write sales_summary. If you cannot recall the exact name, re-read the conversation above.
Ensure no visual formatting markers (highlighting, markdown artifacts, backticks, bold markers) end up in the raw text written to MEMORY.md — write plain text only.

**Step 4 — Verify:**
After write_file executes, call \`<read_file path=".lm-chat/MEMORY.md"/>\` one more time and check that everything was saved correctly — especially that all identifiers are present and not blank or replaced with placeholders. If anything is missing, call write_file again with the corrected content.

**Step 5 — Confirm:**
Tell the user what you saved, grouped by category.

**CRITICAL:** This skill is NOT complete until you have called BOTH \`<read_file>\` AND \`<write_file>\`. If you only list insights without writing them, the memory is empty and the skill has failed. You MUST make the tool calls.

Note: /recall and /forget are handled automatically by the extension — they do not need skill definitions here.
`;
        fs.writeFileSync(path.join(root, 'SKILLS.md'), defaultSkills, 'utf-8');
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
                    const config = vscode.workspace.getConfiguration('lmChat');
                    await config.update('systemPrompt', message.text, vscode.ConfigurationTarget.Global);
                    break;
                }

                case 'openSettings':
                case 'changeEndpoint':
                    await vscode.commands.executeCommand('lmChat.setEndpoint');
                    break;

                case 'selectModel':
                    await this.showModelPicker();
                    break;

                case 'setContextLimit': {
                    const config = vscode.workspace.getConfiguration('lmChat');
                    const current = config.get<number>('contextLimit', 0);
                    const input = await vscode.window.showInputBox({
                        title: 'Context Window Limit (tokens)',
                        prompt: 'Set the context window size to match your model\'s limit in LM Studio. Set to 0 to hide the token bar.',
                        value: String(current || ''),
                        placeHolder: 'e.g. 8192, 32768, 131072',
                        validateInput: (v) => {
                            const n = Number(v);
                            if (v && (isNaN(n) || n < 0 || !Number.isInteger(n))) {
                                return 'Enter a positive integer (or 0 to hide)';
                            }
                            return undefined;
                        },
                    });
                    if (input !== undefined) {
                        const limit = Number(input) || 0;
                        await config.update('contextLimit', limit, vscode.ConfigurationTarget.Global);
                        if (this.lastUsage) { this.sendTokenUsage(this.lastUsage); }
                        else {
                            this.webviewView?.webview.postMessage({
                                type: 'tokenUsage', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, contextLimit: limit,
                            });
                        }
                    }
                    break;
                }

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

    private sendTokenUsage(usage: TokenUsage): void {
        const config = vscode.workspace.getConfiguration('lmChat');
        const contextLimit = config.get<number>('contextLimit', 0);
        this.webviewView?.webview.postMessage({
            type: 'tokenUsage',
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            contextLimit,
        });
    }

    public resetConversation(): void {
        this.conversationHistory = [];
        this.pendingTools.clear();
        this.toolIterations = 0;
        this.isProcessingTools = false;
        this.lastUsage = null;
        this.saveHistory();
        this.webviewView?.webview.postMessage({ type: 'reset' });
        vscode.window.showInformationMessage('LM Chat: Conversation cleared');
    }

    public async refreshHealthCheck(): Promise<void> {
        await this.handleHealthCheck();
        this.sendCurrentConfig();
    }

    private sendCurrentConfig(): void {
        const config = vscode.workspace.getConfiguration('lmChat');
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

        const config = vscode.workspace.getConfiguration('lmChat');
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
            const config = vscode.workspace.getConfiguration('lmChat');
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
        const config = vscode.workspace.getConfiguration('lmChat');
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

            // SKILLS.md — inject skill definitions so the model knows available slash commands
            const skillsFile = path.join(wsPath, '.lm-chat', 'SKILLS.md');
            if (fs.existsSync(skillsFile)) {
                try {
                    const skillsContent = fs.readFileSync(skillsFile, 'utf-8').trim();
                    if (skillsContent) {
                        prompt += `\n\n=== SKILLS (.lm-chat/SKILLS.md) ===\n${skillsContent}\n=== END SKILLS ===\nBuilt-in skills: /save (model-driven — save lessons to memory), /recall and /forget (handled by the extension automatically). When the user types /save or any custom slash command, follow the matching skill instructions above exactly. You can also edit .lm-chat/SKILLS.md to add new skills when asked.`;
                    }
                } catch { /* ignore read errors */ }
            }

            // MEMORY.md — inject saved memories so the model has cross-session context
            const memoryFile = path.join(wsPath, '.lm-chat', 'MEMORY.md');
            if (fs.existsSync(memoryFile)) {
                try {
                    const memoryContent = fs.readFileSync(memoryFile, 'utf-8').trim();
                    if (memoryContent) {
                        prompt += `\n\n=== MEMORY (.lm-chat/MEMORY.md) ===\n${memoryContent}\n=== END MEMORY ===\nThese are facts saved from previous conversations. Use them as context but verify if unsure — they may be outdated.`;
                    }
                } catch { /* ignore read errors */ }
            }

            prompt += `\n\nThe .lm-chat/ directory is your workspace data folder containing SKILLS.md (skill definitions) and MEMORY.md (cross-session memory). Always use <read_file> and <write_file> to update these files — never use MCP tools or shell commands for them.`;
        }
        prompt += this.mcpManager.getToolsSystemPromptBlock(this.mcpInstructions, this.mcpPermissions);
        return prompt;
    }

    // ── Hardcoded built-in skills ──────────────────────────────────────────

    private handleBuiltinSkill(skill: string): boolean {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) { return false; }
        const memoryPath = path.join(wsFolder.uri.fsPath, '.lm-chat', 'MEMORY.md');

        if (skill === '/forget') {
            try {
                fs.writeFileSync(memoryPath, '', 'utf-8');
                this.sendSkillResponse('Memory cleared.');
            } catch {
                this.sendSkillResponse('Failed to clear memory — file may not exist yet.');
            }
            return true;
        }

        if (skill === '/recall') {
            try {
                const content = fs.existsSync(memoryPath)
                    ? fs.readFileSync(memoryPath, 'utf-8').trim()
                    : '';
                if (!content) {
                    this.sendSkillResponse('Memory is empty — nothing to recall.');
                } else {
                    const entries = content.split('\n').filter(l => l.startsWith('- ')).length;
                    this.sendSkillResponse(`Up to date. Recalled ${entries} entr${entries === 1 ? 'y' : 'ies'}.`);
                }
            } catch {
                this.sendSkillResponse('Failed to read memory.');
            }
            return true;
        }

        return false; // not a hardcoded skill — let the model handle it
    }

    private sendSkillResponse(text: string): void {
        if (!this.webviewView) { return; }
        this.conversationHistory.push({ role: 'assistant', content: text });
        this.saveHistory();
        this.webviewView.webview.postMessage({ type: 'streamStart' });
        this.webviewView.webview.postMessage({ type: 'streamChunk', content: text });
        this.webviewView.webview.postMessage({ type: 'streamDone', model: this.currentModel });
    }

    // ── User message handler ─────────────────────────────────────────────────

    private async handleUserMessage(text: string): Promise<void> {
        if (!this.webviewView) { return; }

        // Reset per-turn counters and build system prompt once for the whole turn
        this.toolIterations = 0;
        this.systemPromptCache = await this.buildSystemPrompt();

        const config = vscode.workspace.getConfiguration('lmChat');
        const messages: ChatMessage[] = [];
        if (this.systemPromptCache) {
            messages.push({ role: 'system', content: this.systemPromptCache });
        }

        messages.push(...this.prepareHistoryForModel(this.trimHistory(this.conversationHistory, config)));
        messages.push({ role: 'user', content: text });

        this.conversationHistory.push({ role: 'user', content: text });
        this.saveHistory();

        // Detect slash command and show skill activation card
        const slashMatch = text.trim().match(/^(\/[a-zA-Z][\w-]*)/);
        if (slashMatch) {
            this.webviewView.webview.postMessage({
                type: 'skillActivation',
                skill: slashMatch[1],
            });

            // Hardcoded skills — handle in code, skip model entirely
            const handled = this.handleBuiltinSkill(slashMatch[1]);
            if (handled) { return; }
        }

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
            onUsage: (usage: TokenUsage) => {
                this.lastUsage = usage;
                this.sendTokenUsage(usage);
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
        const toolTagNames = 'read_file|write_file|patch_file|list_dir|search_files|delete_file|create_dir|rename_file|run_bash|mcp_call';
        const codeStripped = response
            .replace(/```[\s\S]*?```/g, (m) =>                       // fenced code blocks
                new RegExp(`<(?:${toolTagNames})\\b`).test(m) ? m : '')
            .replace(/`([^`\n]+)`/g, (_m, inner) =>                  // inline code spans
                new RegExp(`<(?:${toolTagNames})\\b`).test(inner) ? inner : '');

        // Unwrap native <tool_call> wrappers that local models sometimes produce
        // around our XML tags (e.g. <tool_call><read_file path="..."/></tool_call>).
        let stripped = codeStripped
            .replace(/<\|?tool_call\|?[^>]*>([\s\S]*?)<\|?\/?tool_call\|?>/g, '$1');

        // Translate native tool-call formats (Mistral-style, JSON-based, etc.)
        // into our XML tags so they get parsed and executed normally.
        stripped = translateNativeToolCalls(stripped);

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

        if (!hasToolTag) { return; }

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
                        didRead = true;
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
                        didRead = true;
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
                        didRead = true;
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
                    this.webviewView.webview.postMessage({
                        type: 'toolSearch', query: tool.query, glob: tool.glob, content: result,
                    });
                    didRead = true;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.conversationHistory.push({
                        role: 'user',
                        content: `[Tool result: search_files "${tool.query}"]\nError: ${msg}`,
                    });
                    this.saveHistory();
                    this.webviewView.webview.postMessage({
                        type: 'toolSearch', query: tool.query, glob: tool.glob, error: msg,
                    });
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
                            type: 'toolPendingBash', id, command: `delete ${tool.path}`,
                            toolOp: 'delete', autoApplied: true, success: true, output: 'File deleted.',
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
                            type: 'toolPendingBash', id, command: `delete ${tool.path}`,
                            toolOp: 'delete', autoApplied: true, success: false, output: msg,
                        });
                        didRead = true;
                    }
                } else {
                    this.pendingTools.set(id, { type: 'delete', path: tool.path });
                    this.webviewView.webview.postMessage({
                        type: 'toolPendingBash', id, command: `delete ${tool.path}`,
                        toolOp: 'delete',
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
                            type: 'toolPendingBash', id, command: `mkdir ${tool.path}`,
                            toolOp: 'mkdir', autoApplied: true, success: true, output: 'Directory created.',
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
                            type: 'toolPendingBash', id, command: `mkdir ${tool.path}`,
                            toolOp: 'mkdir', autoApplied: true, success: false, output: msg,
                        });
                        didRead = true;
                    }
                } else {
                    this.pendingTools.set(id, { type: 'mkdir', path: tool.path });
                    this.webviewView.webview.postMessage({
                        type: 'toolPendingBash', id, command: `mkdir ${tool.path}`,
                        toolOp: 'mkdir',
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
                            type: 'toolPendingBash', id, command: `rename ${tool.from} → ${tool.to}`,
                            toolOp: 'rename', autoApplied: true, success: true, output: 'File renamed.',
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
                            type: 'toolPendingBash', id, command: `rename ${tool.from} → ${tool.to}`,
                            toolOp: 'rename', autoApplied: true, success: false, output: msg,
                        });
                        didRead = true;
                    }
                } else {
                    this.pendingTools.set(id, { type: 'rename', from: tool.from, to: tool.to });
                    this.webviewView.webview.postMessage({
                        type: 'toolPendingBash', id, command: `rename ${tool.from} → ${tool.to}`,
                        toolOp: 'rename',
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
                continue;
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
        const config = vscode.workspace.getConfiguration('lmChat');
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
        const config = vscode.workspace.getConfiguration('lmChat');
        const messages: ChatMessage[] = [];
        if (this.systemPromptCache) {
            messages.push({ role: 'system', content: this.systemPromptCache });
        }
        messages.push(...this.prepareHistoryForModel(this.trimHistory(this.conversationHistory, config)));

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
            onUsage: (usage: TokenUsage) => {
                this.lastUsage = usage;
                this.sendTokenUsage(usage);
            },
        });
    }

    // ── Strip tool tags from assistant messages before sending to the model ──
    // Raw XML tags stay in conversationHistory (for export / card rendering),
    // but local models get confused when they see their own prior tool tags —
    // they treat them as completed work and stop.  Strip them so the model
    // only sees its reasoning text + the tool-result user messages.

    private prepareHistoryForModel(history: ChatMessage[]): ChatMessage[] {
        return history.map(m => {
            if (m.role !== 'assistant') { return m; }
            const cleaned = stripToolTagsForExport(m.content);
            if (!cleaned.trim()) {
                return { role: m.role, content: '[Executed tool calls]' };
            }
            return { role: m.role, content: cleaned };
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

// ── Native tool-call translator ──────────────────────────────────────────────
// Local models often produce tool calls in their native format instead of our
// XML tags. Rather than rejecting and retrying (which usually loops forever),
// we translate them into our XML format so parseToolCalls() handles the rest.

const KNOWN_TOOLS = new Set([
    'read_file', 'write_file', 'patch_file', 'list_dir', 'search_files',
    'delete_file', 'create_dir', 'rename_file', 'run_bash', 'mcp_call',
]);

function translateNativeToolCalls(text: string): string {
    let result = text;

    // ── Format 1: Mistral-style and bare tool names ────────────────────────
    // Matches:  call:read_file path="..." />
    //           <|tool_call>call:list_dir path="..." />
    //           read_file path="..."  (bare, after unwrap strips <tool_call> wrapper)
    //           read_file path="..." />
    //           read_file(path=".lm-chat/")
    // The KNOWN_TOOLS guard ensures we don't match random English words.
    const TOOL_NAMES_RE = [...KNOWN_TOOLS].join('|');
    const nativeCallRe = new RegExp(
        `(?:<\\|?tool_call\\|?[^>]*>\\s*)?(?:call:)?(${TOOL_NAMES_RE})\\b([^]*?)(?:\\/>|$)`, 'g'
    );
    let m: RegExpExecArray | null;
    while ((m = nativeCallRe.exec(result)) !== null) {
        const funcName = m[1];
        const attrStr = m[2].trim();
        // Skip if the match is inside a proper XML tag (handled by parseToolCalls)
        // e.g. <read_file path="..."/> — the char before the tool name is '<'
        const charBefore = m.index > 0 ? result[m.index - 1] : '';
        if (charBefore === '<') { continue; }
        const xmlTag = nativeAttrsToXml(funcName, attrStr);
        if (xmlTag) {
            result = result.slice(0, m.index) + xmlTag + result.slice(m.index + m[0].length);
            nativeCallRe.lastIndex = m.index + xmlTag.length;
        }
    }

    // ── Format 2: JSON inside <tool_call> tags ───────────────────────────────
    // e.g. <tool_call>{"name":"list_dir","arguments":{"path":".lm-chat/"}}</tool_call>
    const jsonToolCallRe = /<\|?tool_call\|?[^>]*>\s*(\{[\s\S]*?\})\s*<\|?\/?tool_call\|?>/g;
    while ((m = jsonToolCallRe.exec(result)) !== null) {
        const xmlTag = jsonCallToXml(m[1]);
        if (xmlTag) {
            result = result.slice(0, m.index) + xmlTag + result.slice(m.index + m[0].length);
            jsonToolCallRe.lastIndex = m.index + xmlTag.length;
        }
    }

    // ── Format 3: [TOOL_CALLS] [{"name":"...","arguments":{...}}] ────────────
    const toolCallsArrayRe = /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/g;
    while ((m = toolCallsArrayRe.exec(result)) !== null) {
        try {
            const arr = JSON.parse(m[1]);
            if (!Array.isArray(arr)) { continue; }
            const xmlTags = arr.map((item: any) => jsonCallToXml(JSON.stringify(item))).filter(Boolean).join('\n');
            if (xmlTags) {
                result = result.slice(0, m.index) + xmlTags + result.slice(m.index + m[0].length);
                toolCallsArrayRe.lastIndex = m.index + xmlTags.length;
            }
        } catch { continue; }
    }

    // ── Format 4: {"function_call":{"name":"...","arguments":{...}}} ─────────
    const funcCallRe = /\{\s*"function_call"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    while ((m = funcCallRe.exec(result)) !== null) {
        const xmlTag = jsonCallToXml(m[1]);
        if (xmlTag) {
            result = result.slice(0, m.index) + xmlTag + result.slice(m.index + m[0].length);
            funcCallRe.lastIndex = m.index + xmlTag.length;
        }
    }

    return result;
}

/** Convert JSON-style tool call to XML tag */
function jsonCallToXml(jsonStr: string): string | null {
    try {
        const obj = JSON.parse(jsonStr);
        const name = obj.name || obj.function;
        if (!name || !KNOWN_TOOLS.has(name)) { return null; }
        const args: Record<string, string> = obj.arguments || obj.params || obj.parameters || {};
        return buildXmlTag(name, args);
    } catch { return null; }
}

/** Convert key="value" attribute string to XML tag */
function nativeAttrsToXml(funcName: string, attrStr: string): string | null {
    const args: Record<string, string> = {};
    // Match key="value" or key='value' pairs
    const attrRe = /(\w+)\s*=\s*["']([^"']*)["']/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrStr)) !== null) {
        args[am[1]] = am[2];
    }
    return buildXmlTag(funcName, args);
}

/** Build the proper XML tag string for a given tool name and arguments */
function buildXmlTag(name: string, args: Record<string, string>): string | null {
    const p = args.path || args.file;
    switch (name) {
        case 'read_file':
            return p ? `<read_file path="${p}"/>` : null;
        case 'list_dir':
            return p ? `<list_dir path="${p}"/>` : null;
        case 'search_files': {
            const q = args.query;
            if (!q) { return null; }
            const g = args.glob ? ` glob="${args.glob}"` : '';
            return `<search_files query="${q}"${g}/>`;
        }
        case 'delete_file':
            return p ? `<delete_file path="${p}"/>` : null;
        case 'create_dir':
            return p ? `<create_dir path="${p}"/>` : null;
        case 'rename_file': {
            const from = args.from;
            const to = args.to;
            return from && to ? `<rename_file from="${from}" to="${to}"/>` : null;
        }
        case 'write_file': {
            const content = args.content || '';
            return p ? `<write_file path="${p}">${content}</write_file>` : null;
        }
        case 'run_bash': {
            const cmd = args.command || args.cmd || '';
            return cmd ? `<run_bash>${cmd}</run_bash>` : null;
        }
        case 'patch_file': {
            const search = args.search || '';
            const replace = args.replace || '';
            return p ? `<patch_file path="${p}"><search>${search}</search><replace>${replace}</replace></patch_file>` : null;
        }
        case 'mcp_call': {
            const server = args.server;
            const tool = args.tool;
            if (!server || !tool) { return null; }
            const mcpArgs = args.arguments || args.args || '{}';
            return `<mcp_call server="${server}" tool="${tool}">${mcpArgs}</mcp_call>`;
        }
        default:
            return null;
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

    // Helper: extract an attribute value — supports quoted ("val", 'val') and unquoted (val) forms
    function attr(tag: string, name: string): string | undefined {
        // Also accept common aliases: file= for path=
        const aliases = name === 'path' ? `(?:path|file)` : name;
        const qm = tag.match(new RegExp(`\\b${aliases}\\s*=\\s*["']([^"']+)["']`));
        if (qm) { return qm[1]; }
        // Unquoted: capture everything up to whitespace, >, or /> but allow / in paths
        const um = tag.match(new RegExp(`\\b${aliases}\\s*=\\s*([^\\s>"']+?)(?=\\s|\\/>|>|$)`));
        return um?.[1];
    }

    // read_file — lenient: accepts />, ></read_file>, or bare >
    const readRe = /<read_file\b[^>]*(?:path|file)\s*=[^>]*(?:\/>|>\s*(?:<\/read_file\s*>)?)/gi;
    while ((m = readRe.exec(text)) !== null) {
        const p = attr(m[0], 'path');
        if (p) { results.push({ type: 'read_file', path: p, pos: m.index }); }
    }

    // list_dir — lenient
    const listRe = /<list_dir\b[^>]*(?:path|file)\s*=[^>]*(?:\/>|>\s*(?:<\/list_dir\s*>)?)/gi;
    while ((m = listRe.exec(text)) !== null) {
        const p = attr(m[0], 'path');
        if (p) { results.push({ type: 'list_dir', path: p, pos: m.index }); }
    }

    // search_files — lenient
    const searchRe = /<search_files\b[^>]*query\s*=[^>]*(?:\/>|>\s*(?:<\/search_files\s*>)?)/gi;
    while ((m = searchRe.exec(text)) !== null) {
        const q = attr(m[0], 'query');
        if (q) { results.push({ type: 'search_files', query: q, glob: attr(m[0], 'glob'), pos: m.index }); }
    }

    // delete_file — lenient
    const deleteRe = /<delete_file\b[^>]*(?:path|file)\s*=[^>]*(?:\/>|>\s*(?:<\/delete_file\s*>)?)/gi;
    while ((m = deleteRe.exec(text)) !== null) {
        const p = attr(m[0], 'path');
        if (p) { results.push({ type: 'delete_file', path: p, pos: m.index }); }
    }

    // create_dir — lenient
    const mkdirRe = /<create_dir\b[^>]*(?:path|file)\s*=[^>]*(?:\/>|>\s*(?:<\/create_dir\s*>)?)/gi;
    while ((m = mkdirRe.exec(text)) !== null) {
        const p = attr(m[0], 'path');
        if (p) { results.push({ type: 'create_dir', path: p, pos: m.index }); }
    }

    // rename_file — lenient
    const renameRe = /<rename_file\b[^>]*from\s*=[^>]*to\s*=[^>]*(?:\/>|>\s*(?:<\/rename_file\s*>)?)/gi;
    while ((m = renameRe.exec(text)) !== null) {
        const f = attr(m[0], 'from');
        const t = attr(m[0], 'to');
        if (f && t) { results.push({ type: 'rename_file', from: f, to: t, pos: m.index }); }
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

// ── Strip tool XML from exported conversations ──────────────────────────────
// Prevents local models from seeing (and re-executing) stale tool tags when
// reading past conversation history files.

function stripToolTagsForExport(text: string): string {
    return text
        .replace(/<write_file\b[^>]*>[\s\S]*?<\/write_file>/g, '')
        .replace(/<patch_file\b[^>]*>[\s\S]*?<\/patch_file>/g, '')
        .replace(/<run_bash\b[^>]*>[\s\S]*?<\/run_bash>/g, '')
        .replace(/<read_file\b[^>]*(?:\/>|>\s*(?:<\/read_file\s*>)?)/gi, '')
        .replace(/<list_dir\b[^>]*(?:\/>|>\s*(?:<\/list_dir\s*>)?)/gi, '')
        .replace(/<search_files\b[^>]*(?:\/>|>\s*(?:<\/search_files\s*>)?)/gi, '')
        .replace(/<delete_file\b[^>]*(?:\/>|>\s*(?:<\/delete_file\s*>)?)/gi, '')
        .replace(/<create_dir\b[^>]*(?:\/>|>\s*(?:<\/create_dir\s*>)?)/gi, '')
        .replace(/<rename_file\b[^>]*(?:\/>|>\s*(?:<\/rename_file\s*>)?)/gi, '')
        .replace(/<mcp_call\b[^>]*>[\s\S]*?<\/mcp_call>/g, '')
        .replace(/<\|?tool_call\|?[^>]*>[\s\S]*?<\|?\/?tool_call\|?>/g, '')
        // Native formats: call:func_name ..., [TOOL_CALLS] [...], {"function_call":...}
        .replace(/(?:<\|?tool_call\|?[^>]*>\s*)?call:\w+\b[^]*?(?:\/>|$)/g, '')
        .replace(/\[TOOL_CALLS\]\s*\[[\s\S]*?\]/g, '')
        .replace(/\{\s*"function_call"\s*:\s*\{[\s\S]*?\}\s*\}/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ── patch_file diff helper ────────────────────────────────────────────────────

function diffSearchReplace(search: string, replace: string): import('./toolExecutor.js').DiffLine[] {
    const dels = search.split('\n').map(t => ({ type: 'del' as const, text: t }));
    const adds = replace.split('\n').map(t => ({ type: 'add' as const, text: t }));
    return [...dels, ...adds];
}
