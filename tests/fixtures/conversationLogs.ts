// Synthetic data only. Never copy production request bodies or management keys here.
export const makeLog = (
  body: object,
  output: object | object[],
  headers = 'Thread-Id: thread-demo',
  sse = true
) => {
  const response = sse
    ? (Array.isArray(output) ? output : [{ type: 'response.completed', response: output }])
        .map(
          (event) =>
            `event: ${'type' in event ? event.type : 'response.completed'}\ndata: ${JSON.stringify(event)}\n\n`
        )
        .join('')
    : JSON.stringify(output);
  return `=== REQUEST INFO ===\nVersion: test\nURL: /v1/responses\nMethod: POST\nTimestamp: 2026-10-29T19:51:24.000\n\n=== HEADERS ===\nOriginator: T3 Code\n${headers}\nAuthorization: Bearer redacted\n\n=== REQUEST BODY ===\n${JSON.stringify(body)}\n\n=== RESPONSE ===\nStatus: 200\nContent-Type: ${sse ? 'text/event-stream' : 'application/json'}\n\n${response}`;
};

const user = {
  type: 'message',
  role: 'user',
  id: 'user-1',
  content: [
    {
      type: 'input_text',
      text: 'Add a health endpoint to the monitor server and check that it works.',
    },
  ],
};
const context = {
  role: 'developer',
  content: 'Synthetic system context for the conversation viewer.',
};
const commentary = {
  type: 'message',
  role: 'assistant',
  id: 'comment-1',
  phase: 'commentary',
  content: [
    {
      type: 'output_text',
      text: 'I’ll check the server routes, add the endpoint, and run the tests.',
    },
  ],
};
const tool = {
  type: 'function_call',
  id: 'tool-1',
  call_id: 'call-1',
  namespace: 'functions',
  name: 'exec',
  arguments: '{"cmd":"bun test tests/health.test.ts"}',
};
const result = {
  type: 'function_call_output',
  call_id: 'call-1',
  output: '3 pass\n0 fail\nRan 3 tests in 48ms.',
};
const answer = {
  type: 'message',
  role: 'assistant',
  id: 'answer-1',
  phase: 'final_answer',
  content: [
    {
      type: 'output_text',
      text: 'Added **`GET /health`** and verified the response.\n\n```json\n{ "status": "ok", "service": "monitor-server" }\n```\n\n- Returns HTTP `200` when the server is healthy.\n- Runs without authentication for your load balancer.\n- All three health checks pass.',
    },
  ],
};
const followup = {
  type: 'message',
  role: 'user',
  id: 'user-2',
  content: [{ type: 'input_text', text: 'Great, can you also add it to the README?' }],
};

export const demoLogs: Record<string, string> = {
  aaaa0001: makeLog(
    { model: 'gpt-6.1-sol', input: [context, user] },
    {
      id: 'resp-1',
      output: [
        commentary,
        {
          type: 'reasoning',
          id: 'reason-1',
          summary: [{ text: 'Check the route before making a small, targeted change.' }],
        },
        tool,
      ],
      usage: { input_tokens: 1280, output_tokens: 120 },
    }
  ),
  aaaa0002: makeLog(
    { model: 'gpt-6.1-sol', input: [context, user, commentary, tool, result] },
    { id: 'resp-2', output: [answer], usage: { input_tokens: 1520, output_tokens: 180 } }
  ),
  aaaa0003: makeLog(
    { model: 'gpt-6.1-sol', input: [context, user, commentary, tool, result, answer, followup] },
    {
      id: 'resp-3',
      output: [
        {
          type: 'message',
          role: 'assistant',
          id: 'answer-2',
          content: [
            {
              type: 'output_text',
              text: 'Updated the README with the endpoint, its response format, and an example:\n\n```sh\ncurl http://localhost:3000/health\n```\n\nThe documentation now matches the tested behavior.',
            },
          ],
        },
      ],
    }
  ),
  bbbb0001: makeLog(
    { model: 'gpt-6-luna', input: 'Help me understand this project’s deployment setup.' },
    {
      id: 'resp-4',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'The project runs as a systemd service behind a private Tailscale endpoint. The service starts at boot and automatically restarts if it exits.',
            },
          ],
        },
      ],
    },
    'Thread-Id: thread-deployment\nUser-Agent: Codex/1.0'
  ),
};

export const demoLogLines = Object.keys(demoLogs).map(
  (id, i) =>
    `[2026-10-29 19:5${i}:24] [${id}] [info ] [gin_logger.go:113] 200 | 2.4s | 127.0.0.1 | POST "/v1/responses"`
);
