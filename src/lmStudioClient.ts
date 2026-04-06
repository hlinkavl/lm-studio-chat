import * as vscode from 'vscode';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface StreamCallbacks {
    onChunk: (content: string) => void;
    onDone: () => void;
    onError: (error: string) => void;
}

export class LmStudioClient {
    private abortController: AbortController | null = null;

    private getConfig() {
        const config = vscode.workspace.getConfiguration('lmStudioChat');
        return {
            endpoint: config.get<string>('endpoint', 'http://127.0.0.1:1234'),
            model: config.get<string>('model', ''),
            maxTokens: config.get<number>('maxTokens', 2048),
            temperature: config.get<number>('temperature', 0.7),
        };
    }

    async checkHealth(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
        const { endpoint } = this.getConfig();
        try {
            const response = await fetch(`${endpoint}/v1/models`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
                return { ok: false, error: `Server returned ${response.status}` };
            }

            const data = await response.json() as { data?: Array<{ id: string }> };
            const models = (data.data || []).map((m: { id: string }) => m.id);
            return { ok: true, models };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `Cannot reach LM Studio at ${endpoint}: ${message}` };
        }
    }

    async fetchModels(): Promise<string[]> {
        const { endpoint } = this.getConfig();
        try {
            const response = await fetch(`${endpoint}/v1/models`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) return [];
            const data = await response.json() as { data?: Array<{ id: string }> };
            return (data.data || []).map((m: { id: string }) => m.id);
        } catch {
            return [];
        }
    }

    async streamChat(messages: ChatMessage[], callbacks: StreamCallbacks): Promise<void> {
        const { endpoint, model, maxTokens, temperature } = this.getConfig();

        // Cancel any ongoing request
        this.abort();
        this.abortController = new AbortController();

        const body: Record<string, unknown> = {
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
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;

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
                    } catch {
                        // Skip non-JSON lines
                    }
                }
            }

            callbacks.onDone();
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                callbacks.onDone();
                return;
            }
            const message = err instanceof Error ? err.message : String(err);
            callbacks.onError(`Request failed: ${message}`);
        }
    }

    abort(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }
}
