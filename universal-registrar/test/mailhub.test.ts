import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { MailHubProvider } from "../src/core/email/mailhub.ts";
import { extractVerificationCode } from "../src/core/utils.ts";

test("MailHubProvider allocates inbox, polls verification code, reports and closes inbox", async () => {
  const events: Array<{ method?: string; url?: string; body: string }> = [];

  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer test-secret") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      events.push({ method: req.method, url: req.url, body });
      res.setHeader("Content-Type", "application/json");

      if (req.method === "POST" && req.url === "/api/inbox") {
        res.writeHead(201);
        res.end(
          JSON.stringify({
            id: "ibx-1",
            address: "bot@outlook.example",
            provider: "outlook",
          }),
        );
      } else if (req.method === "GET" && req.url === "/api/inbox/ibx-1/messages") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            messages: [
              {
                id: "m-1",
                from: "noreply@deepseek.com",
                subject: "Verify your account",
              },
            ],
          }),
        );
      } else if (req.method === "GET" && req.url === "/api/inbox/ibx-1/messages/m-1") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            id: "m-1",
            from: "noreply@deepseek.com",
            subject: "Verify your account",
            text: "Welcome to DeepSeek! Your verification code is 739204.",
          }),
        );
      } else if (req.method === "POST" && req.url === "/api/inbox/ibx-1/report") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, action: "stats_updated" }));
      } else if (req.method === "DELETE" && req.url === "/api/inbox/ibx-1") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as { port: number };
    const provider = new MailHubProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "test-secret",
      provider: "outlook",
    });

    const email = await provider.acquireAddress("deepseek");
    assert.equal(email, "bot@outlook.example");

    const msg = await provider.waitForMessage(
      email,
      (m) => !!extractVerificationCode(m.bodyText, 6),
      10_000,
    );
    const code = extractVerificationCode(msg.bodyText, 6);
    assert.equal(code, "739204");

    await provider.release(email);

    assert.equal(events.length, 5);
    assert.deepEqual(JSON.parse(events[0]!.body), {
      for: "deepseek.com",
      needPolling: true,
      provider: "outlook",
    });
    assert.deepEqual(JSON.parse(events[3]!.body), {
      success: true,
      service: "deepseek.com",
    });
    assert.equal(events[4]!.method, "DELETE");
  } finally {
    server.close();
  }
});
