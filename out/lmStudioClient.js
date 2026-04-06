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
exports.LmStudioClient = void 0;
const vscode = __importStar(require("vscode"));
class LmStudioClient {
    constructor() {
        this.abortController = null;
    }
    getConfig() {
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        return {
            endpoint: config.get('endpoint', 'http://127.0.0.1:1234'),
            model: config.get('model', ''),
            maxTokens: config.get('maxTokens', 2048),
            temperature: config.get('temperature', 0.7),
        };
    }
    async checkHealth() {
        const { endpoint } = this.getConfig();
        try {
            const response = await fetch(`${endpoint}/v1/models`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) {
                return { ok: false, error: `Server returned ${response.status}` };
            }
            const data = await response.json();
            const models = (data.data || []).map((m) => m.id);
            return { ok: true, models };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `Cannot reach LM Studio at ${endpoint}: ${message}` };
        }
    }
    async fetchModels() {
        const { endpoint } = this.getConfig();
        try {
            const response = await fetch(`${endpoint}/v1/models`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000),
            });
            if (!response.ok)
                return [];
            const data = await response.json();
            return (data.data || []).map((m) => m.id);
        }
        catch {
            return [];
        }
    }
    async streamChat(messages, callbacks) {
        const { endpoint, model, maxTokens, temperature } = this.getConfig();
        // Cancel any ongoing request
        this.abort();
        this.abortController = new AbortController();
        const body = {
            messages,
            stream: true,
            max_tokens: maxTokens,
            temperature,
        };
        // Only include model if explicitly set
        if (model) {
            body.model = model;
        }
        try {
            const response = await fetch(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: this.abortController.signal,
            });
            if (!response.ok) {
                const text = await response.text();
                callbacks.onError(`LM Studio error (${response.status}): ${text}`);
                return;
            }
            if (!response.body) {
                callbacks.onError('No response body received');
                return;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    // Flush any remaining bytes buffered by the decoder
                    buffer += decoder.decode();
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                // Keep the last potentially incomplete line in buffer
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: '))
                        continue;
                    const data = trimmed.slice(6); // Remove "data: " prefix
                    if (data === '[DONE]') {
                        callbacks.onDone();
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.delta?.content;
                        if (content) {
                            callbacks.onChunk(content);
                        }
                    }
                    catch {
                        // Skip non-JSON lines
                    }
                }
            }
            callbacks.onDone();
        }
        catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                callbacks.onDone();
                return;
            }
            const message = err instanceof Error ? err.message : String(err);
            callbacks.onError(`Request failed: ${message}`);
        }
    }
    abort() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }
}
exports.LmStudioClient = LmStudioClient;
//# sourceMappingURL=lmStudioClient.js.map